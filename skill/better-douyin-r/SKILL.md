---
name: "better-douyin-r"
description: "Download Douyin videos, parse video metadata, search users, and manage the downloader config via the douyin-dl CLI. Use when the user wants to download a Douyin video, inspect video info, or manage download settings."
---

# better-douyin-R Skill

This skill wraps the `douyin-dl` CLI — a Rust binary that talks to Douyin APIs for parsing video links, downloading videos, searching users, and managing configuration.

## Required user data

The user needs to provide one of:
- **Douyin video URL** — e.g. `https://www.douyin.com/video/7341234567890123456`
- **Share short link** — e.g. `https://v.douyin.com/xxxxx/`
- **Raw aweme_id** — 19-digit numeric ID like `7341234567890123456`

For user searches / profile access:
- **sec_uid** — from `parse` output or a user profile URL like `https://www.douyin.com/user/MS4wLjAB...`

## How to obtain data

### aweme_id (video ID)
1. Open a video in the Douyin app or website
2. Copy the URL from the share button — it looks like `https://www.douyin.com/video/7341234567890123456` or `https://v.douyin.com/xxxxx/`
3. The `douyin-dl parse` command extracts the aweme_id automatically from either format

### sec_uid (user ID)
1. Open a user's profile page at `https://www.douyin.com/user/<sec_uid>`
2. The sec_uid is the long alphanumeric string in the URL after `/user/`
3. Alternatively, run `douyin-dl parse <video_url> --format plain` — the output includes the author's sec_uid

### Cookie (required for most operations)
1. Open `https://www.douyin.com` in a browser and log in
2. Open DevTools → Network tab → find any XHR request to `douyin.com`
3. Copy the full `Cookie` request header
4. Set it: `douyin-dl config set cookie "<paste here>"`

## Prerequisites

### Build the CLI (one-time)
```bash
cd src-tauri && cargo build --release --bin douyin-dl
```

The binary will be at `src-tauri/target/release/douyin-dl`.

Symlink it somewhere in PATH for convenience:
```bash
ln -sf "$(pwd)/src-tauri/target/release/douyin-dl" /usr/local/bin/douyin-dl
```

Or set the full path in the skill environment.

### Verify setup
```bash
douyin-dl config show          # ← check config
douyin-dl parse --help         # ← verify CLI works
```

## Command reference

### Parse a video URL

Show video metadata in JSON:
```bash
douyin-dl parse "https://www.douyin.com/video/7341234567890123456"
```

Human-readable output:
```bash
douyin-dl parse --format plain "https://v.douyin.com/xxxxx/"
```

Both full URLs and share short links work. The command prints aweme_id, title, author, sec_uid, statistics, media URLs, and cover.

### Download a video

```bash
douyin-dl download "https://www.douyin.com/video/7341234567890123456"
```

Specify a custom output directory:
```bash
douyin-dl download -o ~/Videos/douyin "https://v.douyin.com/xxxxx/"
```

Progress is printed to stderr. On success, the output file path is printed to stdout.

### Manage configuration

Show current config:
```bash
douyin-dl config show
```

Set config values:
```bash
douyin-dl config set cookie "<cookie-string>"
douyin-dl config set download_path "/Users/me/Downloads/Douyin"
douyin-dl config set max_concurrent 5
douyin-dl config set download_quality highest
douyin-dl config set filename_template "{author}_{title}"
```

Supported config keys: `cookie`, `download_path`, `proxy`, `max_concurrent`, `download_quality` (auto/highest/h264/smallest/480p/720p/1080p/2k/4k), `filename_template`, `folder_name_template`, `auto_create_folder`, `save_metadata`, `theme`, `language`.

The config file is at `~/Library/Application Support/better-douyin-R/config.json` (macOS) or equivalent platform dir. It is shared with the Tauri desktop app.

### Search users

```bash
douyin-dl search "some nickname"
douyin-dl search --format plain "keyword"
```

JSON output includes nickname, sec_uid, follower count, avatar URLs, and signature.

### Get user profile and videos

```bash
douyin-dl user "<sec_uid>"
douyin-dl user --limit 10 --format plain "<sec_uid>"
```

Shows user info + their most recent videos.

### Get recommended feed

```bash
douyin-dl feed
douyin-dl feed --count 20
```

Requires a valid cookie. Outputs JSON (pretty-printed to terminal, compact to pipe).

## Error handling

| Symptom | Fix |
|---|---|
| "请先设置Cookie" | Run `douyin-dl config set cookie "<cookie>"` |
| "需要滑块验证" | Visit the verification URL in a browser, complete the challenge, then retry |
| "解析分享链接失败" | The short link may have expired or require authentication. Try the full `/video/<id>` URL |
| "视频已下载" | The video was already downloaded (dedup by aweme_id) |

## Extensibility

The CLI lives at `src-tauri/src/bin/douyin-dl.rs`. To add a new command:

1. Add a variant to the `Commands` enum
2. Implement an `async fn cmd_xxx()` handler
3. Add a match arm in `main()`

All Douyin API types and client methods are public in `app_lib::api`, `app_lib::config`, and `app_lib::downloader`. New commands can reuse them without modifying existing modules.

## Key command sequence for download

The typical workflow to help a user download:

1. `douyin-dl config show` — make sure cookie is set
2. `douyin-dl parse "<user's URL>"` — verify the video exists and show info
3. `douyin-dl download "<user's URL>"` — download it

If the user only provides a share link that looks like `https://v.douyin.com/xxxx/`, pass it directly — the CLI handles redirect resolution.
