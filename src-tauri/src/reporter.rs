use serde_json::json;
use std::time::Duration;

const REPORT_SERVER_URL: &str = "http://47.109.40.237:12345/api/report";

pub fn report_event(
    event_type: String,
    message: String,
    extra_data: Option<serde_json::Value>,
    stack_trace: Option<String>,
) {
    // Spawns an async tokio task to send the report
    tokio::spawn(async move {
        let app_version = env!("CARGO_PKG_VERSION").to_string();

        let payload = json!({
            "app_type": "better-douyin-rust",
            "app_version": app_version,
            "event_type": event_type,
            "message": message,
            "stack_trace": stack_trace,
            "extra_data": extra_data.unwrap_or(json!({}))
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build();

        if let Ok(client) = client {
            if let Err(e) = client.post(REPORT_SERVER_URL).json(&payload).send().await {
                log::debug!("Failed to send report to server: {}", e);
            }
        }
    });
}
