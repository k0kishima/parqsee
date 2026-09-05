use crate::commands::guarded;
use crate::models::{IapProduct, IapPurchaseResult, IapStatus};
use crate::services::store::License;
use std::sync::Arc;

/// Where the app stands with the trial and the purchase. Waits for the
/// launch-time read of the entitlements, so the webview can gate its first
/// render on it.
#[tauri::command]
pub async fn iap_status(license: tauri::State<'_, Arc<License>>) -> Result<IapStatus, String> {
    guarded("Checking the purchase", async { Ok(license.status().await) }).await
}

/// The trial and full products with their storefront names and prices;
/// empty in a build without a store.
#[tauri::command]
pub async fn iap_products(license: tauri::State<'_, Arc<License>>) -> Result<Vec<IapProduct>, String> {
    guarded("Loading the products", license.products()).await
}

/// Buy a product by the id `iap_products` returned. Starting the trial is
/// buying the $0 trial item.
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

/// Quit. The pre-trial screen and the paywall offer this so a locked app
/// never traps the user (the native ⌘Q works too; this backs the Escape
/// key and the close button).
#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}
