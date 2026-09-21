#!/usr/bin/env python3
"""Benchmark sorted browse pages through the release E2E bridge.

Build the bridge and generate a dataset first; see scripts/qa/PERFORMANCE.md.
Results include every sample, medians after warmups, dataset metadata and the
current Git revision. The script checks that a cache hit returns exactly the
same rows as its preceding miss.
"""

import argparse
import hashlib
import json
import selectors
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any

from bench_common import DEFAULT_BRIDGE, ROOT, output_path, report_header, resolve_inputs, spawn_bridge, stop_bridge, write_report


DEFAULT_DATASET = ROOT / "scripts" / "qa" / "fixtures" / "sort-perf" / "standard.parquet"


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", nargs="?", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--bridge", type=Path, default=DEFAULT_BRIDGE)
    parser.add_argument("--column", default="grp")
    parser.add_argument("--direction", choices=["asc", "desc"], default="asc")
    parser.add_argument("--filter", help="optional SQL filter; COUNT setup is measured separately")
    parser.add_argument("--limit", type=positive_int, default=100)
    parser.add_argument("--repetitions", type=positive_int, default=4)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--timeout", type=positive_int, default=120)
    parser.add_argument("--output", type=Path, help="JSON result path (default: timestamped file in the system temp directory)")
    args = parser.parse_args()
    if args.warmups < 0 or args.warmups >= args.repetitions:
        parser.error("--warmups must be non-negative and smaller than --repetitions")
    return args


class Bridge:
    def __init__(self, binary: Path, state_dir: Path, timeout: int) -> None:
        self.timeout = timeout
        self.sequence = 0
        self.process = spawn_bridge(binary, state_dir)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def call(self, command: str, args: dict[str, Any]) -> tuple[float, Any]:
        self.sequence += 1
        started = time.perf_counter()
        request = {"id": self.sequence, "cmd": command, "args": args}
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        if not self.selector.select(self.timeout):
            self.process.kill()
            raise TimeoutError(f"{command} exceeded {self.timeout}s")
        response = json.loads(self.process.stdout.readline())
        elapsed_ms = (time.perf_counter() - started) * 1000
        if "err" in response:
            raise RuntimeError(response["err"])
        return elapsed_ms, response["ok"]

    def close(self) -> None:
        stop_bridge(self.process)


def digest_rows(rows: Any) -> str:
    payload = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()


def page_cases(total: int, limit: int) -> list[tuple[str, int]]:
    maximum = max(0, total - limit)
    raw = [
        ("first", 0),
        ("one_percent", total // 100),
        ("quarter", total // 4),
        ("middle", total // 2),
        ("just_past_middle", total // 2 + limit),
        ("last", maximum),
    ]
    seen: set[int] = set()
    cases = []
    for name, offset in raw:
        offset = min(maximum, offset)
        if offset not in seen:
            seen.add(offset)
            cases.append((name, offset))
    return cases


def main() -> None:
    args = parse_args()
    dataset, bridge_path = resolve_inputs(args.dataset, args.bridge)
    output = output_path(args.output, "sort")

    with tempfile.TemporaryDirectory(prefix="parqsee-sort-benchmark-") as state:
        bridge = Bridge(bridge_path, Path(state), args.timeout)
        try:
            _, metadata = bridge.call("open_parquet_file", {"path": str(dataset)})
            total = metadata["num_rows"]
            if args.filter:
                _, total = bridge.call("count_parquet_data", {"path": str(dataset), "filter": args.filter})
            results = []
            for name, offset in page_cases(total, args.limit):
                misses: list[float] = []
                hits: list[float] = []
                count_setup: list[float] = []
                expected_digest = None
                rows = []
                for _ in range(args.repetitions):
                    bridge.call("evict_cache", {"path": str(dataset)})
                    bridge.call("open_parquet_file", {"path": str(dataset)})
                    if args.filter:
                        count_ms, counted = bridge.call(
                            "count_parquet_data", {"path": str(dataset), "filter": args.filter}
                        )
                        if counted != total:
                            raise RuntimeError(f"filtered count changed from {total} to {counted}")
                        count_setup.append(count_ms)
                    request: dict[str, Any] = {
                        "path": str(dataset),
                        "offset": offset,
                        "limit": args.limit,
                        "sort": {"column": args.column, "direction": args.direction},
                    }
                    if args.filter:
                        request["filter"] = args.filter
                    miss_ms, rows = bridge.call("read_parquet_data", request)
                    hit_ms, cached_rows = bridge.call("read_parquet_data", request)
                    if cached_rows != rows:
                        raise RuntimeError(f"cache hit differs from miss for {name}")
                    row_digest = digest_rows(rows)
                    if expected_digest is not None and expected_digest != row_digest:
                        raise RuntimeError(f"result changed between repetitions for {name}")
                    expected_digest = row_digest
                    misses.append(miss_ms)
                    hits.append(hit_ms)
                used_misses = misses[args.warmups :]
                used_hits = hits[args.warmups :]
                result: dict[str, Any] = {
                    "case": name,
                    "offset": offset,
                    "rows_returned": len(rows),
                    "row_sha256": expected_digest,
                    "cache_miss_ms": misses,
                    "cache_hit_ms": hits,
                    "median_cache_miss_ms": statistics.median(used_misses),
                    "median_cache_hit_ms": statistics.median(used_hits),
                }
                if count_setup:
                    result["count_setup_ms"] = count_setup
                    result["median_count_setup_ms"] = statistics.median(count_setup[args.warmups :])
                results.append(result)
                print(
                    f"{name:18} offset={offset:>10,} "
                    f"miss={result['median_cache_miss_ms']:>9.2f}ms "
                    f"hit={result['median_cache_hit_ms']:>7.3f}ms",
                    flush=True,
                )
        finally:
            bridge.close()

    report = {
        **report_header(bridge_path, dataset, metadata),
        "conditions": {
            "column": args.column,
            "direction": args.direction,
            "filter": args.filter,
            "filtered_rows": total if args.filter else None,
            "limit": args.limit,
            "repetitions": args.repetitions,
            "warmups_discarded": args.warmups,
            "session_evicted_before_each_miss": True,
            "os_file_cache_cleared": False,
            "timing_scope": "release bridge JSON round trip; metadata open excluded; filtered COUNT setup reported separately",
        },
        "results": results,
    }
    write_report(output, report)


if __name__ == "__main__":
    main()
