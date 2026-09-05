//! The one-time purchase.
//!
//! The Mac App Store build is free to download and always usable; the free
//! tier is limited by feature, and a non-consumable in-app purchase unlocks
//! it for good (decisions in #5 / #22, the model TablePlus uses). There is
//! no trial and no clock: the state is "does the account own
//! [`PRODUCT_FULL`]".
//!
//! [`License`] is the one place that knows the state. It keeps a snapshot
//! of the account's entitlements (from `Transaction.currentEntitlements`,
//! refreshed after every purchase / restore and on every
//! `Transaction.updates` event — a refund arrives that way and locks the
//! app back down) and derives [`IapStatus`] from it. The backend enforces
//! nothing: it has no notion of a tab, so the free tier's limit (the number
//! of tabs open at once) lives in the webview, with `iap_status` as its
//! only source of truth for "unlocked". A client-side limit is bypassable
//! by anyone willing to patch a signed, sandboxed bundle — the trade a
//! one-time-purchase utility makes; do not "fix" it by inventing a tab
//! count in Rust.
//!
//! The App Store calls sit behind [`StoreProvider`]. `storekit::SwiftStore`
//! (compiled with the `app-store` Cargo feature, on macOS) is the real one;
//! [`AlwaysUnlocked`] serves every other build — `cargo test --lib`, the e2e
//! bridge, `pnpm tauri dev`, Windows / Linux — by owning the full version.
//! The state is unit-tested with a fake provider.
//!
//! The product id is a constant here and nowhere else; the webview buys by
//! the id [`License::products`] returned. It does not depend on the bundle
//! identifier. Price, name and description come from App Store Connect.

#[cfg(all(feature = "app-store", target_os = "macos"))]
pub mod storekit;

use crate::models::{IapProduct, IapPurchaseOutcome, IapPurchaseResult, IapState, IapStatus};
use serde::Deserialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// The non-consumable that unlocks the app for good.
pub const PRODUCT_FULL: &str = "parqsee.full";
/// Everything the store is asked for.
pub const PRODUCT_IDS: [&str; 1] = [PRODUCT_FULL];

/// How long a status request waits for the launch-time entitlement read
/// before reporting the store as unreachable.
const INIT_TIMEOUT: Duration = Duration::from_secs(20);

/// One product the account owns, as StoreKit reports it. The dates are
/// what the bridge sends; nothing here depends on them any more.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Entitlement {
    pub product_id: String,
    /// Unix milliseconds.
    pub original_purchase_date: i64,
    pub purchase_date: i64,
}

/// A product as the store describes it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StoreProduct {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub display_price: String,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Receives the full current entitlements after each transaction update.
pub type UpdateSink = Box<dyn Fn(Vec<Entitlement>) + Send + Sync>;

/// The App Store primitives the license needs.
pub trait StoreProvider: Send + Sync {
    /// The products the store knows among `ids`, in the user's storefront.
    fn load_products<'a>(&'a self, ids: &'a [&'a str]) -> BoxFuture<'a, Result<Vec<StoreProduct>, String>>;
    /// Buy `id`; a purchase that went through is finished before this resolves.
    fn purchase<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<IapPurchaseOutcome, String>>;
    /// Restore Purchases: fetch the account's transactions again.
    fn restore(&self) -> BoxFuture<'_, Result<(), String>>;
    /// What the account owns right now.
    fn entitlements(&self) -> BoxFuture<'_, Result<Vec<Entitlement>, String>>;
    /// Start delivering transaction updates to `sink` for the rest of the
    /// process. Called once.
    fn start_updates(&self, sink: UpdateSink);
}

/// The provider of every build that has no store: it owns the full version.
/// Buying and restoring are refused with a message the settings screen can
/// show.
pub struct AlwaysUnlocked;

impl StoreProvider for AlwaysUnlocked {
    fn load_products<'a>(&'a self, _ids: &'a [&'a str]) -> BoxFuture<'a, Result<Vec<StoreProduct>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn purchase<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<IapPurchaseOutcome, String>> {
        Box::pin(async { Err(NOT_AVAILABLE.to_string()) })
    }
    fn restore(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err(NOT_AVAILABLE.to_string()) })
    }
    fn entitlements(&self) -> BoxFuture<'_, Result<Vec<Entitlement>, String>> {
        Box::pin(async {
            Ok(vec![Entitlement { product_id: PRODUCT_FULL.to_string(), original_purchase_date: 0, purchase_date: 0 }])
        })
    }
    fn start_updates(&self, _sink: UpdateSink) {}
}

const NOT_AVAILABLE: &str = "Purchases are not available in this build";

/// What the license last learned from the store.
#[derive(Debug, Clone, Default)]
struct Snapshot {
    entitlements: Vec<Entitlement>,
    /// The failure of the read that produced this snapshot; the app is on
    /// the free tier while it is set, and says why.
    error: Option<String>,
}

/// Derive the status from what the account owns: unlocked when the full
/// version is among the entitlements, free otherwise.
pub fn derive_status(entitlements: &[Entitlement], store_error: Option<String>) -> IapStatus {
    let state = if entitlements.iter().any(|e| e.product_id == PRODUCT_FULL) {
        IapState::Unlocked
    } else {
        IapState::Free
    };
    IapStatus { state, store_error }
}

/// Tauri managed state (as `Arc<License>`). See the module docs.
pub struct License {
    provider: Box<dyn StoreProvider>,
    snapshot: watch::Sender<Option<Snapshot>>,
    on_change: Mutex<Option<Box<dyn Fn(IapStatus) + Send + Sync>>>,
}

impl License {
    pub fn new(provider: Box<dyn StoreProvider>) -> Self {
        let (snapshot, _) = watch::channel(None);
        Self { provider, snapshot, on_change: Mutex::new(None) }
    }

    /// Called with the new status after every transaction update the
    /// store pushes (a purchase finished elsewhere, a refund); `lib.rs`
    /// forwards it to the webview as the `iap-status` event.
    pub fn set_on_change(&self, f: Box<dyn Fn(IapStatus) + Send + Sync>) {
        *self.on_change.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// Read the entitlements once and subscribe to updates. Until this has
    /// run, `status` waits (up to `INIT_TIMEOUT`).
    pub async fn init(self: &Arc<Self>) {
        self.refresh().await;
        let weak = Arc::downgrade(self);
        self.provider.start_updates(Box::new(move |entitlements| {
            if let Some(license) = weak.upgrade() {
                license.apply(Snapshot { entitlements, error: None });
                let status = license.status_now();
                if let Some(f) = license.on_change.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
                    f(status);
                }
            }
        }));
    }

    /// Replace the snapshot with a fresh read of the entitlements. A read
    /// that fails leaves the app on the free tier (empty entitlements plus
    /// the error) rather than keeping a state the store no longer vouches for.
    async fn refresh(&self) {
        let snapshot = match self.provider.entitlements().await {
            Ok(entitlements) => Snapshot { entitlements, error: None },
            Err(error) => Snapshot { entitlements: Vec::new(), error: Some(error) },
        };
        self.apply(snapshot);
    }

    fn apply(&self, snapshot: Snapshot) {
        self.snapshot.send_replace(Some(snapshot));
    }

    /// The status from the current snapshot, without waiting for `init`.
    fn status_now(&self) -> IapStatus {
        let snapshot = self.snapshot.borrow().clone().unwrap_or_default();
        derive_status(&snapshot.entitlements, snapshot.error)
    }

    /// The current status; waits for the launch-time read to finish.
    pub async fn status(&self) -> IapStatus {
        let mut rx = self.snapshot.subscribe();
        let ready = tokio::time::timeout(INIT_TIMEOUT, rx.wait_for(|s| s.is_some())).await;
        match ready {
            Ok(Ok(_)) => self.status_now(),
            _ => derive_status(&[], Some("the App Store did not answer in time".to_string())),
        }
    }

    /// The full version as the store describes it (one product, or none in
    /// a build without a store); anything else the store returns is dropped.
    pub async fn products(&self) -> Result<Vec<IapProduct>, String> {
        let products = self.provider.load_products(&PRODUCT_IDS).await?;
        Ok(products
            .into_iter()
            .filter(|p| PRODUCT_IDS.contains(&p.id.as_str()))
            .map(|p| IapProduct {
                id: p.id,
                display_name: p.display_name,
                description: p.description,
                display_price: p.display_price,
            })
            .collect())
    }

    /// Buy a product; the returned status already reflects a purchase that
    /// went through.
    pub async fn purchase(&self, product_id: &str) -> Result<IapPurchaseResult, String> {
        if !PRODUCT_IDS.contains(&product_id) {
            return Err(format!("unknown product {product_id}"));
        }
        let outcome = self.provider.purchase(product_id).await?;
        if outcome == IapPurchaseOutcome::Purchased {
            self.refresh().await;
        }
        Ok(IapPurchaseResult { outcome, status: self.status().await })
    }

    /// Restore Purchases, then re-read what the account owns.
    pub async fn restore(&self) -> Result<IapStatus, String> {
        self.provider.restore().await?;
        self.refresh().await;
        Ok(self.status().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn full() -> Entitlement {
        Entitlement { product_id: PRODUCT_FULL.into(), original_purchase_date: T0, purchase_date: T0 }
    }
    fn other(id: &str) -> Entitlement {
        Entitlement { product_id: id.into(), original_purchase_date: T0, purchase_date: T0 }
    }

    #[test]
    fn nothing_owned_is_free() {
        let s = derive_status(&[], None);
        assert_eq!((s.state, s.store_error), (IapState::Free, None));
    }

    #[test]
    fn owning_the_full_version_is_unlocked_whatever_else_is_owned() {
        assert_eq!(derive_status(&[full()], None).state, IapState::Unlocked);
        assert_eq!(derive_status(&[other("parqsee.trial14"), full()], None).state, IapState::Unlocked);
        // A product this build does not know does not unlock anything.
        assert_eq!(derive_status(&[other("parqsee.trial14")], None).state, IapState::Free);
    }

    /// A store whose answers the test sets, and that hands out its update sink.
    struct FakeStore {
        entitlements: Mutex<Result<Vec<Entitlement>, String>>,
        purchase: Mutex<Result<IapPurchaseOutcome, String>>,
        restore_fails: Mutex<Option<String>>,
        sink: Mutex<Option<Arc<UpdateSink>>>,
        purchased: Mutex<Vec<String>>,
    }

    impl StoreProvider for FakeStore {
        fn load_products<'a>(&'a self, ids: &'a [&'a str]) -> BoxFuture<'a, Result<Vec<StoreProduct>, String>> {
            Box::pin(async move {
                Ok(ids
                    .iter()
                    .map(|id| StoreProduct {
                        id: id.to_string(),
                        display_name: format!("name of {id}"),
                        description: String::new(),
                        display_price: "¥1,500".into(),
                    })
                    .chain(std::iter::once(StoreProduct {
                        id: "parqsee.unknown".into(),
                        display_name: "stray".into(),
                        description: String::new(),
                        display_price: "¥1".into(),
                    }))
                    .collect())
            })
        }
        fn purchase<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<IapPurchaseOutcome, String>> {
            Box::pin(async move {
                let outcome = self.purchase.lock().unwrap().clone()?;
                if outcome == IapPurchaseOutcome::Purchased {
                    self.purchased.lock().unwrap().push(id.to_string());
                    let bought = Entitlement { product_id: id.into(), original_purchase_date: T0, purchase_date: T0 };
                    if let Ok(list) = self.entitlements.lock().unwrap().as_mut() {
                        list.push(bought);
                    }
                }
                Ok(outcome)
            })
        }
        fn restore(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                match self.restore_fails.lock().unwrap().clone() {
                    Some(e) => Err(e),
                    None => Ok(()),
                }
            })
        }
        fn entitlements(&self) -> BoxFuture<'_, Result<Vec<Entitlement>, String>> {
            Box::pin(async move { self.entitlements.lock().unwrap().clone() })
        }
        fn start_updates(&self, sink: UpdateSink) {
            *self.sink.lock().unwrap() = Some(Arc::new(sink));
        }
    }

    struct Harness {
        store: Arc<FakeStore>,
        license: Arc<License>,
        changes: Arc<Mutex<Vec<IapStatus>>>,
    }

    /// A shared handle to the fake so the test can change its answers
    /// after the license took ownership of a provider.
    struct Shared(Arc<FakeStore>);
    impl StoreProvider for Shared {
        fn load_products<'a>(&'a self, ids: &'a [&'a str]) -> BoxFuture<'a, Result<Vec<StoreProduct>, String>> {
            self.0.load_products(ids)
        }
        fn purchase<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<IapPurchaseOutcome, String>> {
            self.0.purchase(id)
        }
        fn restore(&self) -> BoxFuture<'_, Result<(), String>> {
            self.0.restore()
        }
        fn entitlements(&self) -> BoxFuture<'_, Result<Vec<Entitlement>, String>> {
            self.0.entitlements()
        }
        fn start_updates(&self, sink: UpdateSink) {
            self.0.start_updates(sink)
        }
    }

    async fn harness(entitlements: Result<Vec<Entitlement>, String>) -> Harness {
        let store = Arc::new(FakeStore {
            entitlements: Mutex::new(entitlements),
            purchase: Mutex::new(Ok(IapPurchaseOutcome::Purchased)),
            restore_fails: Mutex::new(None),
            sink: Mutex::new(None),
            purchased: Mutex::new(Vec::new()),
        });
        let license = Arc::new(License::new(Box::new(Shared(Arc::clone(&store)))));
        let changes = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&changes);
        license.set_on_change(Box::new(move |s| seen.lock().unwrap().push(s)));
        license.init().await;
        Harness { store, license, changes }
    }

    impl Harness {
        /// What StoreKit does on `Transaction.updates`.
        fn push_update(&self, entitlements: Vec<Entitlement>) {
            let sink = self.store.sink.lock().unwrap().clone().expect("init subscribed to updates");
            sink(entitlements);
        }
    }

    #[tokio::test]
    async fn free_until_the_full_version_is_bought() {
        let h = harness(Ok(vec![])).await;
        assert_eq!(h.license.status().await.state, IapState::Free);

        let r = h.license.purchase(PRODUCT_FULL).await.unwrap();
        assert_eq!(r.outcome, IapPurchaseOutcome::Purchased);
        assert_eq!(r.status.state, IapState::Unlocked);
        assert_eq!(h.license.status().await.state, IapState::Unlocked);
        assert_eq!(*h.store.purchased.lock().unwrap(), vec![PRODUCT_FULL]);
    }

    #[tokio::test]
    async fn a_cancelled_or_pending_purchase_changes_nothing() {
        let h = harness(Ok(vec![])).await;
        *h.store.purchase.lock().unwrap() = Ok(IapPurchaseOutcome::Cancelled);
        let r = h.license.purchase(PRODUCT_FULL).await.unwrap();
        assert_eq!((r.outcome, r.status.state), (IapPurchaseOutcome::Cancelled, IapState::Free));
        *h.store.purchase.lock().unwrap() = Ok(IapPurchaseOutcome::Pending);
        let r = h.license.purchase(PRODUCT_FULL).await.unwrap();
        assert_eq!((r.outcome, r.status.state), (IapPurchaseOutcome::Pending, IapState::Free));
        *h.store.purchase.lock().unwrap() = Err("network error".into());
        assert_eq!(h.license.purchase(PRODUCT_FULL).await.unwrap_err(), "network error");
        assert!(h.license.purchase("parqsee.trial14").await.unwrap_err().contains("unknown product"));
        assert_eq!(h.license.status().await.state, IapState::Free);
        assert!(h.store.purchased.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_transaction_update_changes_the_state_and_notifies() {
        let h = harness(Ok(vec![])).await;
        assert!(h.changes.lock().unwrap().is_empty());
        // A pending purchase approved elsewhere.
        h.push_update(vec![full()]);
        assert_eq!(h.license.status().await.state, IapState::Unlocked);
        let seen = h.changes.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].state, IapState::Unlocked);
        // A refund locks the app back down.
        h.push_update(vec![]);
        assert_eq!(h.license.status().await.state, IapState::Free);
        assert_eq!(h.changes.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn restore_rereads_the_entitlements() {
        let h = harness(Ok(vec![])).await;
        // The account owns the full version on another Mac.
        *h.store.entitlements.lock().unwrap() = Ok(vec![full()]);
        assert_eq!(h.license.status().await.state, IapState::Free);
        assert_eq!(h.license.restore().await.unwrap().state, IapState::Unlocked);

        *h.store.restore_fails.lock().unwrap() = Some("not signed in".into());
        assert_eq!(h.license.restore().await.unwrap_err(), "not signed in");
        assert_eq!(h.license.status().await.state, IapState::Unlocked);
    }

    #[tokio::test]
    async fn an_unreadable_store_is_free_with_the_reason_until_it_answers() {
        let h = harness(Err("no network".into())).await;
        let s = h.license.status().await;
        assert_eq!((s.state, s.store_error.as_deref()), (IapState::Free, Some("no network")));

        *h.store.entitlements.lock().unwrap() = Ok(vec![full()]);
        let s = h.license.restore().await.unwrap();
        assert_eq!((s.state, s.store_error), (IapState::Unlocked, None));
    }

    #[tokio::test]
    async fn a_purchase_owned_before_launch_is_read_at_init() {
        let h = harness(Ok(vec![full()])).await;
        assert_eq!(h.license.status().await.state, IapState::Unlocked);
    }

    #[tokio::test]
    async fn products_is_the_full_version_alone() {
        let h = harness(Ok(vec![])).await;
        let products = h.license.products().await.unwrap();
        let seen: Vec<_> = products.iter().map(|p| (p.id.as_str(), p.display_price.as_str())).collect();
        assert_eq!(seen, vec![(PRODUCT_FULL, "¥1,500")]);
    }

    #[tokio::test]
    async fn a_build_without_a_store_is_unlocked_and_sells_nothing() {
        let license = Arc::new(License::new(Box::new(AlwaysUnlocked)));
        license.init().await;
        assert_eq!(license.status().await.state, IapState::Unlocked);
        assert_eq!(license.products().await.unwrap(), vec![]);
        assert_eq!(license.purchase(PRODUCT_FULL).await.unwrap_err(), NOT_AVAILABLE);
        assert_eq!(license.restore().await.unwrap_err(), NOT_AVAILABLE);
    }

    #[tokio::test]
    async fn status_before_init_reports_the_wait_instead_of_hanging() {
        // Not initialised at all; the timeout would take INIT_TIMEOUT, so
        // only check that a snapshot arriving later unblocks the wait.
        let license = Arc::new(License::new(Box::new(AlwaysUnlocked)));
        let waiting = {
            let license = Arc::clone(&license);
            tokio::spawn(async move { license.status().await })
        };
        tokio::task::yield_now().await;
        license.init().await;
        assert_eq!(waiting.await.unwrap().state, IapState::Unlocked);
    }
}
