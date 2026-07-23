from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


class PrepareUserlandTests(unittest.TestCase):
    def test_stages_markers_and_thx_without_changing_source(self) -> None:
        with tempfile.TemporaryDirectory(prefix="neru-userland-") as temporary:
            root = Path(temporary)
            source = root / "source"
            output = root / "output"
            (source / "bin").mkdir(parents=True)
            (source / ".thistle-meta.json").write_text(
                '{"schema":1}\n', encoding="utf-8"
            )

            thsh = source / "bin/thsh"
            thsh.write_text("#!thistle:thsh\n", encoding="utf-8")
            thsh.chmod(0o755)

            programme = source / "bin/demo"
            original_thx = b"THX2" + bytes(range(32))
            programme.write_bytes(original_thx)
            programme.chmod(0o755)

            script = Path(__file__).resolve().parents[1] / "scripts/prepare-userland.py"
            subprocess.run(
                [sys.executable, str(script), str(source), str(output)],
                check=True,
            )

            self.assertEqual(thsh.read_text(encoding="utf-8"), "#!thistle:thsh\n")
            self.assertEqual(programme.read_bytes(), original_thx)

            staged_thsh = output / "bin/thsh"
            self.assertEqual(
                staged_thsh.read_text(encoding="utf-8"),
                "#!/sbin/nemunemu --marker\n#!thistle:thsh\n",
            )
            self.assertTrue(stat.S_IMODE(staged_thsh.stat().st_mode) & 0o111)

            staged_programme = output / "bin/demo"
            self.assertEqual(
                staged_programme.read_text(encoding="utf-8"),
                "#!/sbin/nemunemu --thx-wrapper\n"
                "#!nemunemu-thx:/usr/libexec/nemunemu/thx/bin/demo\n",
            )
            stored_programme = output / "usr/libexec/nemunemu/thx/bin/demo"
            self.assertEqual(stored_programme.read_bytes(), original_thx)

            manifest = json.loads(
                (output / "usr/share/nemunemu/image-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            kinds = {entry["path"]: entry["kind"] for entry in manifest["transformations"]}
            self.assertEqual(kinds["/bin/thsh"], "marker")
            self.assertEqual(kinds["/bin/demo"], "thx")


if __name__ == "__main__":
    unittest.main()
