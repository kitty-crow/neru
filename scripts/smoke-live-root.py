#!/usr/bin/env python3
"""Interactive regression test for the bootable NERU live-root milestone."""

from __future__ import annotations

import argparse
import errno
import os
import pty
import re
import select
import shutil
import signal
import sys
import time
from pathlib import Path


PROMPT = b"root@mikuos:/# "


def read_until(
    fd: int,
    needle: bytes,
    timeout: float,
    description: str,
) -> bytes:
    deadline = time.monotonic() + timeout
    collected = bytearray()
    search_window = bytearray()

    while needle not in search_window:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"Timed out waiting for {description}: {needle!r}"
            )

        readable, _, _ = select.select([fd], [], [], min(remaining, 0.25))
        if not readable:
            continue

        try:
            chunk = os.read(fd, 4096)
        except OSError as exc:
            if exc.errno == errno.EIO:
                raise RuntimeError(
                    f"NERU closed the terminal while waiting for {description}"
                ) from exc
            raise

        if not chunk:
            raise RuntimeError(
                f"NERU reached EOF while waiting for {description}"
            )

        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()

        collected.extend(chunk)
        search_window.extend(chunk)

        if len(search_window) > 131_072:
            del search_window[:-65_536]

    return bytes(collected)


def exact_lines(output: bytes) -> set[str]:
    normalised = output.replace(b"\r\n", b"\n").replace(b"\r", b"\n")

    # Commands run through a PTY, so tools such as ls may emit colour and
    # cursor-control sequences even though the pasted terminal output looks
    # like plain text.
    normalised = re.sub(
        rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))",
        b"",
        normalised,
    )

    return {
        line.decode("utf-8", errors="replace").strip()
        for line in normalised.split(b"\n")
    }


def run_check(
    fd: int,
    command: str,
    success_line: str,
    tag: str,
    timeout: float,
) -> None:
    marker = f"__NERU_{tag}_DONE__"
    complete_command = (
        f"{command}; "
        f"neru_status=$?; "
        f"echo {marker}:$neru_status"
    )

    os.write(fd, complete_command.encode("utf-8") + b"\n")
    output = read_until(
        fd,
        PROMPT,
        timeout,
        f"the prompt after {tag}",
    )

    lines = exact_lines(output)

    if success_line not in lines:
        raise AssertionError(
            f"{tag} did not emit its success marker: {success_line}"
        )

    status_line = f"{marker}:0"
    if status_line not in lines:
        observed = sorted(
            line for line in lines if line.startswith(f"{marker}:")
        )
        raise AssertionError(
            f"{tag} returned a non-zero or missing status; observed {observed}"
        )


def wait_for_process_exit(
    pid: int,
    fd: int,
    timeout: float,
) -> tuple[int, bytes]:
    deadline = time.monotonic() + timeout
    collected = bytearray()
    raw_status: int | None = None
    terminal_closed = False

    while raw_status is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Timed out waiting for Neru to exit")

        if not terminal_closed:
            readable, _, _ = select.select(
                [fd],
                [],
                [],
                min(remaining, 0.1),
            )

            if readable:
                try:
                    chunk = os.read(fd, 4096)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        terminal_closed = True
                    else:
                        raise
                else:
                    if chunk:
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                        collected.extend(chunk)
                    else:
                        terminal_closed = True

        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError as exc:
            raise RuntimeError(
                "Neru process was reaped unexpectedly"
            ) from exc

        if waited == pid:
            raw_status = status

    while not terminal_closed:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if not readable:
            break

        try:
            chunk = os.read(fd, 4096)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise

        if not chunk:
            break

        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        collected.extend(chunk)

    return os.waitstatus_to_exitcode(raw_status), bytes(collected)


def terminate_process_group(pid: int) -> None:
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return

    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        try:
            waited, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if waited == pid:
            return
        time.sleep(0.05)

    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass

    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mikuos-root", type=Path)
    parser.add_argument("--artifact-root", type=Path)
    parser.add_argument("--boot-timeout", type=float, default=180.0)
    parser.add_argument("--command-timeout", type=float, default=20.0)
    parser.add_argument("--exit-timeout", type=float, default=20.0)
    args = parser.parse_args()

    neru_root = Path(__file__).resolve().parent.parent
    mikuos_root = (
        args.mikuos_root.resolve()
        if args.mikuos_root
        else neru_root.parent / ".thistle"
    )
    artifact_root = (
        args.artifact_root.resolve()
        if args.artifact_root
        else neru_root / "dist" / "neru-runtime-wasm32_nommu"
    )

    bun = shutil.which("bun")
    if bun is None:
        raise RuntimeError("bun is not installed or is not on PATH")

    required = (
        artifact_root / "vmlinux.wasm",
        artifact_root / "linux.js",
        artifact_root / "linux-worker.js",
        artifact_root / "manifest.json",
        mikuos_root / "sbin" / "nemunemu",
        mikuos_root / "usr" / "libexec" / "nemunemu" / "busybox",
    )
    for path in required:
        if not path.exists():
            raise FileNotFoundError(f"Required regression artefact is missing: {path}")

    command = [
        bun,
        "neru.ts",
        "--artifact-root",
        str(artifact_root),
        "--fs-root",
        str(mikuos_root),
        "--boot",
        "--skip-build",
    ]

    print("===== NERU live-root regression command =====", flush=True)
    print(" ".join(command), flush=True)
    print(f"Live root: {mikuos_root}", flush=True)
    print(f"Artefacts: {artifact_root}", flush=True)
    print("", flush=True)

    pid, fd = pty.fork()

    if pid == 0:
        os.chdir(neru_root)
        os.execvpe(bun, command, os.environ.copy())
        raise AssertionError("execvpe unexpectedly returned")

    passed = False
    process_reaped = False
    try:
        read_until(
            fd,
            PROMPT,
            args.boot_timeout,
            "the first mikuOS prompt",
        )

        run_check(
            fd,
            'test "$$" -ne 1 && echo NERU_SHELL_CHILD_OK',
            "NERU_SHELL_CHILD_OK",
            "SHELL_CHILD",
            args.command_timeout,
        )
        run_check(
            fd,
            "uname",
            "Linux",
            "UNAME",
            args.command_timeout,
        )
        run_check(
            fd,
            "hostname",
            "mikuos",
            "HOSTNAME",
            args.command_timeout,
        )
        run_check(
            fd,
            "pwd",
            "/",
            "PWD",
            args.command_timeout,
        )
        run_check(
            fd,
            "ls -1 /",
            "bin",
            "LS_ROOT",
            args.command_timeout,
        )
        run_check(
            fd,
            (
                'neru_root_ok=0; '
                'for neru_path in bin etc home opt root run sbin sys tmp usr var; do '
                'test -e "/$neru_path" || neru_root_ok=1; '
                'done; '
                'test "$neru_root_ok" -eq 0 && echo NERU_ROOT_LAYOUT_OK'
            ),
            "NERU_ROOT_LAYOUT_OK",
            "ROOT_LAYOUT",
            args.command_timeout,
        )

        os.write(fd, b"exit\n")
        exit_status, shutdown_output = wait_for_process_exit(
            pid,
            fd,
            args.exit_timeout,
        )
        process_reaped = True

        if exit_status != 0:
            raise AssertionError(
                f"Neru returned status {exit_status} after a normal shell exit"
            )

        shutdown_text = shutdown_output.decode(
            "utf-8",
            errors="replace",
        )

        if "restarting" in shutdown_text:
            raise AssertionError(
                "NEMUNEMU restarted the shell after a normal exit"
            )

        expected_shutdown = (
            "neru: mikuOS exited with status 0; stopping Linux"
        )
        if expected_shutdown not in shutdown_text:
            raise AssertionError(
                "Neru did not report an orderly Linux shutdown"
            )

        passed = True
    finally:
        if not process_reaped:
            terminate_process_group(pid)
        try:
            os.close(fd)
        except OSError:
            pass

    if not passed:
        return 1

    print("")
    print("NERU_GRACEFUL_EXIT_OK")
    print("NERU_LIVE_ROOT_SMOKE_OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"\nNERU_LIVE_ROOT_SMOKE_FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
