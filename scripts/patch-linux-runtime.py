#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) != 1:
        raise SystemExit(f"ERROR: expected exactly one {label} insertion point, found {text.count(old)}")
    return text.replace(old, new, 1)


def patch_main(source: str) -> str:
    source = replace_once(
        source,
        "const linux = async (worker_url, variant, vmlinux, boot_cmdline, initrd, log, console_write) => {",
        "const linux = async (worker_url, variant, vmlinux, boot_cmdline, initrd, log, console_write, fs_bridge) => {",
        "linux() signature",
    )
    marker = '''    console_write: (message) => {
      console_write(message.message);
    },

    log: (message) => {'''
    replacement = '''    console_write: (message) => {
      console_write(message.message);
    },

    neru_fs_call: (message) => {
      const messenger = message.messenger;
      const complete = (result) => {
        const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
        if (message.output_size > 0) {
          new Uint8Array(memory.buffer).set(bytes.slice(0, message.output_size), message.output);
        }
        Atomics.store(messenger, 0, bytes.length);
        Atomics.notify(messenger, 0, 1);
      };
      const fail = (error) => {
        log("NERU filesystem bridge failed: " + (error && error.message ? error.message : String(error)));
        Atomics.store(messenger, 0, -5);
        Atomics.notify(messenger, 0, 1);
      };
      if (!fs_bridge) {
        fail(new Error("authoritative filesystem bridge is unavailable"));
      } else {
        Promise.resolve(fs_bridge(new Uint8Array(message.request))).then(complete, fail);
      }
    },

    log: (message) => {'''
    return replace_once(source, marker, replacement, "main-thread filesystem bridge")


def patch_worker(source: str) -> str:
    marker = '''  /// An exception type used to abort part of execution (useful for collapsing the call stack of user code).
  class Trap extends Error {'''
    replacement = '''  /// Synchronises Linux userspace filesystem calls with the asynchronous host authority.
  const neru_fs_messenger = new Int32Array(new SharedArrayBuffer(4));

  const neru_fs_call = (input, input_size, output, output_size) => {
    input = Number(input);
    input_size = Number(input_size);
    output = Number(output);
    output_size = Number(output_size);
    Atomics.store(neru_fs_messenger, 0, -2147483648);
    const request = new Uint8Array(memory.buffer).slice(input, input + input_size);
    port.postMessage({
      method: "neru_fs_call",
      request,
      output,
      output_size,
      messenger: neru_fs_messenger,
    });
    Atomics.wait(neru_fs_messenger, 0, -2147483648);
    return Atomics.load(neru_fs_messenger, 0);
  };

  /// An exception type used to abort part of execution (useful for collapsing the call stack of user code).
  class Trap extends Error {'''
    source = replace_once(source, marker, replacement, "worker filesystem messenger")
    marker = '''            __wasm_syscall_6: vmlinux_instance.exports.wasm_syscall_6,

            __wasm_abort: () => {'''
    replacement = '''            __wasm_syscall_6: vmlinux_instance.exports.wasm_syscall_6,
            __neru_fs_call: neru_fs_call,

            __wasm_abort: () => {'''
    return replace_once(source, marker, replacement, "Linux userspace filesystem import")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--linux", required=True, type=Path)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "linux.js").write_text(patch_main(args.linux.read_text(encoding="utf-8")), encoding="utf-8")
    (args.output / "linux-worker.js").write_text(patch_worker(args.worker.read_text(encoding="utf-8")), encoding="utf-8")


if __name__ == "__main__":
    main()
