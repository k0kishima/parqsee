use crate::commands::guarded;

/// Put the native menu into the language the UI is in.
///
/// The menu is built in `setup`, long before the webview exists, so it
/// starts in the system's language (`menu::system_language`) and this
/// corrects it: the webview calls it once its settings are loaded and
/// again whenever the language changes. Calling it with the language the
/// menu is already in does nothing, which is the usual case at launch.
///
/// Nothing to do on a platform without a menu; the webview calls it
/// there too rather than knowing which platforms have one.
#[tauri::command]
pub async fn set_menu_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    guarded("Setting the menu language", async move {
        #[cfg(target_os = "macos")]
        crate::menu::set_language(&app, &language);
        #[cfg(not(target_os = "macos"))]
        let _ = (&app, &language);
        Ok(())
    })
    .await
}
