# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow>=17"]
# ///
"""Generate the adversarial parquet fixtures docs/MANUAL_QA.md refers to.

    uv run scripts/qa/gen_fixtures.py [OUT_DIR]

OUT_DIR defaults to scripts/qa/fixtures (git-ignored). The directory is wiped
and rebuilt, so it refuses any existing directory it did not create itself.
Families: numeric (incl. 64-bit limits and decimal256), NaN/Inf, temporal,
text/binary, nested, odd and duplicate column names, empty/wide/multi-row-group
shapes, corrupt files, and a `paths/` tree of hostile names (glob characters,
spaces, `%`, `#`, Japanese, an uppercase `.PARQUET`, a broken symlink and a
directory without read permission).
"""
import os, sys, datetime, decimal, random, shutil, stat
import pyarrow as pa
import pyarrow.parquet as pq

MARKER = ".parqsee-fixtures"
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "fixtures"))
if os.path.exists(OUT):
    if not os.path.exists(os.path.join(OUT, MARKER)):
        sys.exit(f"refusing to wipe {OUT}: not a fixture directory this script created")
    # The unreadable directory must be opened again before it can be removed.
    noperm = os.path.join(OUT, "paths", "noperm")
    if os.path.exists(noperm):
        os.chmod(noperm, stat.S_IRWXU)
    shutil.rmtree(OUT)
os.makedirs(OUT)
open(os.path.join(OUT, MARKER), "w").close()

def w(name, table, **kw):
    path = os.path.join(OUT, name)
    pq.write_table(table, path, **kw)
    print("wrote", name, table.num_rows, "rows", table.num_columns, "cols")
    return path

# ---- numeric family --------------------------------------------------------
w("numeric.parquet", pa.table({
    "b": pa.array([True, False, None], pa.bool_()),
    "i8": pa.array([-128, 127, None], pa.int8()),
    "i16": pa.array([-32768, 32767, None], pa.int16()),
    "i32": pa.array([-2**31, 2**31-1, None], pa.int32()),
    "i64": pa.array([-2**63, 2**63-1, None], pa.int64()),
    "u8": pa.array([0, 255, None], pa.uint8()),
    "u16": pa.array([0, 65535, None], pa.uint16()),
    "u32": pa.array([0, 2**32-1, None], pa.uint32()),
    "u64": pa.array([0, 2**64-1, None], pa.uint64()),
    "f32": pa.array([1.5, -0.0, None], pa.float32()),
    "f64": pa.array([0.1+0.2, 1e300, None], pa.float64()),
    "d128": pa.array([decimal.Decimal("12345.67"), decimal.Decimal("-0.01"), None], pa.decimal128(10, 2)),
    "d256": pa.array([decimal.Decimal("1" * 40 + ".5"), decimal.Decimal("0"), None], pa.decimal256(50, 1)),
}))

w("nan.parquet", pa.table({
    "id": pa.array([1, 2, 3, 4], pa.int64()),
    "x": pa.array([float("nan"), float("inf"), float("-inf"), 1.0], pa.float64()),
    "y": pa.array([float("nan"), 2.0, None, 4.0], pa.float32()),
}))

w("f16.parquet", pa.table({
    "h": pa.array([1.5, None, -2.0], pa.float16()) if hasattr(pa, "float16") else pa.array([1.5, None, -2.0]),
}))

w("big_ints.parquet", pa.table({
    "id": pa.array([2**53+1, -(2**53+1), 2**53, 42], pa.int64()),
    "uid": pa.array([2**64-1, 2**53+1, 1, 0], pa.uint64()),
}))

# ---- temporal family ---------------------------------------------------------
ts = [datetime.datetime(2024, 1, 2, 3, 4, 5, 678901), datetime.datetime(1969, 12, 31, 23, 59, 59), None]
tz = datetime.timezone(datetime.timedelta(hours=9))
w("temporal.parquet", pa.table({
    "d32": pa.array([datetime.date(2024, 2, 29), datetime.date(1900, 1, 1), None], pa.date32()),
    "d64": pa.array([datetime.date(2024, 2, 29), datetime.date(1970, 1, 1), None], pa.date64()),
    "t32ms": pa.array([datetime.time(1, 2, 3, 4000), datetime.time(23, 59, 59), None], pa.time32("ms")),
    "t64us": pa.array([datetime.time(1, 2, 3, 4), datetime.time(0, 0), None], pa.time64("us")),
    "ts_s": pa.array(ts, pa.timestamp("s")),
    "ts_ms": pa.array(ts, pa.timestamp("ms")),
    "ts_us": pa.array(ts, pa.timestamp("us")),
    "ts_ns": pa.array(ts, pa.timestamp("ns")),
    "ts_utc": pa.array(ts, pa.timestamp("us", tz="UTC")),
    "ts_tokyo": pa.array([t.replace(tzinfo=tz) if t else None for t in ts], pa.timestamp("us", tz="Asia/Tokyo")),
    "dur": pa.array([datetime.timedelta(days=1, seconds=5), datetime.timedelta(0), None], pa.duration("us")),
}))

w("int96.parquet", pa.table({
    "ts": pa.array(ts, pa.timestamp("ns")),
}), use_deprecated_int96_timestamps=True)

# ---- text / binary family ----------------------------------------------------
import uuid
w("text_binary.parquet", pa.table({
    "s": pa.array(["plain", "日本語 and emoji 🎉", "", None, "line\nbreak\ttab", "quote\"s and 'apos'", "comma,semi;"], pa.string()),
    "ls": pa.array(["large"] * 7, pa.large_string()),
    "bin": pa.array([b"\x00\x01\xff", b"", None, b"abc", b"\xde\xad", b"x", b"y"], pa.binary()),
    "lbin": pa.array([b"L"] * 7, pa.large_binary()),
    "uuid": pa.array([uuid.uuid4().bytes for _ in range(6)] + [None], pa.binary(16)),
}))

w("long_text.parquet", pa.table({
    "id": pa.array(list(range(3)), pa.int64()),
    "blob": pa.array(["x" * 200_000, "short", None], pa.string()),
}))

# dictionary-encoded column
w("dict.parquet", pa.table({
    "cat": pa.array(["a", "b", "a", None, "c"]).dictionary_encode(),
    "n": pa.array([1, 2, 3, 4, 5], pa.int64()),
}))

# ---- nested family ----------------------------------------------------------
w("nested.parquet", pa.table({
    "id": pa.array([1, 2, 3], pa.int64()),
    "li": pa.array([[1, 2], [], None], pa.list_(pa.int32())),
    "lls": pa.array([["a"], None, ["b", None]], pa.large_list(pa.string())),
    "fsl": pa.array([[1.0, 2.0], [0.0, 0.0], [3.0, 4.0]], pa.list_(pa.float64(), 2)),
    "st": pa.array([{"x": 1, "y": "a"}, None, {"x": None, "y": "c"}], pa.struct([("x", pa.int64()), ("y", pa.string())])),
    "mp": pa.array([[("k", 1)], [], None], pa.map_(pa.string(), pa.int64())),
    "deep": pa.array([[{"v": [1, 2]}], None, [{"v": None}, {"v": []}]],
                     pa.list_(pa.struct([("v", pa.list_(pa.int64()))]))),
    "st_big": pa.array([{"big": 2**53+1}, {"big": 1}, None], pa.struct([("big", pa.int64())])),
    "st_dec": pa.array([{"amt": decimal.Decimal("1.50")}, None, {"amt": None}], pa.struct([("amt", pa.decimal128(10, 2))])),
}))

# ---- column names ---------------------------------------------------------------
names = ["with space", 'qu"ote', "select", "日本語", "a.b", "MixedCase", "", "t", "1abc", "semi;colon", "back`tick", "per%cent", "__index_level_0__"]
w("names.parquet", pa.Table.from_arrays([pa.array([1, 2, 3], pa.int64()) for _ in names], names=names))

w("dup_names.parquet", pa.Table.from_arrays([pa.array([1, 2], pa.int64()), pa.array(["x", "y"])], names=["id", "id"]))

# ---- shapes ----------------------------------------------------------------------
w("empty_rows.parquet", pa.table({"id": pa.array([], pa.int64()), "s": pa.array([], pa.string())}))

w("all_null.parquet", pa.table({
    "id": pa.array([1, 2, 3], pa.int64()),
    "s": pa.array([None, None, None], pa.string()),
    "n": pa.array([None, None, None], pa.int64()),
    "nul": pa.array([None, None, None], pa.null()),
}))

w("wide.parquet", pa.table({f"col_{i:03d}": pa.array(list(range(10)), pa.int32()) for i in range(600)}))

N = 100_000
w("multi_rowgroup.parquet", pa.table({
    "id": pa.array(list(range(N)), pa.int64()),
    "grp": pa.array([i % 7 for i in range(N)], pa.int32()),
    "name": pa.array([f"row-{i}" for i in range(N)], pa.string()),
    "val": pa.array([random.random() for _ in range(N)], pa.float64()),
}), row_group_size=10_000)

# 1-row and single-column files
w("one_row.parquet", pa.table({"only": pa.array(["x"])}))

# ---- broken files -----------------------------------------------------------------
with open(os.path.join(OUT, "corrupt.parquet"), "wb") as f:
    f.write(os.urandom(4096))
with open(os.path.join(OUT, "empty_file.parquet"), "wb") as f:
    pass
with open(os.path.join(OUT, "notparquet.parquet"), "w") as f:
    f.write("a,b,c\n1,2,3\n")
good = open(os.path.join(OUT, "multi_rowgroup.parquet"), "rb").read()
with open(os.path.join(OUT, "truncated.parquet"), "wb") as f:
    f.write(good[: len(good) // 2])
# footer intact but a data page corrupted
bad = bytearray(good)
for i in range(1000, 5000):
    bad[i] = 0
with open(os.path.join(OUT, "bad_page.parquet"), "wb") as f:
    f.write(bad)

# ---- path names -------------------------------------------------------------------
small = pa.table({"id": pa.array([1, 2, 3], pa.int64()), "s": pa.array(["a", "b", "c"])})
pdir = os.path.join(OUT, "paths")
os.makedirs(pdir)
for n in ["glob[1].parquet", "star*.parquet", "q?.parquet", "pct%20.parquet", "hash#1.parquet",
          "sp ace.parquet", "日本語ファイル.parquet", "UPPER.PARQUET", "curly{a,b}.parquet", "plus+sign.parquet", "quote'single.parquet"]:
    pq.write_table(small, os.path.join(pdir, n))
os.makedirs(os.path.join(pdir, "dir with space"))
pq.write_table(small, os.path.join(pdir, "dir with space", "inner.parquet"))
os.makedirs(os.path.join(pdir, "folder.parquet"))
os.symlink("/nonexistent/target.parquet", os.path.join(pdir, "broken_link.parquet"))
os.symlink(os.path.join(OUT, "one_row.parquet"), os.path.join(pdir, "good_link.parquet"))
os.makedirs(os.path.join(pdir, "noperm"))
pq.write_table(small, os.path.join(pdir, "noperm", "hidden.parquet"))
os.chmod(os.path.join(pdir, "noperm"), 0o000)
print("done")
