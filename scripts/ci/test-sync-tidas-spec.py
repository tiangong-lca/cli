#!/usr/bin/env python3
"""Tests for the explicit tidas-spec -> CLI asset synchronizer."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("sync-tidas-spec.py")
SPEC = importlib.util.spec_from_file_location("sync_tidas_spec", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SyncTidasSpecTest(unittest.TestCase):
    def make_source(self, root: Path) -> tuple[Path, str]:
        spec = root / "spec"
        schema_dir = spec / "assets/tidas/schemas"
        schema_dir.mkdir(parents=True)
        content = b'{"type":"object","required":["canonical"]}\n'
        schema_path = schema_dir / "sample.json"
        schema_path.write_bytes(content)
        manifest = {
            "manifestVersion": 1,
            "package": {"name": "@tiangong-lca/tidas-spec", "version": "0.1.0"},
            "specVersion": "0.1.0",
            "source": {
                "repository": "https://github.com/tiangong-lca/tidas-toolkit",
                "commit": "9" * 40,
            },
            "counts": {"schemasPerLanguage": 1},
            "files": [
                {
                    "path": "assets/tidas/schemas/sample.json",
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            ],
        }
        (spec / "spec-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return spec, "a" * 40

    def test_write_then_check_binds_manifest_and_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec, commit = self.make_source(root)
            cli = root / "cli"
            schemas, metadata = MODULE.load_source(spec, commit)
            self.assertEqual(MODULE.compare_or_write(cli, schemas, metadata, True), [])
            self.assertEqual(MODULE.compare_or_write(cli, schemas, metadata, False), [])
            identity = json.loads((cli / MODULE.SOURCE_METADATA).read_text(encoding="utf-8"))
            self.assertEqual(identity["spec_commit"], commit)
            self.assertEqual((cli / MODULE.SCHEMA_ROOT / "sample.json").read_bytes(), schemas["sample.json"])

    def test_check_rejects_tampered_asset_and_extra_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec, commit = self.make_source(root)
            cli = root / "cli"
            schemas, metadata = MODULE.load_source(spec, commit)
            MODULE.compare_or_write(cli, schemas, metadata, True)
            (cli / MODULE.SCHEMA_ROOT / "sample.json").write_text("tampered", encoding="utf-8")
            (cli / MODULE.SCHEMA_ROOT / "extra.json").write_text("{}", encoding="utf-8")
            errors = MODULE.compare_or_write(cli, schemas, metadata, False)
            self.assertTrue(any("differs" in error for error in errors))
            self.assertTrue(any("unexpected" in error for error in errors))

    def test_invalid_manifest_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = root / "spec"
            spec.mkdir()
            (spec / "spec-manifest.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(MODULE.SyncError):
                MODULE.load_source(spec, "a" * 40)


if __name__ == "__main__":
    unittest.main()
