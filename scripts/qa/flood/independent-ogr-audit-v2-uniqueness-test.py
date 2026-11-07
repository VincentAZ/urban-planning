"""Execute the auditor's exact uniqueness helper without importing native GEOS."""
import ast
import hashlib
import json
import sys
from pathlib import Path

root = Path(__file__).parent
script = root / "independent-ogr-audit-v2.py"
tree = ast.parse(script.read_text())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "unique_index")
cases = [
    ("source duplicate", "id", [{"id": "28:1", "value": 1}, {"id": "28:1", "value": 2}], False),
    ("saved ledger duplicate", "buildingId", [{"buildingId": "b", "units": 0}, {"buildingId": "b", "units": 0}], False),
    ("source building duplicate", "id", [{"id": "b"}, {"id": "b"}], False),
    ("unique IDs", "id", [{"id": "a", "units": None}, {"id": "b", "units": 0}], True),
    ("empty inventory", "id", [], True),
]
reports = []
for label, key, rows, expected in cases:
    checks = []
    namespace = {"check": lambda ok, name, detail=None: checks.append(bool(ok))}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(script), "exec"), namespace)
    result = namespace["unique_index"](rows, key, label)
    passed = checks == [expected] and len(result) == len({row[key] for row in rows})
    reports.append({"name": label, "passed": passed, "duplicateRejected": not expected})
    assert passed, label
proof = {
    "version": 1,
    "passed": all(row["passed"] for row in reports),
    "tests": len(reports),
    "script": {"path": str(script), "sha256": hashlib.sha256(script.read_bytes()).hexdigest()},
    "testScript": {"path": str(Path(__file__)), "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
    "method": "Extract and execute the exact pure unique_index AST from the OGR auditor; no GEOS import, fake native engine or modified acceptance path.",
    "cases": reports,
}
if len(sys.argv) > 1:
    Path(sys.argv[1]).write_text(json.dumps(proof, indent=2) + "\n")
print(json.dumps({"passed": proof["passed"], "tests": proof["tests"]}))
