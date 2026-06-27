//! 内容客户端逻辑 - 视频、用户、合集、推荐

use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use regex::Regex;

use super::client::DouyinClient;
use super::types::*;
use crate::config::get_user_agent;
use crate::sign;

static SHARE_URL_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https?://[^\s<>"']+|www\.[^\s<>"']+"#).unwrap());
static AWEME_ID_DIGIT_REGEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+$").unwrap());
static AWEME_ID_PATTERNS: &[&str] = &[
    r"video/(\d+)",
    r"note/(\d+)",
    r"aweme_id=(\d+)",
    r"modal_id=(\d+)",
    r"/(\d{18,21})",
];
static AWEME_ID_REGEXES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    AWEME_ID_PATTERNS
        .iter()
        .filter_map(|p| Regex::new(p).ok())
        .collect()
});

fn looks_watermarked_media_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("watermark=1") || lower.contains("playwm") || lower.contains("logo_name=")
}

fn is_dash_video_only_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("media-video") || lower.contains("media_video")
}

fn normalize_recommended_feed_type(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "recommended" | "recommend" | "tab" | "home" | "feed" => "recommended",
        _ => "featured",
    }
}

fn is_valid_recommended_video(video: &VideoInfo) -> bool {
    !video.aweme_id.trim().is_empty()
        && !video.video.play_addr.trim().is_empty()
        && !video.video.cover.trim().is_empty()
        && (!video.author.sec_uid.trim().is_empty()
            || !video.author.uid.trim().is_empty()
            || !video.author.nickname.trim().is_empty())
}

fn clean_video_media_url(url: &str) -> String {
    url.trim()
        .replace("watermark=1", "watermark=0")
        .replace("playwm", "play")
}

impl DouyinClient {
    fn normalize_share_url_token(value: &str) -> String {
        let trimmed = value.trim();
        let end = trimmed
            .char_indices()
            .find_map(|(index, ch)| {
                if "，。！？；、,!;".contains(ch) {
                    Some(index)
                } else {
                    None
                }
            })
            .unwrap_or(trimmed.len());

        trimmed[..end]
            .trim()
            .trim_end_matches(|ch: char| "，。！？；、,.!;".contains(ch))
            .to_string()
    }

    fn extract_share_url(input: &str) -> Option<String> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return None;
        }

        let value = SHARE_URL_REGEX
            .find(trimmed)
            .map(|matched| matched.as_str().to_string())
            .unwrap_or_else(|| trimmed.to_string());
        let value = Self::normalize_share_url_token(&value);

        if value.is_empty() {
            None
        } else if value.starts_with("www.") {
            Some(format!("https://{}", value))
        } else {
            Some(value)
        }
    }

    /// 从 URL 提取视频 ID
    pub fn extract_aweme_id(url: &str) -> Option<String> {
        let url = url.trim();

        // 直接是 aweme_id
        if AWEME_ID_DIGIT_REGEX.is_match(url) {
            return Some(url.to_string());
        }

        // 从分享链接提取
        for re in AWEME_ID_REGEXES.iter() {
            if let Some(caps) = re.captures(url) {
                if let Some(id) = caps.get(1) {
                    return Some(id.as_str().to_string());
                }
            }
        }

        None
    }

    /// 获取视频详情
    pub async fn get_video_detail(&self, aweme_id: &str) -> Result<VideoInfo> {
        let primary_result = self.get_single_video_detail(aweme_id).await;
        let mut video_info = match primary_result {
            Ok(video_info) => video_info,
            Err(primary_error) => {
                log::warn!(
                    "single video detail request failed, trying multi detail fallback: aweme_id={} error={}",
                    aweme_id,
                    primary_error
                );
                return self
                    .get_multi_video_detail(aweme_id)
                    .await
                    .map_err(|fallback_error| {
                        anyhow!(
                            "{}; fallback multi detail failed: {}",
                            primary_error,
                            fallback_error
                        )
                    });
            }
        };

        if !Self::video_info_has_media(&video_info) {
            match self.get_multi_video_detail(aweme_id).await {
                Ok(fallback) if Self::video_info_has_media(&fallback) => {
                    log::info!(
                        "using multi detail fallback because single detail had no media: aweme_id={}",
                        aweme_id
                    );
                    video_info = fallback;
                }
                Ok(_) => {
                    log::warn!(
                        "multi detail fallback also had no media: aweme_id={}",
                        aweme_id
                    );
                }
                Err(error) => {
                    log::warn!(
                        "multi detail fallback failed after empty single detail: aweme_id={} error={}",
                        aweme_id,
                        error
                    );
                }
            }
        }

        if video_info.aweme_id.trim().is_empty() {
            video_info.aweme_id = aweme_id.to_string();
        }

        Ok(video_info)
    }

    async fn get_single_video_detail(&self, aweme_id: &str) -> Result<VideoInfo> {
        let mut params = HashMap::new();
        params.insert("aweme_id", aweme_id.to_string());
        params.insert("aid", "1128".to_string());
        params.insert("version_name", "23.5.0".to_string());
        params.insert("device_platform", "webapp".to_string());
        params.insert("os", "windows".to_string());

        let response = match self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/aweme/detail/",
                Some(params.clone()),
                "GET",
                None,
                true,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                log::warn!(
                    "video detail unsigned request failed, retrying with signature: aweme_id={} error={}",
                    aweme_id,
                    error
                );
                self.request_raw_json_with_options(
                    "https://www.douyin.com/aweme/v1/web/aweme/detail/",
                    Some(params),
                    "GET",
                    None,
                    false,
                )
                .await?
            }
        };

        let status_code = response["status_code"].as_i64().unwrap_or(-1);
        if status_code != 0 {
            let status_msg = response["status_msg"].as_str().unwrap_or("unknown error");
            log::warn!(
                "Douyin video detail rejected: status_code={} status_msg={} aweme_id={}",
                status_code,
                status_msg,
                aweme_id
            );
            return Err(anyhow!("API error: {}", status_msg));
        }

        let data = response
            .get("aweme_detail")
            .ok_or_else(|| anyhow!("No aweme_detail in response"))?;
        let mut video_info = self.parse_video_info(data)?;
        if video_info.aweme_id.trim().is_empty() {
            video_info.aweme_id = aweme_id.to_string();
        }

        Ok(video_info)
    }

    async fn get_multi_video_detail(&self, aweme_id: &str) -> Result<VideoInfo> {
        let normalized_aweme_id = aweme_id.trim();
        if normalized_aweme_id.is_empty() {
            return Err(anyhow!("aweme_id is empty"));
        }

        let mut params = HashMap::new();
        params.insert("aweme_ids", format!("[{}]", normalized_aweme_id));
        params.insert("request_source", "200".to_string());

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/multi/aweme/detail/",
                Some(params),
                "GET",
                None,
                true,
            )
            .await?;

        let status_code = response["status_code"].as_i64().unwrap_or(-1);
        if status_code != 0 {
            let status_msg = response["status_msg"].as_str().unwrap_or("unknown error");
            log::warn!(
                "Douyin multi video detail rejected: status_code={} status_msg={} aweme_id={}",
                status_code,
                status_msg,
                normalized_aweme_id
            );
            return Err(anyhow!("API error: {}", status_msg));
        }

        let data = response
            .get("aweme_details")
            .and_then(|value| value.as_array())
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["aweme_id"].as_str() == Some(normalized_aweme_id))
                    .or_else(|| items.first())
            })
            .ok_or_else(|| anyhow!("No aweme_details in response"))?;

        let mut video_info = self.parse_video_info(data)?;
        if video_info.aweme_id.trim().is_empty() {
            video_info.aweme_id = normalized_aweme_id.to_string();
        }
        Ok(video_info)
    }

    fn video_info_has_media(video_info: &VideoInfo) -> bool {
        video_info
            .image_urls
            .as_ref()
            .map(|urls| urls.iter().any(|url| !url.trim().is_empty()))
            .unwrap_or(false)
            || video_info
                .live_photo_urls
                .as_ref()
                .map(|urls| urls.iter().any(|url| !url.trim().is_empty()))
                .unwrap_or(false)
            || !video_info.video.play_addr.trim().is_empty()
            || video_info
                .video
                .download_addr
                .as_ref()
                .map(|url| !url.trim().is_empty())
                .unwrap_or(false)
            || video_info
                .video
                .dash_addr
                .as_ref()
                .map(|url| !url.trim().is_empty())
                .unwrap_or(false)
    }

    /// 解析视频信息
    fn parse_video_info(&self, data: &serde_json::Value) -> Result<VideoInfo> {
        let aweme_id = data["aweme_id"].as_str().unwrap_or_default().to_string();
        let desc = data["desc"].as_str().unwrap_or_default().to_string();
        let create_time = data["create_time"].as_i64().unwrap_or(0);

        // 作者信息
        let author_data = &data["author"];
        let author = AuthorInfo {
            uid: author_data["uid"].as_str().unwrap_or_default().to_string(),
            sec_uid: author_data["sec_uid"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            nickname: author_data["nickname"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            avatar_thumb: self.get_first_url(&author_data["avatar_thumb"]["url_list"]),
            avatar_medium: self.get_first_url(&author_data["avatar_medium"]["url_list"]),
            signature: author_data["signature"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            follower_count: author_data["follower_count"].as_i64().unwrap_or(0),
            following_count: author_data["following_count"].as_i64().unwrap_or(0),
            aweme_count: author_data["aweme_count"].as_i64().unwrap_or(0),
            favoriting_count: author_data["favoriting_count"].as_i64().unwrap_or(0),
            is_follow: author_data["is_follow"].as_bool().unwrap_or(false)
                || author_data["follow_status"].as_i64().unwrap_or(0) > 0,
            follow_status: author_data["follow_status"].as_i64().unwrap_or(0) as i32,
            verify_status: author_data["verify_status"].as_i64().unwrap_or(0) as i32,
            unique_id: author_data["unique_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        };

        // 视频数据 - 参考 Python 版本从 bit_rate[0]["play_addr"] 获取视频 URL
        let video_data = &data["video"];

        let dash_addr = Self::select_dash_video_url(video_data);
        let audio_addr = Self::select_dash_audio_url(video_data);
        let bit_rate_play_addr = video_data["bit_rate"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|br| self.get_first_url_opt(&br["play_addr"]));
        let fallback_play_addr = self.get_first_url(&video_data["play_addr"]);
        let download_addr = self.get_first_url_opt(&video_data["download_addr"]);
        let primary_no_watermark = [
            bit_rate_play_addr.clone(),
            self.get_first_url_opt(&video_data["play_addr_h264"]),
            Some(fallback_play_addr.clone()),
            self.get_first_url_opt(&video_data["play_addr_lowbr"]),
            download_addr.clone(),
        ]
        .into_iter()
        .flatten()
        .find(|url| {
            !url.is_empty() && !looks_watermarked_media_url(url) && !is_dash_video_only_url(url)
        });
        let play_addr = primary_no_watermark
            .or(bit_rate_play_addr.filter(|url| !is_dash_video_only_url(url)))
            .or({
                if fallback_play_addr.is_empty() || is_dash_video_only_url(&fallback_play_addr) {
                    None
                } else {
                    Some(fallback_play_addr)
                }
            })
            .unwrap_or_default();

        let video = VideoData {
            preview_addr: Some(play_addr.clone()),
            play_addr: play_addr.clone(),
            dash_addr,
            audio_addr,
            play_addr_h264: self.get_first_url_opt(&video_data["play_addr_h264"]),
            play_addr_lowbr: self.get_first_url_opt(&video_data["play_addr_lowbr"]),
            download_addr: self.get_first_url_opt(&video_data["download_addr"]),
            cover: self.get_first_url(&video_data["cover"]["url_list"]),
            dynamic_cover: self.get_first_url(&video_data["dynamic_cover"]["url_list"]),
            origin_cover: self.get_first_url(&video_data["origin_cover"]["url_list"]),
            width: video_data["width"].as_i64().unwrap_or(0) as i32,
            height: video_data["height"].as_i64().unwrap_or(0) as i32,
            duration: video_data["duration"].as_i64().unwrap_or(0),
            ratio: video_data["ratio"].as_str().unwrap_or_default().to_string(),
            bit_rate: video_data["bit_rate"].as_array().map(|arr| {
                arr.iter()
                    .map(|b| BitRateInfo {
                        gear_name: b["gear_name"].as_str().unwrap_or_default().to_string(),
                        format: b["format"].as_str().unwrap_or_default().to_string(),
                        bit_rate: b["bit_rate"].as_i64().unwrap_or(0),
                        quality_type: b["quality_type"].as_i64().unwrap_or(0) as i32,
                        is_h265: b["is_h265"].as_bool().unwrap_or(false),
                        data_size: b["data_size"].as_i64().unwrap_or(0),
                        width: b["width"].as_i64().unwrap_or(0) as i32,
                        height: b["height"].as_i64().unwrap_or(0) as i32,
                        play_addr: self.get_first_url_opt(&b["play_addr"]),
                        play_addr_h264: self.get_first_url_opt(&b["play_addr_h264"]),
                    })
                    .collect()
            }),
        };

        // 统计
        let stats = &data["statistics"];
        let statistics = Statistics {
            play_count: stats["play_count"].as_i64().unwrap_or(0),
            digg_count: stats["digg_count"].as_i64().unwrap_or(0),
            comment_count: stats["comment_count"].as_i64().unwrap_or(0),
            share_count: stats["share_count"].as_i64().unwrap_or(0),
            collect_count: stats["collect_count"].as_i64().unwrap_or(0),
            forward_count: stats["forward_count"].as_i64().unwrap_or(0),
        };

        // 状态
        let status_data = &data["status"];
        let status = Status {
            is_delete: status_data["is_delete"].as_bool().unwrap_or(false),
            private_status: status_data["private_status"].as_i64().unwrap_or(0) as i32,
            review_status: status_data["review_status"].as_i64().unwrap_or(0) as i32,
            with_goods: status_data["with_goods"].as_bool().unwrap_or(false),
            is_prohibited: status_data["is_prohibited"].as_bool().unwrap_or(false),
        };

        // 判断媒体类型 - 参考 Python 版本
        // Python: 如果 images 字段存在且不为 null，就是图集(awemeType=1)
        // 否则是视频(awemeType=0)
        let images_data = data
            .get("images")
            .and_then(|v| v.as_array())
            .filter(|arr| !arr.is_empty());

        let is_image = images_data.is_some();
        let mut image_urls_list = Vec::new();
        let mut live_photo_urls_list = Vec::new();

        if let Some(images) = images_data {
            for image in images {
                if let Some(url) = image
                    .get("video")
                    .and_then(|value| value.get("play_addr"))
                    .and_then(|value| value.get("url_list"))
                    .and_then(|value| value.as_array())
                    .and_then(|urls| urls.first())
                    .and_then(|value| value.as_str())
                {
                    live_photo_urls_list.push(url.to_string());
                } else if let Some(url) = image
                    .get("url_list")
                    .and_then(|value| value.as_array())
                    .and_then(|urls| urls.last())
                    .and_then(|value| value.as_str())
                {
                    image_urls_list.push(url.to_string());
                }
            }
        }

        let has_live_photo = !live_photo_urls_list.is_empty();
        let has_static_image = !image_urls_list.is_empty();
        let image_urls = if image_urls_list.is_empty() {
            None
        } else {
            Some(image_urls_list)
        };
        let live_photo_urls = if live_photo_urls_list.is_empty() {
            None
        } else {
            Some(live_photo_urls_list)
        };

        // 确定媒体类型
        // 参考 Python 版本: awemeType=0 视频, awemeType=1 图集
        // 实况照片是图集的特殊形式，有视频URL
        let media_type = if has_live_photo && has_static_image {
            MediaType::Mixed
        } else if has_live_photo {
            MediaType::LivePhoto
        } else if is_image {
            MediaType::Image
        } else {
            MediaType::Video
        };

        log::debug!(
            "parse_video_info: aweme_id={} is_image={} has_live_photo={} media_type={:?}",
            aweme_id,
            is_image,
            has_live_photo,
            media_type
        );

        // 音乐信息
        let music = if data["music"].is_object() {
            let m = &data["music"];
            Some(MusicInfo {
                id: m["id"].as_str().unwrap_or_default().to_string(),
                title: m["title"].as_str().unwrap_or_default().to_string(),
                author: m["author"]
                    .as_str()
                    .or_else(|| m["owner_nickname"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                play_url: self.extract_music_play_url_value(m),
                cover_thumb: self
                    .get_first_url_opt(&m["cover_thumb"]["url_list"])
                    .or_else(|| self.get_first_url_opt(&m["cover_large"]["url_list"]))
                    .unwrap_or_default(),
                duration: m["duration"].as_i64().unwrap_or(0),
            })
        } else {
            None
        };

        // 文本额外信息
        let text_extra = data["text_extra"].as_array().map(|arr| {
            arr.iter()
                .map(|t| TextExtra {
                    text: t["text"].as_str().unwrap_or_default().to_string(),
                    r#type: t["type"].as_i64().unwrap_or(0) as i32,
                    hashtag_name: t["hashtag_name"].as_str().map(|s| s.to_string()),
                    aweme_id: t["aweme_id"].as_str().map(|s| s.to_string()),
                    sec_uid: t["sec_uid"].as_str().map(|s| s.to_string()),
                    user_id: t["user_id"].as_str().map(|s| s.to_string()),
                })
                .collect()
        });

        // 判断媒体类型
        let raw_media_type = data["raw_media_type"].as_i64().map(|v| v as i32);
        let is_liked = Self::json_boolish_any(data, &["user_digged", "is_liked", "digg_status"]);
        let is_collected = Self::json_boolish_any(
            data,
            &[
                "is_collected",
                "is_collect",
                "collect_status",
                "collect_stat",
            ],
        );

        Ok(VideoInfo {
            aweme_id,
            desc,
            create_time,
            author,
            video,
            statistics,
            status,
            image_urls,
            is_image,
            media_type,
            has_live_photo,
            is_liked,
            is_collected,
            live_photo_urls,
            music,
            raw_media_type,
            text_extra,
        })
    }

    pub(super) fn get_first_url(&self, data: &serde_json::Value) -> String {
        self.get_first_url_opt(data).unwrap_or_default()
    }

    pub(super) fn get_avatar_url(&self, data: &serde_json::Value, keys: &[&str]) -> String {
        keys.iter()
            .filter_map(|key| data.get(*key))
            .find_map(|value| self.get_first_url_opt(value))
            .unwrap_or_default()
    }

    fn json_boolish_any(data: &serde_json::Value, keys: &[&str]) -> bool {
        keys.iter()
            .filter_map(|key| data.get(*key))
            .any(Self::json_boolish)
    }

    fn json_boolish(value: &serde_json::Value) -> bool {
        if let Some(value) = value.as_bool() {
            return value;
        }
        if let Some(value) = value.as_i64() {
            return value > 0;
        }
        if let Some(value) = value.as_str() {
            return matches!(value.trim(), "1" | "true" | "True" | "TRUE");
        }
        false
    }

    fn get_first_url_opt(&self, data: &serde_json::Value) -> Option<String> {
        if let Some(value) = data
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }

        if let Some(arr) = data.as_array() {
            return arr.iter().find_map(|value| self.get_first_url_opt(value));
        }

        if let Some(obj) = data.as_object() {
            for key in [
                "url_list",
                "url",
                "main_url",
                "backup_url",
                "fallback_url",
                "play_addr",
                "play_url",
                "download_addr",
                "download_url",
                "display_url",
                "uri",
            ] {
                if let Some(url) = obj.get(key).and_then(|value| self.get_first_url_opt(value)) {
                    if key == "uri" && !url.starts_with("http://") && !url.starts_with("https://") {
                        continue;
                    }
                    return Some(url);
                }
            }
        }

        None
    }

    fn select_dash_video_url(video_data: &serde_json::Value) -> Option<String> {
        let bit_rates = video_data["bit_rate"].as_array()?;

        bit_rates
            .iter()
            .filter(|bit_rate| bit_rate["format"].as_str() == Some("dash"))
            .filter(|bit_rate| !bit_rate["is_h265"].as_bool().unwrap_or(false))
            .find_map(|bit_rate| {
                let urls = bit_rate["play_addr"]["url_list"].as_array()?;
                urls.iter()
                    .filter_map(|value| value.as_str().map(str::trim))
                    .find(|url| !url.is_empty() && url.contains("media-video-avc1"))
                    .or_else(|| {
                        urls.iter()
                            .filter_map(|value| value.as_str().map(str::trim))
                            .find(|url| !url.is_empty())
                    })
                    .map(str::to_string)
            })
    }

    fn select_dash_audio_url(video_data: &serde_json::Value) -> Option<String> {
        let audio_rates = video_data["bit_rate_audio"].as_array()?;

        for audio_rate in audio_rates {
            let audio_meta = &audio_rate["audio_meta"];
            if let Some(url) = Self::first_media_url_value(&audio_meta["url_list"]) {
                return Some(url);
            }
            if let Some(url) = Self::first_media_url_value(audio_meta) {
                return Some(url);
            }
        }

        None
    }

    fn first_media_url_value(data: &serde_json::Value) -> Option<String> {
        if let Some(value) = data
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }

        if let Some(values) = data.as_array() {
            return values.iter().find_map(Self::first_media_url_value);
        }

        if let Some(object) = data.as_object() {
            for key in [
                "main_url",
                "backup_url",
                "fallback_url",
                "url_list",
                "url",
                "play_url",
                "download_url",
                "uri",
            ] {
                if let Some(url) = object.get(key).and_then(Self::first_media_url_value) {
                    if key == "uri" && !url.starts_with("http://") && !url.starts_with("https://") {
                        continue;
                    }
                    return Some(url);
                }
            }
        }

        None
    }

    fn get_last_url_opt(&self, data: &serde_json::Value) -> Option<String> {
        data.as_array()
            .and_then(|arr| arr.last())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    fn extract_music_play_url_value(&self, music: &serde_json::Value) -> Option<String> {
        if let Some(play_url) = music.get("play_url") {
            if play_url.is_object() {
                if let Some(url) = self.get_first_url_opt(&play_url["url_list"]) {
                    if !url.is_empty() {
                        return Some(url);
                    }
                }
                if let Some(uri) = play_url.get("uri").and_then(|value| value.as_str()) {
                    if uri.starts_with("http") {
                        return Some(uri.to_string());
                    }
                }
            } else if let Some(url) = play_url.as_str() {
                if url.starts_with("http") {
                    return Some(url.to_string());
                }
            }
        }

        if let Some(music_file) = music.get("music_file") {
            if music_file.is_object() {
                if let Some(url) = self.get_first_url_opt(&music_file["url_list"]) {
                    if !url.is_empty() {
                        return Some(url);
                    }
                }
            } else if let Some(url) = music_file.as_str() {
                if url.starts_with("http") {
                    return Some(url.to_string());
                }
            }
        }

        for key in ["src_url", "mp3_url"] {
            if let Some(url) = music.get(key).and_then(|value| value.as_str()) {
                if url.starts_with("http") {
                    return Some(url.to_string());
                }
            }
        }

        None
    }

    fn extract_liked_media_info(
        &self,
        post: &serde_json::Value,
    ) -> (String, Vec<LikedVideoMediaUrl>) {
        let mut urls = Vec::new();
        let mut media_type = "unknown".to_string();

        if let Some(images) = post.get("images").and_then(|value| value.as_array()) {
            let mut has_live = false;
            let mut has_image = false;

            for image in images {
                if let Some(video_urls) = image
                    .get("video")
                    .and_then(|value| value.get("play_addr"))
                    .and_then(|value| value.get("url_list"))
                    .and_then(|value| value.as_array())
                {
                    has_live = true;
                    if let Some(url) = video_urls.first().and_then(|value| value.as_str()) {
                        urls.push(LikedVideoMediaUrl {
                            r#type: "live_photo".to_string(),
                            url: url.to_string(),
                        });
                    }
                } else if let Some(image_urls) =
                    image.get("url_list").and_then(|value| value.as_array())
                {
                    if let Some(url) = image_urls.last().and_then(|value| value.as_str()) {
                        has_image = true;
                        urls.push(LikedVideoMediaUrl {
                            r#type: "image".to_string(),
                            url: url.to_string(),
                        });
                    }
                }
            }

            media_type = if has_live && has_image {
                "mixed".to_string()
            } else if has_live {
                "live_photo".to_string()
            } else if has_image {
                "image".to_string()
            } else {
                "unknown".to_string()
            };
        } else if let Some(video_urls) = post
            .get("video")
            .and_then(|value| value.get("play_addr"))
            .and_then(|value| value.get("url_list"))
            .and_then(|value| value.as_array())
        {
            if let Some(url) = video_urls.first().and_then(|value| value.as_str()) {
                let clean_url = clean_video_media_url(url);
                if !clean_url.is_empty() && !is_dash_video_only_url(&clean_url) {
                    media_type = "video".to_string();
                    urls.push(LikedVideoMediaUrl {
                        r#type: "video".to_string(),
                        url: clean_url,
                    });
                }
            }
        }

        (media_type, urls)
    }

    fn extract_liked_bgm_url(&self, post: &serde_json::Value) -> Option<String> {
        let music = post.get("music")?;
        let mut bgm_url = self.extract_music_play_url_value(music);

        if bgm_url
            .as_ref()
            .map(|value| value.is_empty())
            .unwrap_or(true)
        {
            let h5_url = music
                .get("h5_url")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let web_url = music
                .get("web_url")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            bgm_url = Some(if !h5_url.is_empty() {
                h5_url.to_string()
            } else {
                web_url.to_string()
            });
        }

        if bgm_url
            .as_ref()
            .map(|value| value.is_empty())
            .unwrap_or(true)
        {
            if let Some(music_file) = music.get("music_file") {
                if music_file.is_object() {
                    bgm_url = self.get_first_url_opt(&music_file["url_list"]);
                } else if let Some(url) = music_file.as_str() {
                    bgm_url = Some(url.to_string());
                }
            }
        }

        bgm_url
    }

    fn build_liked_video_item(
        &self,
        post: &serde_json::Value,
        default_liked: bool,
        default_collected: bool,
    ) -> Option<LikedVideoItem> {
        let aweme_id = post.get("aweme_id")?.as_str()?.to_string();
        let (media_type, media_urls) = self.extract_liked_media_info(post);
        let video_data = &post["video"];
        let dash_addr = Self::select_dash_video_url(video_data);
        let audio_addr = Self::select_dash_audio_url(video_data);
        let raw_play_addr = self.get_first_url(&video_data["play_addr"]);
        let selected_play_addr = clean_video_media_url(&raw_play_addr);
        let selected_play_addr = if is_dash_video_only_url(&selected_play_addr) {
            String::new()
        } else {
            selected_play_addr
        };

        let cover_url = post
            .get("video")
            .and_then(|value| value.get("cover"))
            .and_then(|value| value.get("url_list"))
            .and_then(|value| self.get_first_url_opt(value))
            .or_else(|| {
                post.get("images")
                    .and_then(|value| value.as_array())
                    .and_then(|images| images.first())
                    .and_then(|image| image.get("url_list"))
                    .and_then(|value| self.get_last_url_opt(value))
            })
            .unwrap_or_default();
        let fallback_media_url = media_urls
            .first()
            .map(|media| media.url.clone())
            .unwrap_or_default();
        let preview_addr = if selected_play_addr.is_empty() {
            fallback_media_url.clone()
        } else {
            selected_play_addr.clone()
        };
        let duration = video_data["duration"].as_i64().unwrap_or(0);
        let bit_rate = video_data["bit_rate"].as_array().and_then(|arr| {
            let items = arr
                .iter()
                .filter_map(|b| {
                    let play_addr = self.get_first_url_opt(&b["play_addr"]);
                    let play_addr_h264 = self.get_first_url_opt(&b["play_addr_h264"]);
                    if play_addr.is_none() && play_addr_h264.is_none() {
                        return None;
                    }
                    Some(BitRateInfo {
                        gear_name: b["gear_name"].as_str().unwrap_or_default().to_string(),
                        format: b["format"].as_str().unwrap_or_default().to_string(),
                        bit_rate: b["bit_rate"].as_i64().unwrap_or(0),
                        quality_type: b["quality_type"].as_i64().unwrap_or(0) as i32,
                        is_h265: b["is_h265"].as_bool().unwrap_or(false),
                        data_size: b["data_size"].as_i64().unwrap_or(0),
                        width: b["width"].as_i64().unwrap_or(0) as i32,
                        height: b["height"].as_i64().unwrap_or(0) as i32,
                        play_addr,
                        play_addr_h264,
                    })
                })
                .collect::<Vec<_>>();
            if items.is_empty() {
                None
            } else {
                Some(items)
            }
        });

        Some(LikedVideoItem {
            aweme_id,
            desc: post["desc"].as_str().unwrap_or_default().to_string(),
            create_time: post["create_time"].as_i64().unwrap_or(0),
            digg_count: post["statistics"]["digg_count"].as_i64().unwrap_or(0),
            comment_count: post["statistics"]["comment_count"].as_i64().unwrap_or(0),
            share_count: post["statistics"]["share_count"].as_i64().unwrap_or(0),
            cover_url: cover_url.clone(),
            duration,
            media_type: media_type.clone(),
            raw_media_type: media_type,
            media_urls,
            bgm_url: self.extract_liked_bgm_url(post),
            is_liked: Self::json_boolish_any(post, &["user_digged", "is_liked", "digg_status"])
                || default_liked,
            is_collected: Self::json_boolish_any(
                post,
                &[
                    "is_collected",
                    "is_collect",
                    "collect_status",
                    "collect_stat",
                ],
            ) || default_collected,
            statistics: Statistics {
                digg_count: post["statistics"]["digg_count"].as_i64().unwrap_or(0),
                comment_count: post["statistics"]["comment_count"].as_i64().unwrap_or(0),
                share_count: post["statistics"]["share_count"].as_i64().unwrap_or(0),
                play_count: post["statistics"]["play_count"].as_i64().unwrap_or(0),
                collect_count: post["statistics"]["collect_count"].as_i64().unwrap_or(0),
                ..Default::default()
            },
            video: VideoData {
                preview_addr: if preview_addr.is_empty() {
                    None
                } else {
                    Some(preview_addr.clone())
                },
                play_addr: if selected_play_addr.is_empty() {
                    fallback_media_url.clone()
                } else {
                    selected_play_addr
                },
                dash_addr,
                audio_addr,
                play_addr_h264: self.get_first_url_opt(&video_data["play_addr_h264"]),
                play_addr_lowbr: self.get_first_url_opt(&video_data["play_addr_lowbr"]),
                download_addr: self.get_first_url_opt(&video_data["download_addr"]),
                cover: cover_url.clone(),
                dynamic_cover: self
                    .get_first_url_opt(&video_data["dynamic_cover"]["url_list"])
                    .unwrap_or_else(|| cover_url.clone()),
                origin_cover: self
                    .get_first_url_opt(&video_data["origin_cover"]["url_list"])
                    .unwrap_or_else(|| cover_url.clone()),
                width: video_data["width"].as_i64().unwrap_or(0) as i32,
                height: video_data["height"].as_i64().unwrap_or(0) as i32,
                duration,
                ratio: video_data["ratio"].as_str().unwrap_or_default().to_string(),
                bit_rate,
            },
            author: LikedVideoAuthor {
                nickname: post["author"]["nickname"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                sec_uid: post["author"]["sec_uid"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                avatar_thumb: post
                    .get("author")
                    .and_then(|value| value.get("avatar_thumb"))
                    .and_then(|value| value.get("url_list"))
                    .and_then(|value| self.get_first_url_opt(value))
                    .unwrap_or_default(),
            },
        })
    }

    async fn request_liked_videos_response(
        &self,
        sec_uid: &str,
        max_cursor: i64,
        count: u32,
    ) -> Result<serde_json::Value> {
        let mut params = HashMap::new();
        params.insert("max_cursor", max_cursor.to_string());
        params.insert("count", count.to_string());
        if !sec_uid.is_empty() {
            params.insert("sec_user_id", sec_uid.to_string());
        }

        let mut headers = HashMap::new();
        headers.insert("Referer".to_string(), "https://www.douyin.com/".to_string());

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/aweme/favorite/",
                Some(params),
                "GET",
                Some(headers),
                true,
            )
            .await?;

        let status_code = response["status_code"].as_i64().unwrap_or(0);
        if status_code != 0 {
            let status_msg = response["status_msg"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("API error: {}", status_msg));
        }

        Ok(response)
    }

    pub async fn get_liked_videos_python_style(
        &self,
        sec_uid: &str,
        max_cursor: i64,
        count: u32,
    ) -> Result<(Vec<LikedVideoItem>, i64, bool)> {
        let response = self
            .request_liked_videos_response(sec_uid, max_cursor, count)
            .await?;

        let cursor = response["max_cursor"]
            .as_i64()
            .or_else(|| response["cursor"].as_i64())
            .or_else(|| response["min_cursor"].as_i64())
            .unwrap_or(0);
        let has_more = response["has_more"].as_i64().unwrap_or(0) == 1
            || response["has_more"].as_bool().unwrap_or(false);
        let videos = response["aweme_list"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|post| self.build_liked_video_item(post, true, false))
                    .collect()
            })
            .unwrap_or_default();

        Ok((videos, cursor, has_more))
    }

    async fn request_collected_videos_response(
        &self,
        cursor: i64,
        count: u32,
    ) -> Result<serde_json::Value> {
        let url = "https://www.douyin.com/aweme/v1/web/aweme/listcollection/";
        let mut query_params = crate::config::get_common_params();
        query_params.insert("count".to_string(), count.to_string());
        query_params.insert("cursor".to_string(), cursor.to_string());

        let mut headers = crate::config::get_common_headers(&self.config.cookie);
        headers.insert(
            "Referer".to_string(),
            "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection"
                .to_string(),
        );
        headers.insert("Origin".to_string(), "https://www.douyin.com".to_string());
        headers.insert(
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded; charset=UTF-8".to_string(),
        );

        self.enrich_request(&mut query_params, &mut headers).await;

        let params_str = serde_urlencoded::to_string(&query_params)?;
        let user_agent = headers
            .get("User-Agent")
            .map(String::as_str)
            .unwrap_or_else(|| get_user_agent());
        query_params.insert(
            "a_bogus".to_string(),
            sign::sign_detail(&params_str, user_agent),
        );

        let mut body_params = HashMap::new();
        body_params.insert("count", count.to_string());
        body_params.insert("cursor", cursor.to_string());

        let mut req = self
            .client
            .post(url)
            .query(&query_params)
            .form(&body_params);
        for (key, value) in &headers {
            req = req.header(key, value);
        }

        let response = req
            .send()
            .await
            .map_err(|error| anyhow!("HTTP request failed: {}", error))?;
        if !response.status().is_success() {
            return Err(anyhow!("HTTP error: {}", response.status()));
        }

        let json = response.json::<serde_json::Value>().await?;
        Self::ensure_status_ok(&json)?;
        Ok(json)
    }

    pub async fn get_collected_videos_python_style(
        &self,
        cursor: i64,
        count: u32,
    ) -> Result<(Vec<LikedVideoItem>, i64, bool)> {
        let response = self
            .request_collected_videos_response(cursor, count)
            .await?;

        let videos = response["aweme_list"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|post| self.build_liked_video_item(post, false, true))
                    .collect()
            })
            .unwrap_or_default();

        Ok((
            videos,
            Self::json_cursor(&response),
            Self::json_has_more(&response),
        ))
    }

    /// 获取收藏视频列表（返回 VideoInfo，用于批量下载）
    pub async fn get_collected_videos(
        &self,
        cursor: i64,
        count: u32,
    ) -> Result<(Vec<VideoInfo>, i64, bool)> {
        let response = self
            .request_collected_videos_response(cursor, count)
            .await?;

        let videos = response["aweme_list"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|post| self.parse_video_info(post).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok((
            videos,
            Self::json_cursor(&response),
            Self::json_has_more(&response),
        ))
    }

    /// 获取收藏合集列表
    pub async fn get_collected_mixes(
        &self,
        cursor: i64,
        count: u32,
    ) -> Result<(Vec<CollectionMixItem>, i64, bool)> {
        let mut params = HashMap::new();
        params.insert("count", count.to_string());
        params.insert("cursor", cursor.to_string());

        let mut headers = HashMap::new();
        headers.insert(
            "Referer".to_string(),
            "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection"
                .to_string(),
        );

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/mix/listcollection/",
                Some(params),
                "GET",
                Some(headers),
                false,
            )
            .await?;
        Self::ensure_status_ok(&response)?;

        let mixes = response["mix_infos"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| self.build_collection_mix_item(item))
                    .collect()
            })
            .unwrap_or_default();

        Ok((
            mixes,
            Self::json_cursor(&response),
            Self::json_has_more(&response),
        ))
    }

    fn build_collection_mix_item(&self, item: &serde_json::Value) -> Option<CollectionMixItem> {
        let mix_id = item["mix_id"].as_str().unwrap_or_default().to_string();
        if mix_id.is_empty() {
            return None;
        }

        let author = item.get("author");
        let statis = item.get("statis");

        Some(CollectionMixItem {
            mix_id,
            mix_name: item["mix_name"].as_str().unwrap_or_default().to_string(),
            desc: item["desc"].as_str().unwrap_or_default().to_string(),
            cover_url: item
                .get("cover_url")
                .and_then(|value| value.get("url_list"))
                .and_then(|value| self.get_first_url_opt(value))
                .unwrap_or_default(),
            author: CollectionMixAuthor {
                nickname: author
                    .and_then(|value| value["nickname"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                sec_uid: author
                    .and_then(|value| value["sec_uid"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                avatar_thumb: author
                    .and_then(|value| value.get("avatar_thumb"))
                    .and_then(|value| value.get("url_list"))
                    .and_then(|value| self.get_first_url_opt(value))
                    .unwrap_or_default(),
            },
            statis: CollectionMixStats {
                collect_vv: statis
                    .and_then(|value| value["collect_vv"].as_i64())
                    .unwrap_or(0),
                play_vv: statis
                    .and_then(|value| value["play_vv"].as_i64())
                    .unwrap_or(0),
                updated_to_episode: statis
                    .and_then(|value| value["updated_to_episode"].as_i64())
                    .unwrap_or(0),
            },
            create_time: item["create_time"].as_i64().unwrap_or(0),
            update_time: item["update_time"].as_i64().unwrap_or(0),
            mix_type: item["mix_type"].as_i64().unwrap_or(0) as i32,
        })
    }

    /// 获取合集内的视频列表
    pub async fn get_mix_videos(
        &self,
        series_id: &str,
        cursor: i64,
        count: u32,
    ) -> Result<(Vec<VideoInfo>, i64, bool)> {
        let mut params = HashMap::new();
        params.insert("series_id", series_id.to_string());
        params.insert("pull_type", "2".to_string());
        params.insert("cursor", cursor.to_string());
        params.insert("count", count.to_string());

        let mut headers = HashMap::new();
        headers.insert(
            "Referer".to_string(),
            "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection"
                .to_string(),
        );

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/series/aweme/",
                Some(params),
                "GET",
                Some(headers),
                false,
            )
            .await?;
        Self::ensure_status_ok(&response)?;

        let videos = response["aweme_list"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|post| self.parse_video_info(post).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok((
            videos,
            Self::json_cursor(&response),
            Self::json_has_more(&response),
        ))
    }

    /// 获取无水印视频 URL
    pub fn get_no_watermark_url(video: &VideoInfo) -> Option<String> {
        for url in [
            video.video.play_addr_h264.as_deref(),
            Some(video.video.play_addr.as_str()),
            video.video.download_addr.as_deref(),
            video.video.play_addr_lowbr.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let clean_url = url
                .trim()
                .replace("watermark=1", "watermark=0")
                .replace("playwm", "play");
            let normalized = clean_url.to_ascii_lowercase();
            if !clean_url.is_empty()
                && !normalized.contains("playwm")
                && !normalized.contains("watermark=1")
                && !normalized.contains("media-video")
                && !normalized.contains("media_video")
            {
                return Some(clean_url);
            }
        }
        None
    }

    fn json_count_value(value: &serde_json::Value, keys: &[&str]) -> i64 {
        for key in keys {
            let item = &value[*key];
            if let Some(number) = item.as_i64() {
                return number;
            }
            if let Some(text) = item.as_str() {
                let normalized = text.trim().replace(',', "");
                if let Ok(number) = normalized.parse::<i64>() {
                    return number;
                }
            }
        }
        0
    }

    pub(super) fn json_has_more(value: &serde_json::Value) -> bool {
        value["has_more"].as_i64().unwrap_or(0) == 1
            || value["has_more"].as_bool().unwrap_or(false)
            || matches!(value["has_more"].as_str(), Some("1" | "true" | "True"))
    }

    fn json_cursor(value: &serde_json::Value) -> i64 {
        value["cursor"]
            .as_i64()
            .or_else(|| value["max_cursor"].as_i64())
            .or_else(|| value["min_cursor"].as_i64())
            .unwrap_or(0)
    }

    fn ensure_status_ok(value: &serde_json::Value) -> Result<()> {
        let status_code = value["status_code"].as_i64().unwrap_or(0);
        if status_code != 0 {
            let status_msg = value["status_msg"].as_str().unwrap_or("unknown error");
            log::warn!(
                "Douyin API status rejected: status_code={} status_msg={}",
                status_code,
                status_msg
            );
            return Err(anyhow!("API error: {} (code={})", status_msg, status_code));
        }
        Ok(())
    }

    /// 搜索用户
    pub async fn search_user(&self, keyword: &str) -> Result<SearchUserResult> {
        let keyword = keyword.trim();

        if keyword.contains("https") {
            let user_id = keyword
                .split('/')
                .next_back()
                .unwrap_or_default()
                .split('?')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();

            if user_id.is_empty() {
                return Ok(SearchUserResult::NotFound);
            }

            return Ok(SearchUserResult::Single(Box::new(UserInfo {
                sec_uid: user_id,
                ..Default::default()
            })));
        }

        let precise_search =
            keyword.starts_with('@') || keyword.chars().any(|ch| ch.is_ascii_digit());
        let mut params = HashMap::new();
        params.insert("keyword", keyword.to_string());
        params.insert("search_channel", "aweme_user_web".to_string());
        params.insert("search_source", "normal_search".to_string());
        params.insert("query_correct_type", "1".to_string());
        params.insert("is_filter_search", "0".to_string());
        params.insert("from_group_id", "".to_string());
        params.insert("offset", "0".to_string());
        params.insert("count", if precise_search { "1" } else { "10" }.to_string());
        params.insert(
            "pc_search_top_1_params",
            "{\"enable_ai_search_top_1\":1}".to_string(),
        );

        let encoded_keyword: String =
            url::form_urlencoded::byte_serialize(keyword.as_bytes()).collect();
        let verify_url = format!(
            "https://www.douyin.com/jingxuan/search/{}?type=user",
            encoded_keyword
        );
        let mut headers = HashMap::new();
        headers.insert("Referer".to_string(), verify_url.clone());

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/discover/search/",
                Some(params),
                "GET",
                Some(headers),
                true,
            )
            .await?;

        let need_verify = response["search_nil_info"]["search_nil_type"]
            .as_str()
            .map(|value| value == "verify_check")
            .unwrap_or(false)
            && response["user_list"]
                .as_array()
                .map(|items| items.is_empty())
                .unwrap_or(true);
        if need_verify {
            return Ok(SearchUserResult::NeedVerify { verify_url });
        }

        let status_code = response["status_code"].as_i64().unwrap_or(-1);
        if status_code != 0 {
            let status_msg = response["status_msg"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("API error: {}", status_msg));
        }

        let users: Vec<UserInfo> = response["user_list"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let user = if item["user_info"].is_object() {
                            &item["user_info"]
                        } else {
                            item
                        };
                        Some(UserInfo {
                            uid: user["uid"].as_str()?.to_string(),
                            nickname: user["nickname"].as_str()?.to_string(),
                            avatar_thumb: self.get_first_url(&user["avatar_thumb"]["url_list"]),
                            avatar_medium: self.get_first_url(&user["avatar_medium"]["url_list"]),
                            avatar_larger: self.get_first_url(&user["avatar_larger"]["url_list"]),
                            signature: user["signature"].as_str().unwrap_or_default().to_string(),
                            follower_count: user["follower_count"].as_i64().unwrap_or(0),
                            following_count: user["following_count"].as_i64().unwrap_or(0),
                            total_favorited: user["total_favorited"].as_i64().unwrap_or(0),
                            aweme_count: Self::json_count_value(
                                user,
                                &[
                                    "aweme_count",
                                    "aweme_count_str",
                                    "aweme_count_text",
                                    "work_count",
                                ],
                            ),
                            favoriting_count: user["favoriting_count"].as_i64().unwrap_or(0),
                            is_follow: user["is_follow"].as_bool().unwrap_or(false)
                                || user["follow_status"].as_i64().unwrap_or(0) > 0,
                            follow_status: user["follow_status"].as_i64().unwrap_or(0) as i32,
                            sec_uid: user["sec_uid"].as_str().unwrap_or_default().to_string(),
                            unique_id: user["unique_id"].as_str().unwrap_or_default().to_string(),
                            verify_status: user["verify_status"].as_i64().unwrap_or(0) as i32,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        if users.is_empty() {
            return Ok(SearchUserResult::NotFound);
        }

        if precise_search {
            Ok(SearchUserResult::Single(Box::new(
                users.into_iter().next().unwrap_or_default(),
            )))
        } else {
            Ok(SearchUserResult::Multiple(users))
        }
    }

    /// 获取用户详情
    pub async fn get_user_detail(&self, sec_uid: &str) -> Result<UserDetail> {
        let mut params = HashMap::new();
        params.insert("sec_user_id", sec_uid.to_string());
        params.insert("personal_center_strategy", "1".to_string());
        params.insert("source", "channel_pc_web".to_string());

        let mut headers = HashMap::new();
        headers.insert("Referer".to_string(), "https://www.douyin.com/".to_string());

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/user/profile/other/",
                Some(params),
                "GET",
                Some(headers),
                true,
            )
            .await?;

        let status_code = response["status_code"].as_i64().unwrap_or(-1);
        if status_code != 0 {
            let status_msg = response["status_msg"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("API error: {}", status_msg));
        }

        let user_data = &response["user"];

        let info = UserInfo {
            uid: user_data["uid"].as_str().unwrap_or_default().to_string(),
            nickname: user_data["nickname"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            avatar_thumb: self.get_first_url(&user_data["avatar_thumb"]["url_list"]),
            avatar_medium: self.get_first_url(&user_data["avatar_medium"]["url_list"]),
            avatar_larger: self.get_first_url(&user_data["avatar_larger"]["url_list"]),
            signature: user_data["signature"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            follower_count: user_data["follower_count"].as_i64().unwrap_or(0),
            following_count: user_data["following_count"].as_i64().unwrap_or(0),
            total_favorited: user_data["total_favorited"].as_i64().unwrap_or(0),
            aweme_count: user_data["aweme_count"].as_i64().unwrap_or(0),
            favoriting_count: user_data["favoriting_count"].as_i64().unwrap_or(0),
            is_follow: user_data["is_follow"].as_bool().unwrap_or(false)
                || user_data["follow_status"].as_i64().unwrap_or(0) > 0,
            follow_status: user_data["follow_status"].as_i64().unwrap_or(0) as i32,
            sec_uid: user_data["sec_uid"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            unique_id: user_data["unique_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            verify_status: user_data["verify_status"].as_i64().unwrap_or(0) as i32,
        };

        Ok(UserDetail {
            info,
            is_favorite: user_data["is_favorite"].as_bool().unwrap_or(false),
            follow_status: user_data["follow_status"].as_i64().unwrap_or(0) as i32,
            story_count: user_data["story_count"].as_i64().unwrap_or(0),
            friend_status: user_data["friend_status"].as_i64().unwrap_or(0) as i32,
        })
    }

    /// 获取用户发布的视频列表
    pub async fn get_user_videos(
        &self,
        sec_uid: &str,
        max_cursor: i64,
        count: u32,
    ) -> Result<(Vec<VideoInfo>, i64, bool)> {
        let mut params = HashMap::new();
        params.insert("publish_video_strategy_type", "2".to_string());
        params.insert("sec_user_id", sec_uid.to_string());
        params.insert("max_cursor", max_cursor.to_string());
        params.insert("locate_query", "false".to_string());
        params.insert("show_live_replay_strategy", "1".to_string());
        params.insert("need_time_list", "0".to_string());
        params.insert("time_list_query", "0".to_string());
        params.insert("whale_cut_token", "".to_string());
        params.insert("count", count.to_string());

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/aweme/post/",
                Some(params),
                "GET",
                None,
                true,
            )
            .await?;

        let status_code = response["status_code"].as_i64().unwrap_or(0);
        if status_code != 0 {
            let status_msg = response["status_msg"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("API error: {}", status_msg));
        }

        let aweme_list = response["aweme_list"].as_array();
        let has_more = response["has_more"].as_i64().unwrap_or(0) == 1
            || response["has_more"].as_bool().unwrap_or(false);
        let cursor = response["max_cursor"].as_i64().unwrap_or(0);

        let videos = if let Some(list) = aweme_list {
            list.iter()
                .filter_map(|v| self.parse_video_info(v).ok())
                .filter(is_valid_recommended_video)
                .collect()
        } else {
            vec![]
        };

        Ok((videos, cursor, has_more))
    }

    /// 获取点赞视频列表
    pub async fn get_liked_videos(
        &self,
        sec_uid: &str,
        max_cursor: i64,
        count: u32,
    ) -> Result<(Vec<VideoInfo>, i64, bool)> {
        let response = self
            .request_liked_videos_response(sec_uid, max_cursor, count)
            .await?;

        let aweme_list = response["aweme_list"].as_array();
        let has_more = response["has_more"].as_i64().unwrap_or(0) == 1
            || response["has_more"].as_bool().unwrap_or(false);
        let cursor = response["max_cursor"].as_i64().unwrap_or(0);

        let videos = if let Some(list) = aweme_list {
            list.iter()
                .filter_map(|v| self.parse_video_info(v).ok())
                .collect()
        } else {
            vec![]
        };

        Ok((videos, cursor, has_more))
    }

    /// 获取推荐视频
    pub async fn get_recommended_feed(
        &self,
        cursor: i64,
        count: u32,
        feed_type: &str,
    ) -> Result<(Vec<VideoInfo>, i64, bool)> {
        if normalize_recommended_feed_type(feed_type) == "recommended" {
            return self.get_home_recommended_feed(cursor, count).await;
        }

        let mut params = HashMap::new();
        params.insert("module_id", "3003101".to_string());
        params.insert("count", count.to_string());
        params.insert("pull_type", "0".to_string());
        params.insert("refresh_index", "1".to_string());
        params.insert("refer_type", "10".to_string());
        params.insert("filterGids", "".to_string());
        params.insert("presented_ids", "".to_string());
        params.insert("refer_id", "".to_string());
        params.insert("tag_id", "".to_string());
        params.insert("use_lite_type", "2".to_string());
        params.insert("Seo-Flag", "0".to_string());
        params.insert("pre_log_id", "".to_string());
        params.insert("pre_item_ids", "".to_string());
        params.insert("pre_room_ids", "".to_string());
        params.insert("pre_item_from", "sati".to_string());
        params.insert("xigua_user", "0".to_string());
        params.insert(
            "awemePcRecRawData",
            "{\"is_xigua_user\":0,\"danmaku_switch_status\":0,\"is_client\":false}".to_string(),
        );
        if cursor > 0 {
            params.insert("cursor", cursor.to_string());
        }

        let mut headers = HashMap::new();
        headers.insert(
            "Referer".to_string(),
            "https://www.douyin.com/?recommend=1".to_string(),
        );

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v2/web/module/feed/",
                Some(params),
                "POST",
                Some(headers),
                false, // 需要签名
            )
            .await?;

        let status_code = response["status_code"].as_i64().unwrap_or(-1);
        if status_code != 0 {
            let status_msg = response["status_msg"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("API error: {}", status_msg));
        }

        let aweme_list = response["aweme_list"].as_array();
        // has_more 可能是布尔值或整数
        let has_more = response["has_more"]
            .as_bool()
            .or_else(|| response["has_more"].as_i64().map(|v| v == 1))
            .unwrap_or(false);
        let next_cursor = response["cursor"]
            .as_i64()
            .or_else(|| response["max_cursor"].as_i64())
            .or_else(|| response["min_cursor"].as_i64())
            .unwrap_or_else(|| if has_more { cursor + 1 } else { cursor });

        let videos = if let Some(list) = aweme_list {
            list.iter()
                .filter_map(|v| self.parse_video_info(v).ok())
                .collect()
        } else {
            vec![]
        };

        Ok((videos, next_cursor, has_more))
    }

    async fn get_home_recommended_feed(
        &self,
        cursor: i64,
        count: u32,
    ) -> Result<(Vec<VideoInfo>, i64, bool)> {
        let refresh_index = std::cmp::max(1, cursor + 1);
        let raw_data = serde_json::json!({
            "is_client": false,
            "ff_danmaku_status": 1,
            "danmaku_switch_status": 0,
            "is_dash_user": 1,
            "related_recommend": 1,
            "is_xigua_user": 0,
        })
        .to_string();

        let mut params = HashMap::new();
        params.insert("filterGids", String::new());
        params.insert("tag_id", String::new());
        params.insert("live_insert_type", String::new());
        params.insert("count", count.to_string());
        params.insert("refresh_index", refresh_index.to_string());
        params.insert("video_type_select", "1".to_string());
        params.insert("aweme_pc_rec_raw_data", raw_data);
        params.insert("globalwid", String::new());
        params.insert("pull_type", if cursor <= 0 { "0" } else { "2" }.to_string());
        params.insert("min_window", "0".to_string());
        params.insert("free_right", "0".to_string());
        params.insert("view_count", cursor.max(0).to_string());
        params.insert("plug_block", "0".to_string());
        params.insert("ug_source", String::new());
        params.insert("creative_id", String::new());
        params.insert("webcast_sdk_version", "170400".to_string());
        params.insert("webcast_version_code", "170400".to_string());

        let headers = HashMap::from([(
            "Referer".to_string(),
            "https://www.douyin.com/?recommend=1".to_string(),
        )]);

        let response = self
            .request_raw_json_with_options(
                "https://www.douyin.com/aweme/v1/web/tab/feed/",
                Some(params),
                "GET",
                Some(headers),
                false,
            )
            .await?;

        let status_code = response["status_code"].as_i64().unwrap_or(-1);
        if status_code != 0 {
            let status_msg = response["status_msg"]
                .as_str()
                .or_else(|| response["message"].as_str())
                .unwrap_or("unknown error");
            return Err(anyhow!("API error: {}", status_msg));
        }

        let has_more = response["has_more"]
            .as_bool()
            .or_else(|| response["has_more"].as_i64().map(|v| v == 1))
            .unwrap_or(false);
        let next_cursor = response["cursor"]
            .as_i64()
            .or_else(|| response["max_cursor"].as_i64())
            .or_else(|| response["min_cursor"].as_i64())
            .unwrap_or_else(|| if has_more { refresh_index } else { cursor });

        let videos = if let Some(list) = response["aweme_list"].as_array() {
            // 预解析 fallback 与 aweme_id，避免在并发任务里持有 list 借用。
            // tab/feed 返回的视频字段不完整（缺少可播放地址），需要逐个请求 detail 刷新。
            // 用 buffered(4) 并发请求，保持原列表顺序，与 Python 版行为一致。
            let prepared: Vec<(String, Option<VideoInfo>)> = list
                .iter()
                .map(|value| {
                    let fallback = self.parse_video_info(value).ok();
                    let aweme_id = value["aweme_id"]
                        .as_str()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_string)
                        .or_else(|| fallback.as_ref().map(|video| video.aweme_id.clone()))
                        .unwrap_or_default();
                    (aweme_id, fallback)
                })
                .collect();

            use futures::stream::{self, StreamExt};
            const HYDRATE_CONCURRENCY: usize = 4;
            let aweme_ids: Vec<String> = prepared
                .iter()
                .map(|(aweme_id, _)| aweme_id.clone())
                .collect();
            let hydrated: Vec<Option<VideoInfo>> = stream::iter(aweme_ids)
                .map(|aweme_id| async move {
                    if aweme_id.is_empty() {
                        return None;
                    }
                    match self.get_video_detail(&aweme_id).await {
                        Ok(detail) if is_valid_recommended_video(&detail) => Some(detail),
                        Ok(_) => {
                            log::warn!(
                                "home recommended detail had no playable media: aweme_id={}",
                                aweme_id
                            );
                            None
                        }
                        Err(error) => {
                            log::warn!(
                                "home recommended detail hydration failed: aweme_id={} error={}",
                                aweme_id,
                                error
                            );
                            None
                        }
                    }
                })
                .buffered(HYDRATE_CONCURRENCY)
                .collect()
                .await;

            let mut videos = Vec::new();
            let mut seen_ids = HashSet::new();
            let mut hydrated_count = 0usize;
            for ((_, fallback), maybe_detail) in prepared.into_iter().zip(hydrated) {
                if maybe_detail.is_some() {
                    hydrated_count += 1;
                }
                let video = maybe_detail.or(fallback.filter(is_valid_recommended_video));
                let Some(video) = video else { continue };
                if !video.aweme_id.trim().is_empty() && !seen_ids.insert(video.aweme_id.clone()) {
                    continue;
                }
                videos.push(video);
            }

            if hydrated_count > 0 {
                log::debug!(
                    "home recommended detail hydration completed: {}/{}",
                    hydrated_count,
                    videos.len()
                );
            }
            videos
        } else {
            Vec::new()
        };

        Ok((videos, next_cursor, has_more))
    }

    /// 获取评论列表

    /// 解析分享链接
    pub async fn parse_share_link(&self, url: &str) -> Result<VideoInfo> {
        let share_url =
            Self::extract_share_url(url).ok_or_else(|| anyhow!("Share link is empty"))?;

        if let Some(aweme_id) = Self::extract_aweme_id(&share_url) {
            return self.get_video_detail(&aweme_id).await;
        }

        // 先请求获取重定向后的 URL
        let response = self
            .client
            .get(&share_url)
            .header("User-Agent", get_user_agent())
            .send()
            .await?;

        let final_url = response.url().to_string();

        // 提取视频 ID
        let aweme_id = Self::extract_aweme_id(&final_url)
            .ok_or_else(|| anyhow!("Cannot extract video ID from URL"))?;

        self.get_video_detail(&aweme_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::DouyinClient;
    use crate::api::MediaType;
    use crate::config::AppConfig;
    use serde_json::json;

    #[test]
    fn extracts_share_url_from_copied_text() {
        let text = "1.23 复制打开抖音 https://v.douyin.com/iRNBho6/，看TA的作品";
        assert_eq!(
            DouyinClient::extract_share_url(text).as_deref(),
            Some("https://v.douyin.com/iRNBho6/")
        );
    }

    #[test]
    fn normalizes_www_share_url() {
        assert_eq!(
            DouyinClient::extract_share_url("www.douyin.com/video/7341234567890123456。")
                .as_deref(),
            Some("https://www.douyin.com/video/7341234567890123456")
        );
    }

    #[test]
    fn extracts_aweme_id_from_common_link_shapes() {
        assert_eq!(
            DouyinClient::extract_aweme_id("https://www.douyin.com/video/7341234567890123456"),
            Some("7341234567890123456".to_string())
        );
        assert_eq!(
            DouyinClient::extract_aweme_id("https://www.douyin.com/note/7341234567890123456"),
            Some("7341234567890123456".to_string())
        );
        assert_eq!(
            DouyinClient::extract_aweme_id("https://www.douyin.com/?modal_id=7341234567890123456"),
            Some("7341234567890123456".to_string())
        );
        assert_eq!(
            DouyinClient::extract_aweme_id("7341234567890123456"),
            Some("7341234567890123456".to_string())
        );
    }

    #[test]
    fn selects_dash_audio_url_from_object_and_array_shapes() {
        let object_shape = json!({
            "bit_rate_audio": [{
                "audio_meta": {
                    "url_list": {
                        "main_url": "",
                        "backup_url": "https://example.com/audio-backup.mp4",
                        "fallback_url": "https://example.com/audio-fallback.mp4"
                    }
                }
            }]
        });
        assert_eq!(
            DouyinClient::select_dash_audio_url(&object_shape).as_deref(),
            Some("https://example.com/audio-backup.mp4")
        );

        let array_shape = json!({
            "bit_rate_audio": [{
                "audio_meta": {
                    "url_list": [
                        "",
                        "https://example.com/audio-array.mp4"
                    ]
                }
            }]
        });
        assert_eq!(
            DouyinClient::select_dash_audio_url(&array_shape).as_deref(),
            Some("https://example.com/audio-array.mp4")
        );
    }

    #[test]
    fn live_photo_post_does_not_add_static_cover_as_extra_media() {
        let client = DouyinClient::new(AppConfig::default()).expect("client");
        let post = json!({
            "aweme_id": "7341234567890123456",
            "desc": "live photo post",
            "author": {},
            "statistics": {},
            "status": {},
            "video": {},
            "images": [{
                "url_list": [
                    "https://example.com/image-small.webp",
                    "https://example.com/image-large.jpeg"
                ],
                "video": {
                    "play_addr": {
                        "url_list": ["https://example.com/live-photo.mp4"]
                    }
                }
            }]
        });

        let video = client.parse_video_info(&post).expect("video info");

        assert_eq!(
            video.live_photo_urls.as_ref().expect("live photos"),
            &vec!["https://example.com/live-photo.mp4".to_string()]
        );
        assert!(video.image_urls.is_none());
        assert_eq!(video.media_type, MediaType::LivePhoto);
    }
}
