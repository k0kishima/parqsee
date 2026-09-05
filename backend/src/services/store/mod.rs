//! The trial and the one-time purchase.
//!
//! The Mac App Store build is free to download, usable for a trial period,
//! and unlocked for good by a non-consumable in-app purchase; after the
//! trial, without the purchase, it is locked (App Store Review Guideline
//! 3.1.1, decisions in #5 / #15). The trial itself is a $0 non-consumable
//! ("14-day Trial"): its purchase date lives in the Apple account's
//! history, so deleting the app does not restart it.
//!
//! [`License`] is the one place that knows the state. It keeps a snapshot
//! of the account's entitlements (from `Transaction.currentEntitlements`,
//! refreshed after every purchase / restore and on every
//! `Transaction.updates` event) and derives [`IapStatus`] from that
//! snapshot and the clock on every call — so a running app crosses from
//! `trial` to `trial_expired` without being told. The commands that read
//! rows (`read_parquet_data`, `count_parquet_data`, `execute_sql`,
//! `export_data`) call [`License::require_unlocked`] first; the webview
//! only renders the state and has no way to lift the lock.
//!
//! The App Store calls sit behind [`StoreProvider`]. `storekit::SwiftStore`
//! (compiled with the `app-store` Cargo feature, on macOS) is the real one;
//! [`AlwaysUnlocked`] serves every other build — `cargo test --lib`, the e2e
//! bridge, `pnpm tauri dev`, Windows / Linux — by owning the full version.
//! The state machine is unit-tested with a fake provider and a fixed clock.
//!
//! Product ids are constants here and nowhere else; the webview asks for
//! products by [`IapProductKind`]. They do not depend on the bundle
//! identifier. Prices, names and descriptions come from App Store Connect
//! through [`License::products`].

#[cfg(all(feature = "app-store", target_os = "macos"))]
pub mod storekit;

use crate::models::{IapProduct, IapProductKind, IapPurchaseOutcome, IapPurchaseResult, IapState, IapStatus};
use serde::Deserialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

/// The $0 non-consumable whose purchase date starts the trial.
pub const PRODUCT_TRIAL: &str = "parqsee.trial14";
/// The non-consumable that unlocks the app for good.
pub const PRODUCT_FULL: &str = "parqsee.full";
/// Both, in the order the store is asked for them.
pub const PRODUCT_IDS: [&str; 2] = [PRODUCT_TRIAL, PRODUCT_FULL];
/// How long the trial lasts, counted from the trial item's original
/// purchase date on the device clock.
pub const TRIAL_DAYS: u32 = 14;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// How long a status request waits for the launch-time entitlement read
/// before reporting the store as unreachable.
const INIT_TIMEOUT: Duration = Duration::from_secs(20);

/// One product the account owns, as StoreKit reports it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Entitlement {
    pub product_id: String,
    /// Unix milliseconds. For the trial item this is when the trial began.
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
    /// The failure of the read that produced this snapshot; the app stays
    /// locked while it is set.
    error: Option<String>,
}

/// Milliseconds since the Unix epoch.
pub type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

fn system_clock() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Derive the status from what the account owns, at `now` (Unix ms). The
/// full version wins regardless of the trial; a trial counts from its
/// original purchase date and is over the moment `TRIAL_DAYS` have passed.
pub fn derive_status(entitlements: &[Entitlement], now: i64, store_error: Option<String>) -> IapStatus {
    let trial_ends_at = entitlements
        .iter()
        .find(|e| e.product_id == PRODUCT_TRIAL)
        .map(|e| e.original_purchase_date.saturating_add(TRIAL_DAYS as i64 * DAY_MS));
    let state = if entitlements.iter().any(|e| e.product_id == PRODUCT_FULL) {
        IapState::Unlocked
    } else {
        match trial_ends_at {
            Some(ends) if now < ends => IapState::Trial,
            Some(_) => IapState::TrialExpired,
            None => IapState::None,
        }
    };
    IapStatus { state, trial_ends_at, trial_days: TRIAL_DAYS, store_error }
}

/// The message a locked command fails with.
fn locked_message(status: &IapStatus) -> String {
    match (&status.store_error, status.state) {
        (Some(e), _) => format!("Parqsee could not check its purchase with the App Store: {e}"),
        (None, IapState::TrialExpired) => "The free trial has ended. Buy Parqsee to keep reading files.".to_string(),
        (None, _) => "Start the free trial or buy Parqsee to read files.".to_string(),
    }
}

/// Tauri managed state (as `Arc<License>`). See the module docs.
pub struct License {
    provider: Box<dyn StoreProvider>,
    snapshot: watch::Sender<Option<Snapshot>>,
    clock: Clock,
    on_change: Mutex<Option<Box<dyn Fn(IapStatus) + Send + Sync>>>,
}

impl License {
    pub fn new(provider: Box<dyn StoreProvider>) -> Self {
        Self::with_clock(provider, Box::new(system_clock))
    }

    pub fn with_clock(provider: Box<dyn StoreProvider>, clock: Clock) -> Self {
        let (snapshot, _) = watch::channel(None);
        Self { provider, snapshot, clock, on_change: Mutex::new(None) }
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
    /// that fails locks the app (empty entitlements plus the error) rather
    /// than keeping a state the store no longer vouches for.
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
        derive_status(&snapshot.entitlements, (self.clock)(), snapshot.error)
    }

    /// The current status; waits for the launch-time read to finish.
    pub async fn status(&self) -> IapStatus {
        let mut rx = self.snapshot.subscribe();
        let ready = tokio::time::timeout(INIT_TIMEOUT, rx.wait_for(|s| s.is_some())).await;
        match ready {
            Ok(Ok(_)) => self.status_now(),
            _ => derive_status(&[], (self.clock)(), Some("the App Store did not answer in time".to_string())),
        }
    }

    /// `Ok` while rows may be read (trial or unlocked); the reason otherwise.
    pub async fn require_unlocked(&self) -> Result<(), String> {
        let status = self.status().await;
        match status.state {
            IapState::Trial | IapState::Unlocked if status.store_error.is_none() => Ok(()),
            _ => Err(locked_message(&status)),
        }
    }

    /// The trial and full products as the store describes them; a build
    /// without a store returns none.
    pub async fn products(&self) -> Result<Vec<IapProduct>, String> {
        let products = self.provider.load_products(&PRODUCT_IDS).await?;
        Ok(products
            .into_iter()
            .filter_map(|p| {
                let kind = match p.id.as_str() {
                    PRODUCT_TRIAL => IapProductKind::Trial,
                    PRODUCT_FULL => IapProductKind::Full,
                    _ => return None,
                };
                Some(IapProduct {
                    id: p.id,
                    kind,
                    display_name: p.display_name,
                    description: p.description,
                    display_price: p.display_price,
                })
            })
            .collect())
    }

    /// Buy one of the two products; the returned status already reflects
    /// a purchase that went through.
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
    use std::sync::atomic::{AtomicI64, Ordering};

    const T0: i64 = 1_700_000_000_000;

    fn trial_at(ms: i64) -> Entitlement {
        Entitlement { product_id: PRODUCT_TRIAL.into(), original_purchase_date: ms, purchase_date: ms }
    }
    fn full_at(ms: i64) -> Entitlement {
        Entitlement { product_id: PRODUCT_FULL.into(), original_purchase_date: ms, purchase_date: ms }
    }

    #[test]
    fn nothing_owned_is_none() {
        let s = derive_status(&[], T0, None);
        assert_eq!(s.state, IapState::None);
        assert_eq!(s.trial_ends_at, None);
        assert_eq!(s.trial_days, TRIAL_DAYS);
    }

    #[test]
    fn the_trial_runs_from_its_original_purchase_date_for_trial_days() {
        let ends = T0 + 14 * DAY_MS;
        let s = derive_status(&[trial_at(T0)], T0, None);
        assert_eq!((s.state, s.trial_ends_at), (IapState::Trial, Some(ends)));
        let s = derive_status(&[trial_at(T0)], ends - 1, None);
        assert_eq!(s.state, IapState::Trial);
        let s = derive_status(&[trial_at(T0)], ends, None);
        assert_eq!((s.state, s.trial_ends_at), (IapState::TrialExpired, Some(ends)));
        let s = derive_status(&[trial_at(T0)], ends + 365 * DAY_MS, None);
        assert_eq!(s.state, IapState::TrialExpired);
    }

    #[test]
    fn the_full_version_wins_over_any_trial_state() {
        assert_eq!(derive_status(&[full_at(T0)], T0, None).state, IapState::Unlocked);
        assert_eq!(derive_status(&[trial_at(T0), full_at(T0 + DAY_MS)], T0 + 2 * DAY_MS, None).state, IapState::Unlocked);
        let s = derive_status(&[trial_at(T0), full_at(T0 + 20 * DAY_MS)], T0 + 30 * DAY_MS, None);
        assert_eq!(s.state, IapState::Unlocked);
        assert_eq!(s.trial_ends_at, Some(T0 + 14 * DAY_MS));
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
                        display_price: if *id == PRODUCT_TRIAL { "¥0".into() } else { "¥1,500".into() },
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
        now: Arc<AtomicI64>,
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
        let now = Arc::new(AtomicI64::new(T0));
        let clock_now = Arc::clone(&now);
        let license = Arc::new(License::with_clock(
            Box::new(Shared(Arc::clone(&store))),
            Box::new(move || clock_now.load(Ordering::SeqCst)),
        ));
        let changes = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&changes);
        license.set_on_change(Box::new(move |s| seen.lock().unwrap().push(s)));
        license.init().await;
        Harness { store, license, now, changes }
    }

    impl Harness {
        fn advance_days(&self, days: i64) {
            self.now.fetch_add(days * DAY_MS, Ordering::SeqCst);
        }
        /// What StoreKit does on `Transaction.updates`.
        fn push_update(&self, entitlements: Vec<Entitlement>) {
            let sink = self.store.sink.lock().unwrap().clone().expect("init subscribed to updates");
            sink(entitlements);
        }
    }

    #[tokio::test]
    async fn none_to_trial_to_expired_to_unlocked() {
        let h = harness(Ok(vec![])).await;
        assert_eq!(h.license.status().await.state, IapState::None);
        assert!(h.license.require_unlocked().await.unwrap_err().contains("Start the free trial"));

        let r = h.license.purchase(PRODUCT_TRIAL).await.unwrap();
        assert_eq!(r.outcome, IapPurchaseOutcome::Purchased);
        assert_eq!(r.status.state, IapState::Trial);
        assert_eq!(r.status.trial_ends_at, Some(T0 + 14 * DAY_MS));
        assert_eq!(h.license.require_unlocked().await, Ok(()));

        h.advance_days(13);
        assert_eq!(h.license.status().await.state, IapState::Trial);
        h.advance_days(2);
        // No refresh, no update: the clock alone flips the state.
        assert_eq!(h.license.status().await.state, IapState::TrialExpired);
        assert!(h.license.require_unlocked().await.unwrap_err().contains("trial has ended"));

        let r = h.license.purchase(PRODUCT_FULL).await.unwrap();
        assert_eq!(r.status.state, IapState::Unlocked);
        assert_eq!(h.license.require_unlocked().await, Ok(()));
        assert_eq!(*h.store.purchased.lock().unwrap(), vec![PRODUCT_TRIAL, PRODUCT_FULL]);
    }

    #[tokio::test]
    async fn none_straight_to_unlocked() {
        let h = harness(Ok(vec![])).await;
        let r = h.license.purchase(PRODUCT_FULL).await.unwrap();
        assert_eq!(r.status.state, IapState::Unlocked);
        assert_eq!(r.status.trial_ends_at, None);
    }

    #[tokio::test]
    async fn a_cancelled_or_pending_purchase_changes_nothing() {
        let h = harness(Ok(vec![])).await;
        *h.store.purchase.lock().unwrap() = Ok(IapPurchaseOutcome::Cancelled);
        let r = h.license.purchase(PRODUCT_FULL).await.unwrap();
        assert_eq!((r.outcome, r.status.state), (IapPurchaseOutcome::Cancelled, IapState::None));
        *h.store.purchase.lock().unwrap() = Ok(IapPurchaseOutcome::Pending);
        let r = h.license.purchase(PRODUCT_FULL).await.unwrap();
        assert_eq!((r.outcome, r.status.state), (IapPurchaseOutcome::Pending, IapState::None));
        *h.store.purchase.lock().unwrap() = Err("network error".into());
        assert_eq!(h.license.purchase(PRODUCT_FULL).await.unwrap_err(), "network error");
        assert!(h.license.purchase("parqsee.other").await.unwrap_err().contains("unknown product"));
        assert_eq!(h.license.status().await.state, IapState::None);
    }

    #[tokio::test]
    async fn a_transaction_update_changes_the_state_and_notifies() {
        let h = harness(Ok(vec![])).await;
        assert!(h.changes.lock().unwrap().is_empty());
        // A pending purchase approved elsewhere.
        h.push_update(vec![full_at(T0)]);
        assert_eq!(h.license.status().await.state, IapState::Unlocked);
        let seen = h.changes.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].state, IapState::Unlocked);
        // A refund.
        h.push_update(vec![]);
        assert_eq!(h.license.status().await.state, IapState::None);
        assert_eq!(h.changes.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn restore_rereads_the_entitlements() {
        let h = harness(Ok(vec![])).await;
        // The account owns the full version on another Mac.
        *h.store.entitlements.lock().unwrap() = Ok(vec![full_at(T0)]);
        assert_eq!(h.license.status().await.state, IapState::None);
        assert_eq!(h.license.restore().await.unwrap().state, IapState::Unlocked);

        *h.store.restore_fails.lock().unwrap() = Some("not signed in".into());
        assert_eq!(h.license.restore().await.unwrap_err(), "not signed in");
        assert_eq!(h.license.status().await.state, IapState::Unlocked);
    }

    #[tokio::test]
    async fn an_unreadable_store_locks_the_app_until_it_answers() {
        let h = harness(Err("no network".into())).await;
        let s = h.license.status().await;
        assert_eq!((s.state, s.store_error.as_deref()), (IapState::None, Some("no network")));
        assert!(h.license.require_unlocked().await.unwrap_err().contains("no network"));

        *h.store.entitlements.lock().unwrap() = Ok(vec![trial_at(T0)]);
        let s = h.license.restore().await.unwrap();
        assert_eq!((s.state, s.store_error), (IapState::Trial, None));
        assert_eq!(h.license.require_unlocked().await, Ok(()));
    }

    #[tokio::test]
    async fn a_trial_owned_before_launch_is_read_at_init() {
        let h = harness(Ok(vec![trial_at(T0 - 3 * DAY_MS)])).await;
        let s = h.license.status().await;
        assert_eq!((s.state, s.trial_ends_at), (IapState::Trial, Some(T0 + 11 * DAY_MS)));
    }

    #[tokio::test]
    async fn products_carry_their_kind_and_drop_strays() {
        let h = harness(Ok(vec![])).await;
        let products = h.license.products().await.unwrap();
        let kinds: Vec<_> = products.iter().map(|p| (p.id.as_str(), p.kind, p.display_price.as_str())).collect();
        assert_eq!(kinds, vec![(PRODUCT_TRIAL, IapProductKind::Trial, "¥0"), (PRODUCT_FULL, IapProductKind::Full, "¥1,500")]);
    }

    #[tokio::test]
    async fn a_build_without_a_store_is_unlocked_and_sells_nothing() {
        let license = Arc::new(License::new(Box::new(AlwaysUnlocked)));
        license.init().await;
        assert_eq!(license.status().await.state, IapState::Unlocked);
        assert_eq!(license.require_unlocked().await, Ok(()));
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
