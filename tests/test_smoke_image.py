from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "make-rv64-smoke.py"
SPEC = importlib.util.spec_from_file_location("neru_make_rv64_smoke", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SmokeImageTests(unittest.TestCase):
    def test_image_is_deterministic_and_valid(self) -> None:
        first = MODULE.build()
        second = MODULE.build()
        self.assertEqual(first, second)
        self.assertEqual(first[:4], b"THX2")

        header_size, payload_size, checksum = struct.unpack_from("<III", first, 4)
        self.assertEqual(16 + header_size + payload_size, len(first))
        protected = first[16:]
        self.assertEqual(checksum, MODULE.fnv1a(protected))

        metadata = json.loads(first[16 : 16 + header_size].decode("utf-8"))
        self.assertEqual(metadata["machine"], "thistle64")
        self.assertEqual(metadata["ver"], 2)
        self.assertEqual(metadata["isa"], "rv64gc")
        self.assertEqual(metadata["entry"], MODULE.TEXT_ADDRESS)
        self.assertEqual(metadata["mem"], MODULE.MEMORY_SIZE)
        self.assertEqual(metadata["sec"][0]["addr"], MODULE.TEXT_ADDRESS)
        self.assertEqual(metadata["sec"][1]["addr"], MODULE.DATA_ADDRESS)

        payload = first[16 + header_size :]
        self.assertTrue(payload.endswith(MODULE.MESSAGE))
        self.assertEqual(payload_size, len(payload))


if __name__ == "__main__":
    unittest.main()
