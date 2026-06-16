// Llegeix els bytes d'un fitxer pel seu camí absolut (per carregar àudio
// des de rutes guardades a la Library, sense les restriccions d'scope del
// plugin fs). Retorna els bytes en brut (ArrayBuffer al costat JS) o un error.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("No s'ha pogut llegir {}: {}", path, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file_bytes])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
