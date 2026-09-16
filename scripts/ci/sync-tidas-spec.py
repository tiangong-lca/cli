#!/usr/bin/env python3
"""Synchronize the CLI's bundled TIDAS schemas from one qualified spec tree.

The CLI package keeps its historical ``assets/tidas-schemas`` path, while the
canonical source lives under ``tidas-spec/assets/tidas/schemas``.  This script
requires an explicit spec commit and validates the spec manifest before it can
write anything.  ``--check`` is the CI/review gate; ``--write`` is the
maintainer operation used to update the package assets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


SCHEMA = "tiangong-lca.cli-tidas-spec-source.v1"
EXPECTED_MANIFEST_VERSION = 1
SCHEMA_ROOT = Path("assets/tidas-schemas")
SOURCE_METADATA = Path("assets/tidas-spec-source.json")


class SyncError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SyncError(f"invalid JSON file: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SyncError(f"JSON root must be an object: {path}")
    return value, raw


def load_source(spec_root: Path, spec_commit: str) -> tuple[dict[str, bytes], dict[str, Any]]:
    if len(spec_commit) != 40 or any(char not in "0123456789abcdef" for char in spec_commit):
        raise SyncError("--spec-commit must be a 40-character lowercase commit SHA")
    manifest, manifest_bytes = read_json(spec_root / "spec-manifest.json")
    if manifest.get("manifestVersion") != EXPECTED_MANIFEST_VERSION:
        raise SyncError("spec-manifest.json has an unsupported manifestVersion")
    package = manifest.get("package")
    if not isinstance(package, dict) or package.get("name") != "@tiangong-lca/tidas-spec":
        raise SyncError("spec-manifest.json is not a @tiangong-lca/tidas-spec manifest")
    spec_version = manifest.get("specVersion")
    if not isinstance(spec_version, str) or not spec_version:
        raise SyncError("spec-manifest.json has no valid specVersion")
    counts = manifest.get("counts")
    expected_count = counts.get("schemasPerLanguage") if isinstance(counts, dict) else None
    if not isinstance(expected_count, int) or expected_count <= 0:
        raise SyncError("spec-manifest.json has no valid schemasPerLanguage count")
    source = manifest.get("source")
    if not isinstance(source, dict):
        raise SyncError("spec-manifest.json has no source record")
    source_repo = source.get("repository")
    source_commit = source.get("commit")
    if not isinstance(source_repo, str) or not source_repo:
        raise SyncError("spec-manifest.json source.repository is missing")
    if not isinstance(source_commit, str) or len(source_commit) != 40:
        raise SyncError("spec-manifest.json source.commit is not a full SHA")

    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise SyncError("spec-manifest.json files must be an array")
    schema_entries = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("path"), str)
        and entry["path"].startswith("assets/tidas/schemas/")
    ]
    if len(schema_entries) != expected_count:
        raise SyncError(
            f"manifest lists {len(schema_entries)} English schemas, expected {expected_count}"
        )

    schemas: dict[str, bytes] = {}
    manifest_files: list[dict[str, str]] = []
    for entry in schema_entries:
        relative = Path(entry["path"])
        name = relative.name
        expected_sha = entry.get("sha256")
        if not isinstance(expected_sha, str) or len(expected_sha) != 64:
            raise SyncError(f"manifest has no valid sha256 for {entry['path']}")
        source_path = spec_root / relative
        try:
            content = source_path.read_bytes()
        except OSError as exc:
            raise SyncError(f"missing schema asset: {source_path}") from exc
        actual_sha = sha256_bytes(content)
        if actual_sha != expected_sha:
            raise SyncError(
                f"schema hash mismatch for {entry['path']}: {actual_sha} != {expected_sha}"
            )
        if name in schemas:
            raise SyncError(f"duplicate schema filename in manifest: {name}")
        schemas[name] = content
        manifest_files.append({"name": name, "sha256": actual_sha})

    if len(schemas) != expected_count:
        raise SyncError("schema filenames are not unique")
    metadata = {
        "schema": SCHEMA,
        "spec_repository": "tiangong-lca/tidas-spec",
        "spec_commit": spec_commit,
        "spec_version": spec_version,
        "source_repository": source_repo,
        "source_commit": source_commit,
        "manifest_sha256": sha256_bytes(manifest_bytes),
        "schemas": manifest_files,
    }
    return schemas, metadata


def expected_metadata_bytes(metadata: dict[str, Any]) -> bytes:
    return (json.dumps(metadata, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode()


def compare_or_write(cli_root: Path, schemas: dict[str, bytes], metadata: dict[str, Any], write: bool) -> list[str]:
    target = cli_root / SCHEMA_ROOT
    target.mkdir(parents=True, exist_ok=True) if write else None
    expected_names = set(schemas)
    actual_names = {path.name for path in target.glob("*.json")} if target.is_dir() else set()
    errors: list[str] = []
    extras = sorted(actual_names - expected_names)
    if extras:
        errors.append(f"unexpected bundled schema files: {', '.join(extras)}")
        if write:
            return errors
    for name, content in sorted(schemas.items()):
        destination = target / name
        if write:
            destination.write_bytes(content)
        else:
            if not destination.is_file():
                errors.append(f"missing bundled schema: {destination}")
            elif destination.read_bytes() != content:
                errors.append(f"bundled schema differs from canonical source: {destination}")
    metadata_path = cli_root / SOURCE_METADATA
    expected_metadata = expected_metadata_bytes(metadata)
    if write:
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_bytes(expected_metadata)
    elif not metadata_path.is_file():
        errors.append(f"missing source identity metadata: {metadata_path}")
    elif metadata_path.read_bytes() != expected_metadata:
        errors.append(f"source identity metadata differs: {metadata_path}")
    return errors


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec-root", type=Path, required=True)
    parser.add_argument("--cli-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--spec-commit", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        schemas, metadata = load_source(args.spec_root.resolve(), args.spec_commit)
        errors = compare_or_write(args.cli_root.resolve(), schemas, metadata, args.write)
        if errors:
            for error in errors:
                print(f"ERROR: {error}", file=sys.stderr)
            return 1
        action = "wrote" if args.write else "verified"
        print(f"{action} {len(schemas)} canonical TIDAS schemas for {metadata['spec_commit']}")
        return 0
    except SyncError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
