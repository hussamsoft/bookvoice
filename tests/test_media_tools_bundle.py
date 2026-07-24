from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent


def load_stage_module():
    spec = importlib.util.spec_from_file_location("stage_media_tools", ROOT / "scripts" / "stage_media_tools.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class MediaToolsBundleTests(unittest.TestCase):
    def test_stages_pinned_tools_notices_and_manifest_contracts(self):
        module = load_stage_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            root = base / "root"
            dist = base / "dist"
            source = base / "source"
            (root / "third_party").mkdir(parents=True)
            dist.mkdir()
            source.mkdir()
            (root / "third_party" / "FFmpeg-NOTICE.txt").write_text("notice", encoding="utf-8")
            (source / "LICENSE").write_text("license", encoding="utf-8")
            tools = {}
            for name in module.TOOL_NAMES:
                path = source / name
                path.write_bytes(name.encode("ascii"))
                tools[name] = path
            for name in ("runtime-manifest.json", "release-manifest.json"):
                (dist / name).write_text('{"schema_version": 1}\n', encoding="utf-8")

            with patch.object(module, "media_tools_source", return_value=tools), patch.object(
                module, "_tool_version", return_value=module.PINNED_VERSION
            ):
                contract = module.stage_media_tools(root, dist)

            self.assertEqual(contract["version"], "8.1.1")
            self.assertTrue((dist / "tools" / "ffmpeg" / "ffmpeg.exe").is_file())
            self.assertEqual((dist / "tools" / "ffmpeg" / "LICENSE.txt").read_text(), "license")
            runtime = json.loads((dist / "runtime-manifest.json").read_text())
            release = json.loads((dist / "release-manifest.json").read_text())
            self.assertEqual(runtime["media_tools"], contract)
            self.assertEqual(release["media_tools"], contract)

    def test_tool_version_rejects_a_different_release(self):
        module = load_stage_module()
        completed = type("Completed", (), {"returncode": 0, "stdout": "ffmpeg version 7.0 full\n", "stderr": ""})()
        with patch.object(module.subprocess, "run", return_value=completed):
            with self.assertRaises(SystemExit):
                module._tool_version(Path("ffmpeg.exe"), "ffmpeg")


if __name__ == "__main__":
    unittest.main()
