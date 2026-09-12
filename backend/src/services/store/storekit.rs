//! The StoreKit 2 bridge: `StoreProvider` over the C functions exported by
//! `backend/storekit` (built and linked by `build.rs` when the `app-store`
//! feature is on).
//!
//! Every Swift entry point returns at once and calls back later, from a
//! thread of Swift's cooperative pool, with either a JSON string or an
//! error string that are valid only during the callback. One-shot calls
//! hand the callback a boxed `oneshot::Sender` as `ctx` and reclaim it
//! there; the updates listener gets a leaked sink that lives as long as
//! the process. A panic must not unwind into Swift (it would abort), so
//! each callback body runs under `catch_unwind`.

use super::{BoxFuture, Entitlement, StoreProduct, StoreProvider, UpdateSink};
use crate::models::IapPurchaseOutcome;
use serde::Deserialize;
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use tokio::sync::oneshot;

type Callback = extern "C" fn(*mut c_void, *const c_char, *const c_char);

extern "C" {
    fn sk_load_products(ids_json: *const c_char, ctx: *mut c_void, cb: Callback);
    fn sk_purchase(id: *const c_char, ctx: *mut c_void, cb: Callback);
    fn sk_restore(ctx: *mut c_void, cb: Callback);
    fn sk_entitlements(ctx: *mut c_void, cb: Callback);
    fn sk_start_updates(ctx: *mut c_void, cb: Callback);
}

type Reply = oneshot::Sender<Result<String, String>>;

/// Copy the callback's strings out before they go away.
unsafe fn read_result(json: *const c_char, error: *const c_char) -> Result<String, String> {
    if !json.is_null() {
        Ok(CStr::from_ptr(json).to_string_lossy().into_owned())
    } else if !error.is_null() {
        Err(CStr::from_ptr(error).to_string_lossy().into_owned())
    } else {
        Err("the App Store bridge returned nothing".to_string())
    }
}

extern "C" fn reply_once(ctx: *mut c_void, json: *const c_char, error: *const c_char) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `ctx` is the `Box<Reply>` leaked by `call` for exactly this
        // callback, which Swift invokes once.
        let sender = unsafe { Box::from_raw(ctx as *mut Reply) };
        let value = unsafe { read_result(json, error) };
        // The awaiting future may be gone (the command was dropped); fine.
        let _ = sender.send(value);
    }));
    if outcome.is_err() {
        eprintln!("panic in the StoreKit reply callback was swallowed");
    }
}

/// Run one Swift call and await its single reply.
fn call(start: impl FnOnce(*mut c_void, Callback)) -> BoxFuture<'static, Result<String, String>> {
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
    start(ctx, reply_once);
    Box::pin(async move {
        rx.await
            .unwrap_or_else(|_| Err("the App Store bridge dropped the request".to_string()))
    })
}

fn parse<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|e| format!("unexpected answer from the App Store bridge: {e}"))
}

fn c_string(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "the value contains a NUL byte".to_string())
}

extern "C" fn on_update(ctx: *mut c_void, json: *const c_char, error: *const c_char) {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `ctx` is the `Box<UpdateSink>` leaked by `start_updates`;
        // it is never freed, so the reference is valid for every callback.
        let sink = unsafe { &*(ctx as *const UpdateSink) };
        match unsafe { read_result(json, error) }.and_then(|s| parse::<Vec<Entitlement>>(&s)) {
            Ok(entitlements) => sink(entitlements),
            Err(e) => eprintln!("ignoring a transaction update: {e}"),
        }
    }));
    if outcome.is_err() {
        eprintln!("panic in the StoreKit update callback was swallowed");
    }
}

#[derive(Deserialize)]
struct PurchaseReply {
    outcome: IapPurchaseOutcome,
}

/// The real store, on the Mac App Store build.
pub struct SwiftStore;

impl StoreProvider for SwiftStore {
    fn load_products<'a>(&'a self, ids: &'a [&'a str]) -> BoxFuture<'a, Result<Vec<StoreProduct>, String>> {
        Box::pin(async move {
            let ids_json = c_string(&serde_json::to_string(ids).map_err(|e| e.to_string())?)?;
            // SAFETY: the C string outlives the call; Swift copies it before returning.
            let reply = call(|ctx, cb| unsafe { sk_load_products(ids_json.as_ptr(), ctx, cb) }).await?;
            parse(&reply)
        })
    }

    fn purchase<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<IapPurchaseOutcome, String>> {
        Box::pin(async move {
            let id = c_string(id)?;
            let reply = call(|ctx, cb| unsafe { sk_purchase(id.as_ptr(), ctx, cb) }).await?;
            Ok(parse::<PurchaseReply>(&reply)?.outcome)
        })
    }

    fn restore(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            call(|ctx, cb| unsafe { sk_restore(ctx, cb) }).await?;
            Ok(())
        })
    }

    fn entitlements(&self) -> BoxFuture<'_, Result<Vec<Entitlement>, String>> {
        Box::pin(async move {
            let reply = call(|ctx, cb| unsafe { sk_entitlements(ctx, cb) }).await?;
            parse(&reply)
        })
    }

    fn start_updates(&self, sink: UpdateSink) {
        let ctx = Box::into_raw(Box::new(sink)) as *mut c_void;
        // SAFETY: `ctx` is leaked on purpose; see `on_update`.
        unsafe { sk_start_updates(ctx, on_update) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Exercise the real Swift entry point and detached-task callback without
    /// asking StoreKit or requiring a signed app / App Store account.
    #[tokio::test]
    async fn invalid_product_ids_round_trip_through_swift() {
        for raw in ["not JSON", "{}", "[1]"] {
            let ids = c_string(raw).unwrap();
            let reply = tokio::time::timeout(
                Duration::from_secs(5),
                call(|ctx, cb| unsafe { sk_load_products(ids.as_ptr(), ctx, cb) }),
            )
            .await
            .expect("Swift never called back");
            assert_eq!(reply.unwrap_err(), "product ids must be a JSON array of strings");
        }
    }

    /// Callback strings are borrowed only during the call. Parse after the
    /// source CString is dropped to check that Rust owns the copied payload.
    #[tokio::test]
    async fn callback_copies_and_parses_entitlements() {
        let reply = call(|ctx, cb| {
            let json = c_string(r#"[{"product_id":"parqsee.full","original_purchase_date":123,"purchase_date":456}]"#).unwrap();
            cb(ctx, json.as_ptr(), std::ptr::null());
        }).await.unwrap();
        let list: Vec<Entitlement> = parse(&reply).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].product_id, "parqsee.full");
        assert_eq!(list[0].original_purchase_date, 123);
        assert_eq!(list[0].purchase_date, 456);
    }

    #[tokio::test]
    async fn callback_without_a_payload_is_an_error() {
        let reply = call(|ctx, cb| cb(ctx, std::ptr::null(), std::ptr::null())).await;
        assert_eq!(reply.unwrap_err(), "the App Store bridge returned nothing");
    }

    /// Live StoreKit smoke tests are opt-in: an unsigned hosted runner is
    /// not guaranteed to receive a response from the App Store services.
    /// They retain strict timeouts when explicitly run in a store environment.
    #[tokio::test]
    #[ignore = "requires a working App Store environment; run explicitly with --ignored"]
    async fn entitlements_round_trip_through_swift() {
        let reply = tokio::time::timeout(Duration::from_secs(30), SwiftStore.entitlements())
            .await
            .expect("Swift never called back");
        match reply {
            Ok(list) => assert!(list.iter().all(|e| !e.product_id.is_empty())),
            Err(e) => assert!(!e.is_empty()),
        }
    }

    #[tokio::test]
    #[ignore = "requires a working App Store environment; run explicitly with --ignored"]
    async fn restore_round_trip_through_swift() {
        let reply = tokio::time::timeout(Duration::from_secs(30), SwiftStore.restore())
            .await
            .expect("Swift never called back");
        if let Err(e) = reply {
            assert!(!e.is_empty());
        }
    }

    #[tokio::test]
    #[ignore = "requires a working App Store environment; run explicitly with --ignored"]
    async fn products_of_an_unknown_store_come_back_as_a_list_or_an_error() {
        let reply = tokio::time::timeout(
            Duration::from_secs(30),
            SwiftStore.load_products(&["parqsee.does-not-exist"]),
        )
        .await
        .expect("Swift never called back");
        match reply {
            Ok(list) => assert!(list.is_empty()),
            Err(e) => assert!(!e.is_empty()),
        }
    }
}
