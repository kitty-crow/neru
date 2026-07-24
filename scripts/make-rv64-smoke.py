#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import struct

MAGIC = b"THX2"
TEXT_ADDRESS = 0x10000
DATA_ADDRESS = 0x20000
MEMORY_SIZE = 64 * 1024 * 1024
MESSAGE = b"NERU_RV64_OK\n"


def fnv1a(data: bytes) -> int:
    value = 0x811C9DC5
    for byte in data:
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return value


def instruction_i(immediate: int, rs1: int, funct3: int, rd: int, opcode: int) -> int:
    return (
        ((immediate & 0xFFF) << 20)
        | ((rs1 & 0x1F) << 15)
        | ((funct3 & 0x7) << 12)
        | ((rd & 0x1F) << 7)
        | (opcode & 0x7F)
    )


def instruction_u(immediate: int, rd: int, opcode: int) -> int:
    return (immediate & 0xFFFFF000) | ((rd & 0x1F) << 7) | (opcode & 0x7F)


def build() -> bytes:
    instructions = (
        instruction_i(1, 0, 0, 10, 0x13),
        instruction_u(DATA_ADDRESS, 11, 0x37),
        instruction_i(len(MESSAGE), 0, 0, 12, 0x13),
        instruction_i(64, 0, 0, 17, 0x13),
        0x00000073,
        instruction_i(0, 0, 0, 10, 0x13),
        instruction_i(93, 0, 0, 17, 0x13),
        0x00000073,
    )
    text = b"".join(struct.pack("<I", instruction) for instruction in instructions)
    metadata = {
        "machine": "thistle64",
        "ver": 2,
        "sec": [
            {
                "name": ".text",
                "flg": "rx",
                "align": 4096,
                "size": len(text),
                "addr": TEXT_ADDRESS,
                "at": 0,
                "len": len(text),
            },
            {
                "name": ".rodata",
                "flg": "r",
                "align": 4096,
                "size": len(MESSAGE),
                "addr": DATA_ADDRESS,
                "at": len(text),
                "len": len(MESSAGE),
            },
        ],
        "sym": [],
        "rel": [],
        "dbg": [],
        "ident": ["NERU Linux-WASM RV64 compatibility smoke test"],
        "entry": TEXT_ADDRESS,
        "mem": MEMORY_SIZE,
        "isa": "rv64gc",
    }
    header = json.dumps(metadata, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload = text + MESSAGE
    protected = header + payload
    return MAGIC + struct.pack("<III", len(header), len(payload), fnv1a(protected)) + protected


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the deterministic NERU RV64 smoke THX image.")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(build())
    args.output.chmod(0o755)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
