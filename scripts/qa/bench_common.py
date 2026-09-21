"""What the benchmarks in this directory share.

`profile_benchmark.py` and `sort_benchmark.py` measure different things and
read the bridge differently — one keeps a table of calls in flight so a
profile and a page read can overlap, the other waits for one answer at a
time — but they start and stop the same process, resolve the same two paths,
and write reports meant to be read side by side. That last part is why the
header lives here rather than in either script: a field spelled differently
in the two would have to be reconciled by whoever compares the results, and
a field added to one would quietly be missing from the other.

Plain `python3`, no third-party imports: `sort_benchmark.py` runs without
`uv` and must keep doing so.
"""

import json
import os
import platform
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BRIDGE = ROOT / "backend" / "target" / "release" / "examples" / "bridge"


def git_revision() -> str | None:
    """The commit the measurement belongs to, or None outside a checkout."""
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def resolve_inputs(dataset: Path, bridge: Path) -> tuple[Path, Path]:
    """The dataset and the bridge binary, absolute, or a refusal naming the
    one that is missing — the bridge with the command that builds it, since
    a release build is easy to forget after a `cargo build`."""
    dataset = dataset.resolve()
    bridge = bridge.resolve()
    if not dataset.is_file():
        raise SystemExit(f"dataset does not exist: {dataset}")
    if not bridge.is_file():
        raise SystemExit(f"bridge does not exist: {bridge}; build it with cargo build --release --example bridge")
    return dataset, bridge


def output_path(requested: Path | None, name: str) -> Path:
    """Where the report goes: what was asked for, or a file stamped with the
    time under the system temp directory, so two runs never collide."""
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = (requested or Path(tempfile.gettempdir()) / f"parqsee-{name}-benchmark-{timestamp}.json").resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def spawn_bridge(binary: Path, state_dir: Path) -> subprocess.Popen:
    """The bridge, talking JSON over a pipe, with its store in `state_dir` so
    a benchmark never touches the store the app itself keeps."""
    process = subprocess.Popen(
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        env={**os.environ, "PARQSEE_DATA_DIR": str(state_dir)},
    )
    assert process.stdin is not None and process.stdout is not None
    return process


def stop_bridge(process: subprocess.Popen) -> None:
    """Ask the bridge to go, then insist. A measurement that left a query
    running can outlast a terminate, and a benchmark that waits forever is
    worse than one that kills the process it was finished with."""
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def report_header(bridge: Path, dataset: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    """What every benchmark report says about the run it came from, so two of
    them can be compared without first checking they mean the same thing."""
    stat = dataset.stat()
    return {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "git_revision": git_revision(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "bridge": str(bridge),
        "dataset": {
            "path": str(dataset),
            "size_bytes": stat.st_size,
            "modified_ns": stat.st_mtime_ns,
            "rows": metadata["num_rows"],
            "columns": metadata["num_columns"],
        },
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"results: {path}")
