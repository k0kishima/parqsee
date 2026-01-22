use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, NaiveDate, NaiveTime};
use parquet::record::{Field, Row};
use serde_json::Value;

pub fn row_to_json(row: &Row) -> Value {
    let mut map = serde_json::Map::new();

    for (name, value) in row.get_column_iter() {
        let json_value = field_to_json(value);
        map.insert(name.clone(), json_value);
    }

    Value::Object(map)
}

pub fn field_to_json(field: &Field) -> Value {
    match field {
        Field::Bool(v) => Value::Bool(*v),
        Field::Byte(v) => Value::Number((*v).into()),
        Field::Short(v) => Value::Number((*v).into()),
        Field::Int(v) => Value::Number((*v).into()),
        Field::Long(v) => Value::Number((*v).into()),
        Field::UByte(v) => Value::Number((*v).into()),
        Field::UShort(v) => Value::Number((*v).into()),
        Field::UInt(v) => Value::Number((*v).into()),
        Field::ULong(v) => Value::Number((*v).into()),
        Field::Float(v) => Value::Number(
            serde_json::Number::from_f64(*v as f64).unwrap_or(serde_json::Number::from(0)),
        ),
        Field::Double(v) => {
            Value::Number(serde_json::Number::from_f64(*v).unwrap_or(serde_json::Number::from(0)))
        }
        Field::Decimal(d) => Value::String(format!("{:?}", d)),
        Field::Str(v) => Value::String(v.clone()),
        Field::Bytes(v) => Value::String(general_purpose::STANDARD.encode(v.data())),
        Field::Date(v) => {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
            let date = epoch + chrono::Duration::days(*v as i64);
            Value::String(date.format("%Y-%m-%d").to_string())
        }
        Field::TimestampMillis(v) => {
            let seconds = v / 1000;
            let nanos = ((v % 1000) * 1_000_000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                Value::String(dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
            } else {
                Value::Number((*v).into())
            }
        }
        Field::TimestampMicros(v) => {
            let seconds = v / 1_000_000;
            let nanos = ((v % 1_000_000) * 1000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                Value::String(dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
            } else {
                Value::Number((*v).into())
            }
        }
        Field::TimeMillis(v) => {
            let hours = v / (60 * 60 * 1000);
            let minutes = (v % (60 * 60 * 1000)) / (60 * 1000);
            let seconds = (v % (60 * 1000)) / 1000;
            let millis = v % 1000;
            if let Some(time) = NaiveTime::from_hms_milli_opt(
                hours as u32,
                minutes as u32,
                seconds as u32,
                millis as u32,
            ) {
                Value::String(time.format("%H:%M:%S%.3f").to_string())
            } else {
                Value::Number((*v).into())
            }
        }
        Field::TimeMicros(v) => {
            let hours = v / (60 * 60 * 1_000_000);
            let minutes = (v % (60 * 60 * 1_000_000)) / (60 * 1_000_000);
            let seconds = (v % (60 * 1_000_000)) / 1_000_000;
            let micros = v % 1_000_000;
            if let Some(time) = NaiveTime::from_hms_micro_opt(
                hours as u32,
                minutes as u32,
                seconds as u32,
                micros as u32,
            ) {
                Value::String(time.format("%H:%M:%S%.6f").to_string())
            } else {
                Value::Number((*v).into())
            }
        }
        Field::Float16(v) => Value::Number(
            serde_json::Number::from_f64(v.to_f64()).unwrap_or(serde_json::Number::from(0)),
        ),
        Field::Group(g) => row_to_json(g),
        Field::ListInternal(list) => {
            let items: Vec<Value> = list.elements().iter().map(|f| field_to_json(f)).collect();
            Value::Array(items)
        }
        Field::MapInternal(map_field) => {
            let mut json_map = serde_json::Map::new();
            for (k, v) in map_field.entries() {
                json_map.insert(field_to_json(k).to_string(), field_to_json(v));
            }
            Value::Object(json_map)
        }
        Field::Null => Value::Null,
    }
}

pub fn field_to_string(field: &Field) -> String {
    match field {
        Field::Bool(v) => v.to_string(),
        Field::Byte(v) => v.to_string(),
        Field::Short(v) => v.to_string(),
        Field::Int(v) => v.to_string(),
        Field::Long(v) => v.to_string(),
        Field::UByte(v) => v.to_string(),
        Field::UShort(v) => v.to_string(),
        Field::UInt(v) => v.to_string(),
        Field::ULong(v) => v.to_string(),
        Field::Float(v) => v.to_string(),
        Field::Double(v) => v.to_string(),
        Field::Decimal(d) => format!("{:?}", d),
        Field::Str(v) => v.clone(),
        Field::Bytes(v) => general_purpose::STANDARD.encode(v.data()),
        Field::Date(v) => {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
            let date = epoch + chrono::Duration::days(*v as i64);
            date.format("%Y-%m-%d").to_string()
        }
        Field::TimestampMillis(v) => {
            let seconds = v / 1000;
            let nanos = ((v % 1000) * 1_000_000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
            } else {
                v.to_string()
            }
        }
        Field::TimestampMicros(v) => {
            let seconds = v / 1_000_000;
            let nanos = ((v % 1_000_000) * 1000) as u32;
            if let Some(dt) = DateTime::from_timestamp(seconds, nanos) {
                dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
            } else {
                v.to_string()
            }
        }
        Field::TimeMillis(v) => {
            let hours = v / (60 * 60 * 1000);
            let minutes = (v % (60 * 60 * 1000)) / (60 * 1000);
            let seconds = (v % (60 * 1000)) / 1000;
            let millis = v % 1000;
            if let Some(time) = NaiveTime::from_hms_milli_opt(
                hours as u32,
                minutes as u32,
                seconds as u32,
                millis as u32,
            ) {
                time.format("%H:%M:%S%.3f").to_string()
            } else {
                v.to_string()
            }
        }
        Field::TimeMicros(v) => {
            let hours = v / (60 * 60 * 1_000_000);
            let minutes = (v % (60 * 60 * 1_000_000)) / (60 * 1_000_000);
            let seconds = (v % (60 * 1_000_000)) / 1_000_000;
            let micros = v % 1_000_000;
            if let Some(time) = NaiveTime::from_hms_micro_opt(
                hours as u32,
                minutes as u32,
                seconds as u32,
                micros as u32,
            ) {
                time.format("%H:%M:%S%.6f").to_string()
            } else {
                v.to_string()
            }
        }
        Field::Float16(v) => v.to_f64().to_string(),
        Field::Group(_) => "[GROUP]".to_string(),
        Field::ListInternal(_) => "[LIST]".to_string(),
        Field::MapInternal(_) => "[MAP]".to_string(),
        Field::Null => "".to_string(),
    }
}
