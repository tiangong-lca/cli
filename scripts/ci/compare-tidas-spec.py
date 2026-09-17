#!/usr/bin/env python3
"""Compare CLI schema assets with one exact tidas-spec source tree.

The comparator is intentionally dependency-free and reports semantic JSON
locations rather than pretending that a filename match proves equivalence.
Arrays whose order is not part of JSON Schema validation (`enum`, `required`,
`oneOf`, `anyOf`, and `allOf`) are compared by stable identities where
possible so a taxonomy insertion does not turn into hundreds of positional
false positives.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).resolve()
REPO_ROOT = SCRIPT.parents[2]
DEFAULT_SPEC_ROOTS = (REPO_ROOT / "tidas-spec", REPO_ROOT.parent / "tidas-spec")
SCHEMA_DIR = REPO_ROOT / "assets" / "tidas-schemas"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_head(path: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return result.stdout.strip() or None


def pointer(parent: str, token: str | int) -> str:
    escaped = str(token).replace("~", "~0").replace("/", "~1")
    return f"{parent}/{escaped}" if parent else f"/{escaped}"


def short_value(value: Any) -> Any:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(encoded) <= 600:
        return value
    return {
        "truncated": True,
        "sha256": hashlib.sha256(encoded.encode()).hexdigest(),
        "length": len(encoded),
    }


def item_identity(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    if "const" in value:
        return f"const:{json.dumps(value['const'], ensure_ascii=False, sort_keys=True)}"
    if "$ref" in value:
        return f"ref:{value['$ref']}"
    properties = value.get("properties")
    if isinstance(properties, dict):
        # Taxonomy entries usually keep their identity one level below the
        # union member (`properties.<field>.const`). Prefer that identity over
        # the shared property-name set, otherwise every category entry would
        # overwrite the previous entry in the comparison index.
        for name in sorted(properties):
            candidate = properties[name]
            if isinstance(candidate, dict) and "const" in candidate:
                return f"property-const:{name}:{json.dumps(candidate['const'], ensure_ascii=False, sort_keys=True)}"
    if "type" in value and set(value) <= {"type", "description"}:
        return f"type:{value['type']}"
    if isinstance(properties, dict):
        return "properties:" + ",".join(sorted(properties))
    return None


def classify(pointer_value: str, kind: str) -> str:
    keyword = pointer_value.rsplit("/", 1)[-1].replace("~1", "/").replace("~0", "~")
    if kind in {"missing", "extra"}:
        return "structure"
    if keyword in {"description", "title", "examples", "default", "$comment"}:
        return "documentation-or-example"
    if keyword in {"type", "pattern", "format", "enum", "const", "$ref", "oneOf", "anyOf", "allOf", "required", "minItems", "maxItems", "minimum", "maximum", "additionalProperties", "propertyNames"}:
        return "validation-constraint"
    return "other-schema-keyword"


def record_difference(
    result: list[dict[str, Any]],
    at: str,
    kind: str,
    left: Any,
    right: Any,
) -> None:
    result.append(
        {
            "pointer": at or "/",
            "kind": kind,
            "category": classify(at, kind),
            "left": short_value(left),
            "right": short_value(right),
        }
    )


def compare(left: Any, right: Any, at: str = "", result: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    differences = result if result is not None else []
    if type(left) is not type(right):
        record_difference(differences, at, "value", left, right)
        return differences
    if isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            child = pointer(at, key)
            if key not in left:
                record_difference(differences, child, "missing", None, right[key])
            elif key not in right:
                record_difference(differences, child, "extra", left[key], None)
            else:
                compare(left[key], right[key], child, differences)
        return differences
    if isinstance(left, list):
        keyword = at.rsplit("/", 1)[-1] if at else ""
        if keyword == "enum":
            left_set = {json.dumps(v, ensure_ascii=False, sort_keys=True) for v in left}
            right_set = {json.dumps(v, ensure_ascii=False, sort_keys=True) for v in right}
            for encoded in sorted(left_set - right_set):
                record_difference(differences, at, "extra", json.loads(encoded), None)
            for encoded in sorted(right_set - left_set):
                record_difference(differences, at, "missing", None, json.loads(encoded))
            return differences
        if keyword in {"required"}:
            left_set, right_set = set(left), set(right)
            for value in sorted(left_set - right_set):
                record_difference(differences, at, "extra", value, None)
            for value in sorted(right_set - left_set):
                record_difference(differences, at, "missing", None, value)
            return differences
        if keyword in {"oneOf", "anyOf", "allOf"}:
            left_index = {item_identity(value) or json.dumps(value, ensure_ascii=False, sort_keys=True): value for value in left}
            right_index = {item_identity(value) or json.dumps(value, ensure_ascii=False, sort_keys=True): value for value in right}
            for key in sorted(set(left_index) | set(right_index)):
                child = pointer(at, key)
                if key not in left_index:
                    record_difference(differences, child, "missing", None, right_index[key])
                elif key not in right_index:
                    record_difference(differences, child, "extra", left_index[key], None)
                else:
                    compare(left_index[key], right_index[key], child, differences)
            return differences
        if len(left) != len(right):
            record_difference(differences, at, "value", len(left), len(right))
        for index, (left_value, right_value) in enumerate(zip(left, right)):
            compare(left_value, right_value, pointer(at, index), differences)
        return differences
    if left != right:
        record_difference(differences, at, "value", left, right)
    return differences


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def resolve_spec_root(value: str | None) -> Path:
    candidates = (Path(value),) if value else DEFAULT_SPEC_ROOTS
    for candidate in candidates:
        if (candidate / "assets" / "tidas" / "schemas").is_dir():
            return candidate.resolve()
    raise SystemExit("no tidas-spec root found; pass --spec-root")


def build_report(spec_root: Path, cli_root: Path, cli_commit: str | None = None) -> dict[str, Any]:
    spec_dir = spec_root / "assets" / "tidas" / "schemas"
    cli_dir = cli_root / "assets" / "tidas-schemas"
    spec_files = {path.name for path in spec_dir.glob("*.json")}
    cli_files = {path.name for path in cli_dir.glob("*.json")}
    differences: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    for name in sorted(spec_files | cli_files):
        left_path = cli_dir / name
        right_path = spec_dir / name
        if name not in cli_files:
            record_difference(differences, f"/files/{name}", "missing", None, name)
            files.append({"name": name, "status": "missing-cli"})
            continue
        if name not in spec_files:
            record_difference(differences, f"/files/{name}", "extra", name, None)
            files.append({"name": name, "status": "extra-cli"})
            continue
        left = load_json(left_path)
        right = load_json(right_path)
        start = len(differences)
        compare(left, right, f"/files/{name}", differences)
        files.append(
            {
                "name": name,
                "status": "identical" if len(differences) == start else "different",
                "cliSha256": sha256_file(left_path),
                "specSha256": sha256_file(right_path),
                "differenceCount": len(differences) - start,
            }
        )
    manifest_path = spec_root / "spec-manifest.json"
    manifest = load_json(manifest_path) if manifest_path.exists() else {}
    package = manifest.get("package", {}) if isinstance(manifest, dict) else {}
    disposition = {
        "status": "unresolved",
        "owner": "tidas-spec-content-owner-and-cli-owner",
        "note": "W6a requires semantic review; this generated ledger is evidence, not approval.",
    }
    if not differences:
        disposition = {
            "status": "resolved",
            "owner": "workspace-user-decision-and-cli-owner",
            "note": "User decision #1240 establishes the original tidas-tools schema as semantic authority; tidas-spec is the controlled carrier and CLI assets match the approved candidate exactly.",
        }
    return {
        "reportVersion": 1,
        "source": {
            "cliRepository": "tiangong-lca/cli",
            "cliCommit": cli_commit or git_head(cli_root),
            "specRepository": "tiangong-lca/tidas-spec",
            "specCommit": git_head(spec_root),
            "specVersion": package.get("version") or manifest.get("specVersion"),
            "manifestSha256": sha256_file(manifest_path) if manifest_path.exists() else None,
        },
        "paths": {"cli": "assets/tidas-schemas", "spec": "assets/tidas/schemas"},
        "summary": {
            "cliFiles": len(cli_files),
            "specFiles": len(spec_files),
            "identicalFiles": sum(1 for item in files if item["status"] == "identical"),
            "differentFiles": sum(1 for item in files if item["status"] == "different"),
            "differenceCount": len(differences),
            "unresolvedCount": len(differences),
        },
        "files": files,
        "differences": differences,
        "disposition": disposition,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec-root")
    parser.add_argument("--cli-root", default=str(REPO_ROOT))
    parser.add_argument("--cli-commit", help="selected immutable CLI baseline recorded in the ledger")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--check", type=Path, help="fail if an existing report differs from a fresh comparison")
    args = parser.parse_args()
    report = build_report(resolve_spec_root(args.spec_root), Path(args.cli_root).resolve(), args.cli_commit)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        try:
            expected = json.loads(args.check.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            print(f"cannot read comparison report {args.check}: {error}", file=sys.stderr)
            return 1
        if expected != report:
            print(f"comparison report is stale: {args.check}", file=sys.stderr)
            return 1
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded, encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
