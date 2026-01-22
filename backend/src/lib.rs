pub mod commands;
pub mod models;
pub mod services;
pub mod utils;

use tauri::{DragDropEvent, Emitter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::open_parquet_file,
            commands::file::get_file_info,
            commands::file::check_file_exists,
            commands::file::list_directory,
            commands::data::read_parquet_data,
            commands::data::export_data
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    println!("Files dropped: {:?}", paths);
                    // Send event to frontend
                    window.emit("file-drop", paths).unwrap();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
