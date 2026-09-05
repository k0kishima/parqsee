use crate::commands::guarded;
use crate::models::{IapProduct, IapPurchaseResult, IapStatus};
use crate::services::store::License;
use std::sync::Arc;

/// Whether the full version is owned. Waits for the launch-time read of
/// the entitlements, so the webview can decide its first render on it.
#[tauri::command]
pub async fn iap_status(license: tauri::State<'_, Arc<License>>) -> Result<IapStatus, String> {
    guarded("Checking the purchase", async { Ok(license.status().await) }).await
}

/// The full version with its storefront name and price (one product);
/// empty in a build without a store.
#[tauri::command]
pub async fn iap_products(license: tauri::State<'_, Arc<License>>) -> Result<Vec<IapProduct>, String> {
    guarded("Loading the products", license.products()).await
}

/// Buy a product by the id `iap_products` returned.
#[tauri::command]
pub async fn iap_purchase(
    license: tauri::State<'_, Arc<License>>,
    product_id: String,
) -> Result<IapPurchaseResult, String> {
    guarded("The purchase", license.purchase(&product_id)).await
}

/// Restore Purchases.
#[tauri::command]
pub async fn iap_restore(license: tauri::State<'_, Arc<License>>) -> Result<IapStatus, String> {
    guarded("Restoring purchases", license.restore()).await
}
