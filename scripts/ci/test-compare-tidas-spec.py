#!/usr/bin/env python3
"""Focused tests for the dependency-free W6a schema comparator."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("compare-tidas-spec.py")
SPEC = importlib.util.spec_from_file_location("compare_tidas_spec", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ComparatorTest(unittest.TestCase):
    def test_semantic_arrays_are_not_compared_positionally(self) -> None:
        left = {"oneOf": [{"const": "RAF"}, {"const": "RER"}]}
        right = {"oneOf": [{"const": "RoW"}, {"const": "RAF"}, {"const": "RER"}]}
        differences = MODULE.compare(left, right)
        pointers = {item["pointer"] for item in differences}
        self.assertIn("/oneOf/const:\"RoW\"", pointers)
        self.assertNotIn("/oneOf/0/const", pointers)

    def test_required_and_enum_are_sets(self) -> None:
        left = {"required": ["a", "b"], "enum": ["x", "y"]}
        right = {"required": ["b", "a", "c"], "enum": ["y", "z"]}
        differences = MODULE.compare(left, right)
        self.assertEqual({item["kind"] for item in differences}, {"missing", "extra"})
        self.assertEqual(len(differences), 3)

    def test_report_detects_missing_and_extra_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cli = root / "cli"
            spec = root / "spec"
            (cli / "assets" / "tidas-schemas").mkdir(parents=True)
            (spec / "assets" / "tidas" / "schemas").mkdir(parents=True)
            (cli / "assets" / "tidas-schemas" / "shared.json").write_text('{"type":"string"}\n', encoding="utf-8")
            (cli / "assets" / "tidas-schemas" / "extra.json").write_text('{}\n', encoding="utf-8")
            (spec / "assets" / "tidas" / "schemas" / "shared.json").write_text('{"type":"integer"}\n', encoding="utf-8")
            report = MODULE.build_report(spec, cli)
            self.assertEqual(report["summary"]["cliFiles"], 2)
            self.assertEqual(report["summary"]["specFiles"], 1)
            self.assertEqual(report["summary"]["differentFiles"], 1)
            self.assertEqual(report["summary"]["differenceCount"], 2)


if __name__ == "__main__":
    unittest.main()
