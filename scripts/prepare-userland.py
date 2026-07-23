#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
from typing import Any

MARKER = b"#!thistle:"
THX_MAGICS = (b"THX1", b"THX2")
SCHEMA = 1


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"ERROR: {message}")


def guest_path(relative: Path) -> str:
    return "/" + PurePosixPath(relative.as_posix()).as_posix().lstrip("/")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_tree(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2)


def wrapper_mode(path: Path) -> int:
    return stat.S_IMODE(path.stat(follow_symlinks=False).st_mode)


def rewrite_marker(path: Path, original: bytes) -> dict[str, Any]:
    first = original.splitlines()[0].decode("utf-8", "strict")
    command = first[len("#!thistle:"):]
    if not command or any(character in command for character in "/\0\r\n"):
        fail(f"invalid mikuOS command marker in {path}")
    mode = wrapper_mode(path)
    path.write_text(
        "#!/sbin/nemunemu --marker\n" + first + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.chmod(path, mode)
    return {"kind": "marker", "command": command}


def rewrite_thx(root: Path, path: Path, original: bytes) -> dict[str, Any]:
    relative = path.relative_to(root)
    stored = root / "usr/libexec/nemunemu/thx" / relative
    stored.parent.mkdir(parents=True, exist_ok=True)
    mode = wrapper_mode(path)
    stored.write_bytes(original)
    os.chmod(stored, mode)
    logical = guest_path(relative)
    stored_guest = guest_path(stored.relative_to(root))
    path.write_text(
        "#!/sbin/nemunemu --thx-wrapper\n"
        f"#!nemunemu-thx:{stored_guest}\n",
        encoding="utf-8",
        newline="\n",
    )
    os.chmod(path, mode)
    return {
        "kind": "thx",
        "logicalPath": logical,
        "storedPath": stored_guest,
        "sha256": hashlib.sha256(original).hexdigest(),
    }


def stage(source: Path, destination: Path) -> dict[str, Any]:
    source = source.resolve()
    destination = destination.resolve()
    if not source.is_dir():
        fail(f"mikuOS userland root is not a directory: {source}")
    if source == destination or source in destination.parents:
        fail("destination must not be inside the source tree")
    if not (source / "bin/thsh").is_file() or not (source / ".thistle-meta.json").is_file():
        fail(f"not a mikuOS userland root: {source}")

    copy_tree(source, destination)
    transformations: list[dict[str, Any]] = []

    for path in sorted(destination.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        mode = wrapper_mode(path)
        if not mode & 0o111:
            continue
        original = path.read_bytes()
        relative = guest_path(path.relative_to(destination))
        if original.startswith(MARKER):
            detail = rewrite_marker(path, original)
            transformations.append({"path": relative, **detail})
        elif original.startswith(THX_MAGICS):
            detail = rewrite_thx(destination, path, original)
            transformations.append({"path": relative, **detail})

    manifest = {
        "schema": SCHEMA,
        "source": str(source),
        "sourceMetadataSha256": sha256(source / ".thistle-meta.json"),
        "transformations": transformations,
    }
    manifest_path = destination / "usr/share/nemunemu/image-manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Stage an unchanged mikuOS userland contract for NERU/Linux."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    manifest = stage(args.source, args.destination)
    print(
        f"NERU userland: {args.destination} "
        f"({len(manifest['transformations'])} executable contracts prepared)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
