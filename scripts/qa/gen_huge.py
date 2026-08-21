# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow>=17", "numpy>=1.26"]
# ///
"""Generate a multi-GB parquet file for the large-file check in docs/MANUAL_QA.md.

    uv run scripts/qa/gen_huge.py [OUT_PATH] [target_gib=2.5]

OUT_PATH defaults to scripts/qa/fixtures/huge.parquet (git-ignored). 2.5 GiB
is about 58M rows and takes ~10 s on an M-series laptop.

Streams row groups of 1M rows through ParquetWriter, so it never holds more
than one row group in memory. Random float64/uint64 columns keep the file
close to incompressible, so the on-disk size tracks the target.
"""
import os, sys, time
import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "huge.parquet")
os.makedirs(os.path.dirname(out), exist_ok=True)
target_bytes = float(sys.argv[2] if len(sys.argv) > 2 else 2.5) * 1024**3
CHUNK = 1_000_000
rng = np.random.default_rng(42)

schema = pa.schema([
    ("id", pa.int64()),
    ("ts", pa.timestamp("ms")),
    ("category", pa.string()),
    ("x", pa.float64()),
    ("y", pa.float64()),
    ("token", pa.string()),
    ("flag", pa.bool_()),
])
cats = pa.array(["alpha", "beta", "gamma", "delta", "epsilon", None])

writer = pq.ParquetWriter(out, schema, compression="snappy")
start = time.time()
rows = 0
while True:
    ids = pa.array(np.arange(rows, rows + CHUNK, dtype=np.int64))
    ts = pa.array(1_600_000_000_000 + rng.integers(0, 10**11, CHUNK), pa.timestamp("ms"))
    category = pc.take(cats, pa.array(rng.integers(0, len(cats), CHUNK).astype(np.int32)))
    x = pa.array(rng.standard_normal(CHUNK))
    y = pa.array(rng.uniform(-1e6, 1e6, CHUNK))
    token = pc.cast(pa.array(rng.integers(0, 2**63 - 1, CHUNK, dtype=np.int64)), pa.string())
    flag = pa.array(rng.integers(0, 2, CHUNK).astype(bool))
    writer.write_table(pa.table([ids, ts, category, x, y, token, flag], schema=schema))
    rows += CHUNK
    size = os.path.getsize(out)
    if rows % 5_000_000 == 0:
        print(f"{rows:,} rows  {size/1024**3:.2f} GiB  {time.time()-start:.0f}s", flush=True)
    if size >= target_bytes:
        break
writer.close()
print(f"done: {rows:,} rows, {os.path.getsize(out)/1024**3:.2f} GiB, {time.time()-start:.0f}s", flush=True)
