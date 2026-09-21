# /// script
# requires-python = ">=3.10"
# dependencies = ["psutil>=5.9"]
# ///
"""Benchmark the column profile through the release E2E bridge.

    uv run scripts/qa/profile_benchmark.py [DATASET] [options]

Build the bridge first; see scripts/qa/PERFORMANCE.md. Results carry every
sample, medians after warmups, the shape of each profile (chart kind, distinct
count, bucket count), the bridge process's peak RSS and CPU time, the dataset's
metadata and the current Git revision.

Each case runs in a bridge process of its own. Memory is measured as the
process's RSS, and an allocator hands very little of a finished query's memory
back to the OS: a second case in the same process would inherit the first one's
high-water mark and report it as its own. The first repetition of a case is
therefore the honest one, and `peak_rss_mb` is that one's.

Four sections, each switchable off:

* `columns` — one profile per column and filter, twice per repetition: once on
  a session that was just evicted and reopened, then again on the warm one.
  Neither is a cold read of the file: the OS page cache is left as it is and
  `os_file_cache_cleared` records that. A profile the backend refuses is a
  result like any other — a column whose counts exhaust the session's memory
  pool is one of the answers this benchmark is looking for.
* `concurrency` — a page read issued while a profile is still running, against
  the same page read alone; the unfiltered read takes the parquet reader's own
  path, the filtered one goes through the same DataFusion session and memory
  pool as the profile.
* `pileup` — every column profiled in quick succession, as clicking along the
  header does. The webview keeps the last answer and drops the rest; this is
  what the backend does with all of them, and what a page read costs meanwhile.
* `abandonment` — a profile left unawaited while its tab is closed
  (`evict_cache`), to see whether the work stops and what the process does
  afterwards.
"""

import argparse
import json
import os
import platform
import statistics
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

import psutil


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = ROOT / "scripts" / "qa" / "fixtures" / "huge.parquet"
DEFAULT_BRIDGE = ROOT / "backend" / "target" / "release" / "examples" / "bridge"
SECTIONS = ("columns", "concurrency", "pileup", "abandonment")


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def labelled_filter(value: str) -> tuple[str, str | None]:
    """`label=SQL`, or `none` for the unfiltered profile."""
    if value == "none":
        return ("none", None)
    label, separator, sql = value.partition("=")
    if not separator or not label or not sql:
        raise argparse.ArgumentTypeError("expected label=SQL, or none")
    return (label, sql)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset", nargs="?", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--bridge", type=Path, default=DEFAULT_BRIDGE)
    parser.add_argument("--columns", default="category,flag,id,token,x,ts", help="comma-separated column names")
    parser.add_argument(
        "--filter",
        dest="filters",
        action="append",
        type=labelled_filter,
        metavar="LABEL=SQL",
        help="a filter to profile under, repeatable; `none` for the unfiltered one (default: none)",
    )
    parser.add_argument("--repetitions", type=positive_int, default=2)
    parser.add_argument("--warmups", type=int, default=0)
    parser.add_argument("--timeout", type=positive_int, default=900)
    parser.add_argument("--sample-ms", type=positive_int, default=100, help="RSS sampling interval")
    parser.add_argument("--page-limit", type=positive_int, default=100, help="rows per page read in the concurrency and pileup sections")
    parser.add_argument("--busy-column", help="the column profiled in the concurrency, pileup and abandonment sections (default: the first --columns entry)")
    parser.add_argument("--lead-ms", type=positive_int, default=300, help="how long a profile runs before the page read or the closing tab")
    parser.add_argument("--sort-column", help="also measure a deep sorted page during the profile: the grid's one memory-hungry read, which shares the profile's pool")
    parser.add_argument("--gap-ms", type=positive_int, default=150, help="the pause between two profiles in the pileup section")
    parser.add_argument("--skip", action="append", choices=SECTIONS, default=[], help="a section to leave out, repeatable")
    parser.add_argument("--output", type=Path, help="JSON result path (default: a timestamped file in the system temp directory)")
    args = parser.parse_args()
    if args.warmups < 0 or args.warmups >= args.repetitions:
        parser.error("--warmups must be non-negative and smaller than --repetitions")
    args.columns = [c for c in (c.strip() for c in args.columns.split(",")) if c]
    if not args.columns:
        parser.error("--columns is empty")
    if not args.filters:
        args.filters = [("none", None)]
    return args


class Call:
    """One request in flight. The bridge answers concurrently and out of
    order, so a response is matched by id rather than by arrival."""

    def __init__(self, command: str) -> None:
        self.command = command
        self.started = time.perf_counter()
        self.done = threading.Event()
        self.elapsed_ms: float | None = None
        self.value: Any = None
        self.error: str | None = None

    def complete(self, response: dict[str, Any]) -> None:
        self.elapsed_ms = (time.perf_counter() - self.started) * 1000
        if "err" in response:
            self.error = str(response["err"])
        else:
            self.value = response.get("ok")
        self.done.set()

    def running_ms(self) -> float:
        return (time.perf_counter() - self.started) * 1000

    def wait(self, timeout: float) -> tuple[float, Any]:
        if not self.done.wait(timeout):
            raise TimeoutError(f"{self.command} exceeded {timeout}s")
        if self.error is not None:
            raise RuntimeError(f"{self.command}: {self.error}")
        assert self.elapsed_ms is not None
        return self.elapsed_ms, self.value


class Bridge:
    def __init__(self, binary: Path, state_dir: Path, timeout: int, sample_ms: int) -> None:
        self.timeout = timeout
        self.sequence = 0
        self.lock = threading.Lock()
        self.pending: dict[int, Call] = {}
        self.process = subprocess.Popen(
            [str(binary)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env={**os.environ, "PARQSEE_DATA_DIR": str(state_dir)},
        )
        assert self.process.stdin is not None and self.process.stdout is not None
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.usage = Usage(self.process.pid, sample_ms)

    def _read(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            response = json.loads(line)
            with self.lock:
                call = self.pending.pop(int(response["id"]), None)
            if call is not None:
                call.complete(response)

    def send(self, command: str, args: dict[str, Any]) -> Call:
        call = Call(command)
        with self.lock:
            self.sequence += 1
            identifier = self.sequence
            self.pending[identifier] = call
        request = {"id": identifier, "cmd": command, "args": args}
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        return call

    def call(self, command: str, args: dict[str, Any]) -> tuple[float, Any]:
        return self.send(command, args).wait(self.timeout)

    def close(self) -> None:
        self.usage.stop()
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


class Usage:
    """The bridge process's RSS, sampled in the background, and its CPU time.

    A peak is only as good as the sampling interval; the interval is recorded
    with the results so a number can be read for what it is.
    """

    def __init__(self, pid: int, sample_ms: int) -> None:
        self.process = psutil.Process(pid)
        self.interval = sample_ms / 1000
        self.lock = threading.Lock()
        self.peak_rss = 0
        self.running = True
        self.thread = threading.Thread(target=self._sample, daemon=True)
        self.thread.start()

    def _sample(self) -> None:
        while self.running:
            try:
                rss = self.process.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return
            with self.lock:
                self.peak_rss = max(self.peak_rss, rss)
            time.sleep(self.interval)

    def rss(self) -> int:
        try:
            return self.process.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return 0

    def cpu_seconds(self) -> float:
        try:
            times = self.process.cpu_times()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return 0.0
        return times.user + times.system

    def mark(self) -> dict[str, Any]:
        """Start a window: the RSS peak is reset to the current RSS."""
        with self.lock:
            self.peak_rss = self.rss()
        return {"rss_before": self.peak_rss, "cpu_before": self.cpu_seconds()}

    def measure(self, mark: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            peak = self.peak_rss
        return {
            "rss_before_mb": round(mark["rss_before"] / 1024**2, 1),
            "peak_rss_mb": round(max(peak, self.rss()) / 1024**2, 1),
            "cpu_seconds": round(self.cpu_seconds() - mark["cpu_before"], 2),
        }

    def stop(self) -> None:
        self.running = False


Spawn = Callable[[], Bridge]


@contextmanager
def fresh_bridge(spawn: Spawn, dataset: str) -> Iterator[Bridge]:
    """A bridge process of its own, with the file open and nothing else
    behind it: no session, no cached metadata, no memory another case left."""
    bridge = spawn()
    try:
        bridge.call("open_parquet_file", {"path": dataset})
        yield bridge
    finally:
        bridge.close()


def git_revision() -> str | None:
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def chart_shape(profile: dict[str, Any]) -> dict[str, Any]:
    """What the panel would draw, in the few numbers a table can carry."""
    chart = profile.get("chart") or {}
    shape: dict[str, Any] = {
        "kind": profile.get("kind"),
        "chart": chart.get("shape") if isinstance(chart, dict) else chart,
        "total_rows": profile.get("total_rows"),
        "null_count": profile.get("null_count"),
        "distinct_count": profile.get("distinct_count"),
    }
    if isinstance(chart, dict):
        if "values" in chart:
            shape["values_listed"] = len(chart["values"] or [])
            shape["other"] = chart.get("other")
        if "buckets" in chart:
            shape["buckets"] = len(chart["buckets"] or [])
    return shape


def reopen(bridge: Bridge, dataset: str) -> None:
    """Drop the cached session and metadata, then open the file again — what
    the app does when the last tab for a file closes and it is opened anew."""
    bridge.call("evict_cache", {"path": dataset})
    bridge.call("open_parquet_file", {"path": dataset})


def profile_args(dataset: str, column: str, sql: str | None) -> dict[str, Any]:
    args: dict[str, Any] = {"path": dataset, "column": column}
    if sql is not None:
        args["filter"] = sql
    return args


def busy_column(args: argparse.Namespace) -> str:
    return args.busy_column or args.columns[0]


def measure_columns(spawn: Spawn, dataset: str, args: argparse.Namespace) -> list[dict[str, Any]]:
    results = []
    for column in args.columns:
        for label, sql in args.filters:
            request = profile_args(dataset, column, sql)
            evicted: list[float] = []
            warm: list[float] = []
            usage_samples: list[dict[str, Any]] = []
            shape = None
            failure = None
            with fresh_bridge(spawn, dataset) as bridge:
                for repetition in range(args.repetitions):
                    if repetition:
                        reopen(bridge, dataset)
                    mark = bridge.usage.mark()
                    try:
                        first_ms, profile = bridge.call("profile_column", request)
                    except RuntimeError as error:
                        failure = str(error)
                        usage_samples.append(bridge.usage.measure(mark))
                        break
                    usage_samples.append(bridge.usage.measure(mark))
                    repeat_ms, again = bridge.call("profile_column", request)
                    if again != profile:
                        raise RuntimeError(f"the profile of {column} under {label} changed between runs")
                    evicted.append(first_ms)
                    warm.append(repeat_ms)
                    shape = chart_shape(profile)
            case: dict[str, Any] = {
                "column": column,
                "filter": label,
                "filter_sql": sql,
                "usage": usage_samples,
                "peak_rss_mb": usage_samples[0]["peak_rss_mb"],
            }
            if failure is not None:
                case["error"] = failure
                results.append(case)
                print(
                    f"{column:10} {label:14} FAILED after {usage_samples[0]['cpu_seconds']:.1f}s of CPU, "
                    f"peak={case['peak_rss_mb']:.0f}MB: {failure[:110]}",
                    flush=True,
                )
                continue
            case |= {
                "shape": shape,
                "evicted_session_ms": evicted,
                "warm_session_ms": warm,
                "median_evicted_session_ms": statistics.median(evicted[args.warmups :]),
                "median_warm_session_ms": statistics.median(warm[args.warmups :]),
                "cpu_seconds": usage_samples[0]["cpu_seconds"],
            }
            results.append(case)
            assert shape is not None
            print(
                f"{column:10} {label:14} evicted={case['median_evicted_session_ms']:>8.0f}ms "
                f"warm={case['median_warm_session_ms']:>8.0f}ms "
                f"peak={case['peak_rss_mb']:>7.0f}MB cpu={case['cpu_seconds']:>5.1f}s "
                f"{shape['chart']} distinct={shape['distinct_count']}",
                flush=True,
            )
    return results


def measure_concurrency(spawn: Spawn, dataset: str, total_rows: int, args: argparse.Namespace) -> dict[str, Any]:
    """A page read on its own, then the same read while a profile is running.

    The reads take different paths: the unfiltered page the grid asks for is
    the parquet reader's, which never meets DataFusion; a filtered page is a
    query in the same session and under the same memory pool as the profile;
    and a deep sorted page (`--sort-column`) is the one read of the grid's that
    wants the pool for itself.
    """
    column = busy_column(args)
    sql = next((f for _, f in args.filters if f), None)
    page = {"path": dataset, "offset": 0, "limit": args.page_limit}
    filtered_page = {**page, "filter": sql} if sql else None
    sorted_page = (
        {**page, "offset": total_rows // 2, "sort": {"column": args.sort_column, "direction": "asc"}}
        if args.sort_column
        else None
    )

    def alone(request: dict[str, Any]) -> list[float]:
        # The session is dropped between samples, as it is before each read
        # measured during a profile: a sorted page is kept in the cache the
        # `ParquetCache` holds, and a second identical read would be a hit
        # measured against a miss.
        samples = []
        with fresh_bridge(spawn, dataset) as bridge:
            for repetition in range(args.repetitions):
                if repetition:
                    reopen(bridge, dataset)
                samples.append(bridge.call("read_parquet_data", request)[0])
        return samples

    def during(request: dict[str, Any]) -> tuple[list[float], list[float], dict[str, Any], str | None, str | None]:
        reads: list[float] = []
        profiles: list[float] = []
        usage: dict[str, Any] = {}
        read_error = None
        profile_error = None
        with fresh_bridge(spawn, dataset) as bridge:
            for repetition in range(args.repetitions):
                if repetition:
                    reopen(bridge, dataset)
                mark = bridge.usage.mark()
                running = bridge.send("profile_column", profile_args(dataset, column, None))
                time.sleep(args.lead_ms / 1000)
                if running.done.is_set():
                    raise RuntimeError(f"the profile of {column} finished within the lead; use a bigger dataset or a shorter lead")
                # Both of them may be refused, and which one is the answer:
                # the profile and the page share the session's memory pool,
                # so a profile large enough to exhaust it can take the grid's
                # own query down with it.
                try:
                    read_ms, _ = bridge.call("read_parquet_data", request)
                    reads.append(read_ms)
                except RuntimeError as error:
                    read_error = str(error)
                try:
                    total_ms, _ = running.wait(args.timeout)
                    profiles.append(total_ms)
                except RuntimeError as error:
                    profile_error = str(error)
                usage = bridge.usage.measure(mark)
        return reads, profiles, usage, read_error, profile_error

    result: dict[str, Any] = {"profiled_column": column, "page_limit": args.page_limit, "lead_ms": args.lead_ms}
    for name, request in (("unfiltered", page), ("filtered", filtered_page), ("deep_sorted", sorted_page)):
        if request is None:
            continue
        solo = alone(request)
        reads, profiles, usage, read_error, profile_error = during(request)
        result[name] = {
            "filter_sql": request.get("filter"),
            "sort": request.get("sort"),
            "offset": request["offset"],
            "page_alone_ms": solo,
            "page_during_profile_ms": reads,
            "profile_ms": profiles,
            "median_page_alone_ms": statistics.median(solo),
            "median_page_during_profile_ms": statistics.median(reads) if reads else None,
            "page_error_during_profile": read_error,
            "profile_error": profile_error,
            "usage_during": usage,
        }
        during_ms = result[name]["median_page_during_profile_ms"]
        print(
            f"{name} page read: {result[name]['median_page_alone_ms']:.0f}ms alone, "
            + (f"{during_ms:.0f}ms" if during_ms is not None else f"REFUSED ({read_error})")
            + f" during a profile of {column}"
            + (f"; the profile itself was refused: {profile_error[:100]}" if profile_error else ""),
            flush=True,
        )
    return result


def measure_pileup(spawn: Spawn, dataset: str, args: argparse.Namespace) -> dict[str, Any]:
    """Every column profiled in quick succession, and a page read among them.

    Clicking along the header is one profile per column, none of them
    cancelled: the panel drops every answer but the last. What that costs the
    process is here — when each answers, what the pile peaks at, and whether
    the grid still pages while it runs.
    """
    page = {"path": dataset, "offset": 0, "limit": args.page_limit}
    with fresh_bridge(spawn, dataset) as bridge:
        bridge.call("read_parquet_data", page)
        alone_ms, _ = bridge.call("read_parquet_data", page)
    with fresh_bridge(spawn, dataset) as bridge:
        mark = bridge.usage.mark()
        started = time.perf_counter()
        calls = []
        for column in args.columns:
            calls.append((column, bridge.send("profile_column", profile_args(dataset, column, None))))
            time.sleep(args.gap_ms / 1000)
        page_ms, _ = bridge.call("read_parquet_data", page)
        answers = []
        for column, call in calls:
            try:
                ms, _ = call.wait(args.timeout)
                answers.append({"column": column, "answered_after_ms": round(ms), "error": None})
            except RuntimeError as error:
                answers.append({"column": column, "answered_after_ms": round(call.running_ms()), "error": str(error)})
        settled_ms = round((time.perf_counter() - started) * 1000)
        usage = bridge.usage.measure(mark)
    result = {
        "columns": args.columns,
        "gap_ms": args.gap_ms,
        "answers": answers,
        "all_settled_after_ms": settled_ms,
        "page_alone_ms": alone_ms,
        "page_during_pileup_ms": page_ms,
        "usage": usage,
    }
    failed = [a["column"] for a in answers if a["error"]]
    print(
        f"pileup of {len(args.columns)} profiles settled in {settled_ms} ms, "
        f"peak={usage['peak_rss_mb']:.0f}MB cpu={usage['cpu_seconds']:.1f}s, "
        f"{len(failed)} refused{' (' + ', '.join(failed) + ')' if failed else ''}; "
        f"page read {alone_ms:.0f}ms alone, {page_ms:.0f}ms during",
        flush=True,
    )
    return result


def measure_abandonment(spawn: Spawn, dataset: str, args: argparse.Namespace) -> dict[str, Any]:
    """What a profile nobody is waiting for costs after its tab is closed.

    The webview drops the answer; this measures the process. `evict_cache` is
    the closing tab, and what the process spends after it is the work that went
    on regardless.
    """
    column = busy_column(args)
    with fresh_bridge(spawn, dataset) as bridge:
        mark = bridge.usage.mark()
        running = bridge.send("profile_column", profile_args(dataset, column, None))
        time.sleep(args.lead_ms / 1000)
        if running.done.is_set():
            raise RuntimeError(f"the profile of {column} finished within the lead; use a bigger dataset or a shorter lead")
        evict_ms, _ = bridge.call("evict_cache", {"path": dataset})
        evicted_at = time.perf_counter()
        cpu_at_evict = bridge.usage.cpu_seconds()
        rss_at_evict = bridge.usage.rss()
        try:
            total_ms, _ = running.wait(args.timeout)
            outcome = "answered"
        except RuntimeError as error:
            total_ms, outcome = running.running_ms(), f"error: {error}"
        usage = bridge.usage.measure(mark)
        result = {
            "profiled_column": column,
            "lead_ms": args.lead_ms,
            "evict_cache_ms": evict_ms,
            "outcome_after_evict": outcome,
            "profile_ms": total_ms,
            "ran_after_evict_ms": round((time.perf_counter() - evicted_at) * 1000),
            "cpu_seconds_after_evict": round(bridge.usage.cpu_seconds() - cpu_at_evict, 2),
            "rss_at_evict_mb": round(rss_at_evict / 1024**2, 1),
            "rss_after_mb": round(bridge.usage.rss() / 1024**2, 1),
            "usage": usage,
        }
    print(
        f"abandoned profile of {column}: {outcome}, ran {result['ran_after_evict_ms']} ms "
        f"and {result['cpu_seconds_after_evict']} s of CPU past the closing tab",
        flush=True,
    )
    return result


def main() -> None:
    args = parse_args()
    dataset = args.dataset.resolve()
    bridge_path = args.bridge.resolve()
    if not dataset.is_file():
        raise SystemExit(f"dataset does not exist: {dataset}")
    if not bridge_path.is_file():
        raise SystemExit(f"bridge does not exist: {bridge_path}; build it with cargo build --release --example bridge")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = (args.output or Path(tempfile.gettempdir()) / f"parqsee-profile-benchmark-{timestamp}.json").resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    sections = [s for s in SECTIONS if s not in args.skip]

    measured: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="parqsee-profile-benchmark-") as state:
        def spawn() -> Bridge:
            return Bridge(bridge_path, Path(state), args.timeout, args.sample_ms)

        with fresh_bridge(spawn, str(dataset)) as bridge:
            open_ms, metadata = bridge.call("open_parquet_file", {"path": str(dataset)})
        print(f"opened {dataset.name} in {open_ms:.0f} ms: {metadata['num_rows']:,} rows", flush=True)
        if "columns" in sections:
            measured["columns"] = measure_columns(spawn, str(dataset), args)
        if "concurrency" in sections:
            measured["concurrency"] = measure_concurrency(spawn, str(dataset), metadata["num_rows"], args)
        if "pileup" in sections:
            measured["pileup"] = measure_pileup(spawn, str(dataset), args)
        if "abandonment" in sections:
            measured["abandonment"] = measure_abandonment(spawn, str(dataset), args)

    stat = dataset.stat()
    report = {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "git_revision": git_revision(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "bridge": str(bridge_path),
        "dataset": {
            "path": str(dataset),
            "size_bytes": stat.st_size,
            "modified_ns": stat.st_mtime_ns,
            "rows": metadata["num_rows"],
            "columns": metadata["num_columns"],
        },
        "conditions": {
            "columns": args.columns,
            "filters": [{"label": label, "sql": sql} for label, sql in args.filters],
            "repetitions": args.repetitions,
            "warmups_discarded": args.warmups,
            "sections": sections,
            "sort_column": args.sort_column,
            "rss_sample_ms": args.sample_ms,
            "bridge_process_per_case": True,
            "session_evicted_and_reopened_between_repetitions": True,
            "os_file_cache_cleared": False,
            "timing_scope": "release bridge JSON round trip; the metadata open excluded",
        },
        **measured,
    }
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"results: {output}")


if __name__ == "__main__":
    main()
