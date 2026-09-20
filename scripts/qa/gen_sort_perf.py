# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow>=17", "numpy>=1.26"]
# ///
"""Generate deterministic Parquet shapes for manual sort benchmarks.

    uv run scripts/qa/gen_sort_perf.py
    uv run scripts/qa/gen_sort_perf.py /tmp/sort-data --profiles standard wide
    uv run scripts/qa/gen_sort_perf.py /tmp/sort-data --profiles standard --rows 5000000

The default output is scripts/qa/fixtures/sort-perf/ (git-ignored). Files are
written one row group at a time, so the generator does not retain the full
dataset in memory. It overwrites only the selected profile files and the
manifest; it never clears the output directory.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq


SCRIPT_VERSION = 1
PROFILE_DEFAULTS = {
    "standard": {"rows": 1_000_000, "row_group_size": 100_000, "reverse": False, "wide": False},
    "reversed": {"rows": 1_000_000, "row_group_size": 100_000, "reverse": True, "wide": False},
    "wide": {"rows": 200_000, "row_group_size": 50_000, "reverse": False, "wide": True},
}


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def parse_args() -> argparse.Namespace:
    default_out = Path(__file__).resolve().parent / "fixtures" / "sort-perf"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir", nargs="?", type=Path, default=default_out)
    parser.add_argument(
        "--profiles",
        nargs="+",
        choices=["all", *PROFILE_DEFAULTS],
        default=["all"],
        help="dataset shapes to generate (default: all)",
    )
    parser.add_argument("--rows", type=positive_int, help="override the selected profiles' row count")
    parser.add_argument("--row-group-size", type=positive_int, help="override the selected profiles' row-group size")
    parser.add_argument("--seed", type=int, default=123)
    parser.add_argument("--wide-columns", type=positive_int, default=16, help="extra string columns in the wide profile")
    parser.add_argument("--payload-bytes", type=positive_int, default=128, help="approximate value width of extra string columns")
    args = parser.parse_args()
    if "all" in args.profiles and len(args.profiles) != 1:
        parser.error("'all' cannot be combined with named profiles")
    return args


def schema_for(wide: bool, wide_columns: int) -> pa.Schema:
    fields = [
        pa.field("id", pa.int64(), nullable=False),
        pa.field("key", pa.int64(), nullable=False),
        pa.field("grp", pa.int16(), nullable=True),
        pa.field("value", pa.float64(), nullable=False),
        pa.field("text", pa.string(), nullable=False),
        pa.field("flag", pa.bool_(), nullable=False),
        pa.field("other", pa.float64(), nullable=False),
    ]
    if wide:
        fields.extend(pa.field(f"payload_{index:02d}", pa.string(), nullable=False) for index in range(wide_columns))
    return pa.schema(fields)


def payload_value(row_id: int, column: int, width: int) -> str:
    prefix = f"{row_id:012d}-{column:02d}-"
    remaining = max(0, width - len(prefix))
    return prefix + ("abcdefgh" * ((remaining + 7) // 8))[:remaining]


def batch_for(
    start: int,
    stop: int,
    total_rows: int,
    reverse: bool,
    wide: bool,
    wide_columns: int,
    payload_bytes: int,
    seed: int,
    schema: pa.Schema,
) -> pa.Table:
    positions = np.arange(start, stop, dtype=np.int64)
    ids = total_rows - 1 - positions if reverse else positions
    # Values are functions of the stable row ID, rather than of generation
    # order. Thus standard and reversed contain exactly the same logical rows,
    # and changing row-group size does not silently change the dataset.
    groups = np.remainder(ids + seed, 5).astype(np.int16)
    keys = np.remainder(ids * 999_983 + seed * 7_919, max(1, total_rows)).astype(np.int64)
    values = np.remainder(ids * 48_271 + seed, 2_147_483_647) / 2_147_483_647
    others = np.remainder(ids * 104_729 + seed * 31, 2_000_003) / 1_000_001.5 - 1.0
    arrays = [
        pa.array(ids, type=pa.int64()),
        pa.array(keys, type=pa.int64()),
        pa.array(groups, mask=(ids % 17 == 0), type=pa.int16()),
        pa.array(values, type=pa.float64()),
        pa.array([f"payload-{row_id:012d}-abcdefghijklmnop" for row_id in ids], type=pa.string()),
        pa.array((ids % 2).astype(bool), type=pa.bool_()),
        pa.array(others, type=pa.float64()),
    ]
    if wide:
        arrays.extend(
            pa.array([payload_value(int(row_id), column, payload_bytes) for row_id in ids], type=pa.string())
            for column in range(wide_columns)
        )
    return pa.Table.from_arrays(arrays, schema=schema)


def generate_profile(
    output: Path,
    profile: str,
    rows: int,
    row_group_size: int,
    seed: int,
    wide_columns: int,
    payload_bytes: int,
) -> dict[str, object]:
    settings = PROFILE_DEFAULTS[profile]
    schema = schema_for(settings["wide"], wide_columns)
    started = time.monotonic()
    with pq.ParquetWriter(output, schema, compression="snappy") as writer:
        for start in range(0, rows, row_group_size):
            stop = min(start + row_group_size, rows)
            table = batch_for(
                start,
                stop,
                rows,
                settings["reverse"],
                settings["wide"],
                wide_columns,
                payload_bytes,
                seed,
                schema,
            )
            writer.write_table(table, row_group_size=table.num_rows)
            print(f"{profile}: {stop:,}/{rows:,} rows", flush=True)
    elapsed = time.monotonic() - started
    size = output.stat().st_size
    print(f"wrote {output} ({rows:,} rows, {len(schema)} columns, {size / 1024**2:.1f} MiB, {elapsed:.1f}s)")
    return {
        "file": output.name,
        "seed": seed,
        "rows": rows,
        "columns": len(schema),
        "row_group_size": row_group_size,
        "size_bytes": size,
        "reverse_input": settings["reverse"],
        "wide_columns": wide_columns if settings["wide"] else 0,
        "payload_bytes": payload_bytes if settings["wide"] else 0,
    }


def main() -> None:
    args = parse_args()
    profiles = list(PROFILE_DEFAULTS) if args.profiles == ["all"] else list(dict.fromkeys(args.profiles))
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    generated = []
    for profile in profiles:
        defaults = PROFILE_DEFAULTS[profile]
        rows = args.rows or defaults["rows"]
        row_group_size = min(args.row_group_size or defaults["row_group_size"], rows)
        generated.append(
            generate_profile(
                out_dir / f"{profile}.parquet",
                profile,
                rows,
                row_group_size,
                args.seed,
                args.wide_columns,
                args.payload_bytes,
            )
        )
    manifest = {
        "generator": "scripts/qa/gen_sort_perf.py",
        "version": SCRIPT_VERSION,
        "base_seed": args.seed,
        "profiles": generated,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"manifest: {manifest_path}")


if __name__ == "__main__":
    main()
