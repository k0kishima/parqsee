# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow>=17"]
# ///
"""Generate the sample file the app ships for people who have no Parquet
file at hand — App Store reviewers first of all (#16).

    uv run scripts/gen_sample.py [OUT_FILE]

OUT_FILE defaults to backend/resources/sample.parquet, which is bundled into
the app as `Contents/Resources/sample.parquet` (`bundle.resources` in
backend/tauri.conf.json) and opened from the Welcome screen. The result is
committed: the build must not depend on Python. Rerun this only to change
what the sample contains, then check the shape `cargo test --lib` pins
(backend/src/services/sample.rs) still holds.

The table is the orders of a fictional web shop: one row per order, a mix
of strings, integers, a decimal, floats, a date, a timestamp, a boolean and
columns with nulls, so filters and the SQL view have something to work with.
Seeded, so the file is the same on every machine. Three row groups, so
paging crosses a row-group boundary; zstd keeps it under 100 KB.
"""
import datetime
import decimal
import os
import random
import sys

import pyarrow as pa
import pyarrow.parquet as pq

OUT = os.path.abspath(
    sys.argv[1]
    if len(sys.argv) > 1
    else os.path.join(os.path.dirname(__file__), "..", "backend", "resources", "sample.parquet")
)
ROWS = 1500
ROW_GROUP_SIZE = 500
random.seed(20260905)

# (name, category, unit price)
PRODUCTS = [
    ("Ceramic Pour-Over Dripper", "Kitchen", "24.00"),
    ("Hand Grinder", "Kitchen", "58.50"),
    ("Insulated Travel Mug 350ml", "Kitchen", "19.90"),
    ("Cast Iron Skillet 26cm", "Kitchen", "42.00"),
    ("Linen Apron", "Kitchen", "31.00"),
    ("Merino Beanie", "Apparel", "27.00"),
    ("Waxed Canvas Tote", "Apparel", "64.00"),
    ("Wool Socks (3 pairs)", "Apparel", "22.50"),
    ("Rain Shell Jacket", "Apparel", "129.00"),
    ("A5 Dot Grid Notebook", "Stationery", "9.80"),
    ("Fountain Pen, fine nib", "Stationery", "38.00"),
    ("Washi Tape Set", "Stationery", "12.40"),
    ("Desk Calendar 2024", "Stationery", "14.00"),
    ("Bluetooth Speaker", "Electronics", "79.00"),
    ("USB-C Charger 65W", "Electronics", "45.00"),
    ("Mechanical Keyboard, 75%", "Electronics", "149.00"),
    ("Webcam 1080p", "Electronics", "59.00"),
    ("Yoga Mat 6mm", "Sports", "34.00"),
    ("Resistance Bands", "Sports", "16.50"),
    ("Running Cap", "Sports", "21.00"),
]
COUNTRIES = ["JP"] * 30 + ["US"] * 25 + ["DE"] * 12 + ["GB"] * 10 + ["FR"] * 8 + ["AU"] * 6 + ["CA"] * 5 + ["SG"] * 4
FIRST = ["Aiko", "Ben", "Chloe", "Daniel", "Emma", "Felix", "Grace", "Hana", "Ivan", "Julia", "Kenji", "Lena",
         "Marco", "Nora", "Oscar", "Priya", "Quinn", "Rin", "Sofia", "Tom", "Uma", "Victor", "Wei", "Yuki", "Zoe"]
LAST = ["Tanaka", "Smith", "Müller", "Dubois", "Sato", "Brown", "Rossi", "Kim", "Nguyen", "Garcia", "Ito",
        "Wilson", "Schmidt", "Lee", "Kobayashi", "Martin", "Silva", "Chen", "Yamamoto", "Taylor"]
STATUSES = ["delivered"] * 70 + ["shipped"] * 15 + ["processing"] * 8 + ["cancelled"] * 5 + ["returned"] * 2
NOTES = [
    "Gift wrap, no receipt",
    "Leave at the front desk",
    "Customer asked for a later delivery",
    "Replacement for order damaged in transit",
    "Ring the bell twice",
    "Deliver after 18:00",
]

START = datetime.date(2024, 1, 1)
DAYS = 366

order_id, order_date, shipped_at = [], [], []
customer, country, category, product = [], [], [], []
quantity, unit_price, discount_rate, total = [], [], [], []
status, is_gift, notes = [], [], []

for i in range(ROWS):
    date = START + datetime.timedelta(days=int(random.triangular(0, DAYS - 1, DAYS * 0.8)))
    name, cat, price = random.choice(PRODUCTS)
    qty = random.choices([1, 2, 3, 4, 5, 8, 12], weights=[60, 20, 8, 5, 3, 2, 2])[0]
    price_d = decimal.Decimal(price)
    discount = random.choice([None] * 7 + [0.05, 0.10, 0.15, 0.25])
    st = random.choice(STATUSES)
    gift = random.random() < 0.08

    gross = price_d * qty
    net = gross * (decimal.Decimal(1) - decimal.Decimal(str(discount))) if discount else gross

    order_id.append(100001 + i)
    order_date.append(date)
    if st in ("delivered", "shipped", "returned"):
        lead = datetime.timedelta(days=random.randint(0, 3), hours=random.randint(7, 20), minutes=random.randint(0, 59))
        shipped_at.append(datetime.datetime.combine(date, datetime.time(), tzinfo=datetime.timezone.utc) + lead)
    else:
        shipped_at.append(None)
    customer.append(f"{random.choice(FIRST)} {random.choice(LAST)}")
    country.append(random.choice(COUNTRIES))
    category.append(cat)
    product.append(name)
    quantity.append(qty)
    unit_price.append(price_d)
    discount_rate.append(discount)
    total.append(float(round(net, 2)))
    status.append(st)
    is_gift.append(gift)
    notes.append(random.choice(NOTES) if random.random() < 0.06 else None)

table = pa.table({
    "order_id": pa.array(order_id, pa.int64()),
    "order_date": pa.array(order_date, pa.date32()),
    "customer": pa.array(customer, pa.string()),
    "country": pa.array(country, pa.string()),
    "category": pa.array(category, pa.string()),
    "product": pa.array(product, pa.string()),
    "quantity": pa.array(quantity, pa.int32()),
    "unit_price": pa.array(unit_price, pa.decimal128(10, 2)),
    "discount_rate": pa.array(discount_rate, pa.float32()),
    "total": pa.array(total, pa.float64()),
    "status": pa.array(status, pa.string()),
    "is_gift": pa.array(is_gift, pa.bool_()),
    "shipped_at": pa.array(shipped_at, pa.timestamp("us", tz="UTC")),
    "notes": pa.array(notes, pa.string()),
})

os.makedirs(os.path.dirname(OUT), exist_ok=True)
pq.write_table(table, OUT, compression="zstd", row_group_size=ROW_GROUP_SIZE)
meta = pq.read_metadata(OUT)
print(f"wrote {OUT}: {meta.num_rows} rows, {meta.num_columns} columns, "
      f"{meta.num_row_groups} row groups, {os.path.getsize(OUT):,} bytes")
