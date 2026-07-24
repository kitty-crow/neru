#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import shutil


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install NERU's built-in mikuosfs driver into Linux-WASM sources."
    )
    parser.add_argument("--kernel", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    args = parser.parse_args()

    kernel = args.kernel.resolve()
    source = args.source.resolve()
    makefile = kernel / "arch" / "wasm" / "kernel" / "Makefile"
    destination = kernel / "arch" / "wasm" / "kernel" / "mikuosfs.c"

    if not makefile.is_file():
        raise SystemExit(f"ERROR: Not a Linux-WASM source tree: {kernel}")
    if not source.is_file():
        raise SystemExit(f"ERROR: Missing mikuosfs source: {source}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)

    text = makefile.read_text(encoding="utf-8")
    line = "obj-y += mikuosfs.o"
    if line not in text.splitlines():
        anchor = "obj-y += irq.o\n"
        if anchor not in text:
            raise SystemExit(f"ERROR: Could not locate Makefile insertion point: {makefile}")
        text = text.replace(anchor, anchor + line + "\n", 1)
        makefile.write_text(text, encoding="utf-8")

    print(f"NERU: installed built-in mikuosfs driver: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
