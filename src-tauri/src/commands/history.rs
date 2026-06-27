use tauri::State;

use crate::api::DownloadHistory;
use crate::history::HistoryManager;
use crate::AppState;

#[tauri::command]
pub(crate) async fn get_history(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let history = HistoryManager::load();
    *state.history.lock().await = history;
    let history = state.history.lock().await;
    let items = history.get_all();
    Ok(serde_json::json!({
        "success": true,
        "items": items
    }))
}

#[tauri::command]
pub(crate) async fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    let mut history = state.history.lock().await;
    history.clear().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn delete_history(
    state: State<'_, AppState>,
    aweme_id: String,
) -> Result<(), String> {
    let mut history = state.history.lock().await;
    history.delete(&aweme_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn add_history(
    state: State<'_, AppState>,
    aweme_id: String,
    title: String,
    author: String,
    author_id: String,
    cover: String,
    file_path: String,
    media_type: String,
    file_size: u64,
) -> Result<(), String> {
    let mut history = state.history.lock().await;
    history
        .add(DownloadHistory {
            aweme_id,
            title,
            author,
            author_id,
            cover,
            file_path,
            media_type,
            file_size,
            create_time: chrono::Utc::now().timestamp(),
        })
        .map_err(|e| e.to_string())
}
