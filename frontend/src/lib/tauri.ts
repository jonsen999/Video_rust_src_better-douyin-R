// ═══════════════════════════════════════════════
// Tauri IPC Wrappers
// ═══════════════════════════════════════════════

import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type {
  AppConfig,
  ApiResponse,
  BitRateInfo,
  CookieStatus,
  CollectedMixItem,
  CollectedMixesResponse,
  CollectedVideosResponse,
  DownloadFilesResult,
  DownloadProgress,
  HistoryItem,
  LikedAuthorsResponse,
  LikedVideosResponse,
  LinkParseResponse,
  MixVideosResponse,
  RecommendedResponse,
  SearchUserResponse,
  Statistics,
  UserDetailResponse,
  UserInfo,
  UserVideosResponse,
  VideoData,
  VideoDetailResponse,
  VideoInfo,
  VideoMediaUrl,
} from "./contracts";

export type * from "./contracts";

import {
  getErrorMessage,
  normalizeHistoryItem,
  normalizeLikedVideo,
  normalizeUser,
  normalizeVideo,
  normalizeVideos,
} from "./normalizers";

export {
  getErrorMessage,
  normalizeHistoryItem,
  normalizeLikedVideo,
  normalizeUser,
  normalizeVideo,
  normalizeVideos,
} from "./normalizers";

const MEDIA_PROXY_BASE = "http://127.0.0.1:39143/api/media/proxy";
const LOCAL_MEDIA_BASE = "http://127.0.0.1:39143/api/local-media";

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(new Error("Tauri API unavailable"));
  }

  return tauriInvoke<T>(command, args)
    .then((result) => {
      emitCookieInvalidIfNeeded(result);
      return result;
    })
    .catch((error) => {
      emitCookieInvalidFromError(error);
      throw error;
    });
}

function emitCookieInvalidIfNeeded(payload: unknown) {
  if (!payload || typeof payload !== "object") return;
  const data = payload as Record<string, unknown>;
  const message = String(data.message || "Cookie 已失效，请重新登录").trim();
  const failedWithLoginMessage = data.success === false && isCookieInvalidMessage(message);
  if (!data.need_login && !failedWithLoginMessage) return;

  window.dispatchEvent(new CustomEvent("dy-cookie-invalid", { detail: { message } }));
}

function emitCookieInvalidFromError(error: unknown) {
  const message = getErrorMessage(error, "");
  if (!message) return;
  if (!isCookieInvalidMessage(message)) return;
  window.dispatchEvent(new CustomEvent("dy-cookie-invalid", { detail: { message } }));
}

function isCookieInvalidMessage(message: string) {
  return /用户未登录|未登录|请先登录|请先设置\s*Cookie|登录态|重新登录|not login|not logged in|login required|session expired/i.test(message);
}

export function mediaProxyUrl(url: string | null | undefined, mediaType = "image"): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return trimmed;
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("127.0.0.1:39143/api/media/proxy") ||
    trimmed.includes("127.0.0.1:39143/api/local-media")
  ) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return trimmed;
    return `${MEDIA_PROXY_BASE}?url=${encodeURIComponent(trimmed)}&media_type=${encodeURIComponent(mediaType)}`;
  } catch {
    return trimmed;
  }
}

export function localFileAssetUrl(path: string | null | undefined): string {
  const raw = path || "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return trimmed;
  if (trimmed.includes("127.0.0.1:39143/api/local-media")) return trimmed;
  return `${LOCAL_MEDIA_BASE}?path=${encodeURIComponent(raw)}`;
}

// ── Tauri event listener ──

type TauriUnlisten = () => void;

export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<TauriUnlisten> {
  if (!isTauri()) {
    return () => {};
  }

  return tauriListen<T>(event, (ev) => handler(ev.payload));
}

// ── Tauri invoke wrappers ──

export async function initClient(): Promise<{ success: boolean }> {
  return invoke("init_client");
}

export async function getAppVersion(): Promise<string> {
  return invoke("get_app_version");
}

export async function checkUpdate(): Promise<{
  success: boolean;
  has_update: boolean;
  version?: string;
  current_version?: string;
  notes?: string;
  message?: string;
  download_url?: string;
  asset_name?: string;
  asset_size?: number;
  portable?: boolean;
  install_mode?: string;
}> {
  return invoke("check_update");
}

export async function downloadUpdate(): Promise<{
  success: boolean;
  message: string;
  mode?: string;
  portable?: boolean;
  install_mode?: string;
  restart_required?: boolean;
  download_url?: string;
  file_path?: string;
}> {
  return invoke("download_update");
}

export async function restartApp(): Promise<void> {
  return invoke("restart_app");
}

// Config

export async function getConfig(): Promise<AppConfig> {
  return invoke("get_config");
}

export async function saveConfig(config: Partial<AppConfig>): Promise<{ success: boolean; message: string }> {
  const current = await getConfig().catch(() => ({} as Partial<AppConfig>));
  const nextConfig: AppConfig = {
    download_path: config.download_path ?? config.download_dir ?? current.download_path ?? current.download_dir ?? "",
    filename_template: config.filename_template ?? current.filename_template ?? "{title}_{aweme_id}",
    max_concurrent: config.max_concurrent ?? current.max_concurrent ?? 3,
    download_quality: config.download_quality ?? current.download_quality ?? "auto",
    auto_create_folder: config.auto_create_folder ?? current.auto_create_folder ?? true,
    folder_name_template: config.folder_name_template ?? current.folder_name_template ?? "{author}",
    save_metadata: config.save_metadata ?? current.save_metadata ?? true,
    proxy: config.proxy ?? current.proxy ?? null,
    cookie: config.cookie ?? "",
    theme: config.theme ?? current.theme ?? "dark",
    language: config.language ?? current.language ?? "zh-CN",
  };
  return invoke("save_config", { config: nextConfig });
}

export async function selectDirectory(): Promise<string | null> {
  return invoke("select_directory");
}

// Search & User

export async function searchUser(keyword: string): Promise<SearchUserResponse> {
  const result = await invoke<SearchUserResponse>("search_user", { keyword });
  return {
    ...result,
    user: result.user ? normalizeUser(result.user) : undefined,
    users: Array.isArray(result.users) ? result.users.map(normalizeUser) : undefined,
  };
}

export async function getUserDetail(secUid: string, nickname?: string): Promise<UserDetailResponse> {
  const result = await invoke<UserDetailResponse>("get_user_detail", {
    secUid,
    sec_uid: secUid,
    nickname,
  });
  return {
    ...result,
    user: result.user ? normalizeUser(result.user) : undefined,
  };
}

export async function getUserVideos(secUid: string, count: number, cursor: number): Promise<UserVideosResponse> {
  const result = await invoke<UserVideosResponse & { videos?: unknown[] }>("get_user_videos", {
    secUid,
    sec_uid: secUid,
    count,
    cursor,
  });
  return {
    ...result,
    videos: normalizeVideos(result.videos),
  };
}

export async function getVideoDetail(awemeId: string): Promise<VideoDetailResponse> {
  const result = await invoke<VideoDetailResponse & { video?: unknown }>("get_video_detail", {
    awemeId,
    aweme_id: awemeId,
  });
  return {
    ...result,
    video: normalizeVideo(result.video) || undefined,
  };
}

// Links

export async function parseUrl(url: string): Promise<VideoInfo> {
  const result = await invoke<unknown>("parse_url", { url });
  return normalizeVideo(result) || (result as VideoInfo);
}

export async function parseLink(link: string): Promise<LinkParseResponse> {
  const result = await invoke<LinkParseResponse & { video?: unknown; videos?: unknown[]; user?: unknown }>("parse_link", { link });
  return {
    ...result,
    user: result.user ? normalizeUser(result.user) : undefined,
    video: normalizeVideo(result.video) || undefined,
    videos: normalizeVideos(result.videos),
  };
}

// Download

export async function downloadVideo(video: VideoInfo): Promise<ApiResponse & { task_id?: string }> {
  return invoke("download_video", { video });
}

export async function downloadUserVideos(
  secUid: string,
  nickname: string,
  awemeCount: number
): Promise<ApiResponse & { task_id?: string; total_videos?: number; nickname?: string }> {
  return invoke("download_user_videos", {
    secUid,
    sec_uid: secUid,
    nickname,
    awemeCount,
    aweme_count: awemeCount,
  });
}

export async function downloadLikedVideos(count: number): Promise<ApiResponse & { task_id?: string; total_videos?: number }> {
  return invoke("download_liked_videos", { count });
}

export async function downloadLikedAuthors(count: number): Promise<ApiResponse & { task_id?: string; task_ids?: string[]; count?: number }> {
  return invoke("download_liked_authors", { count });
}

export async function addDownloadTask(video: VideoInfo, savePath?: string): Promise<string> {
  return invoke("add_download_task", { video, savePath, save_path: savePath });
}

export async function startDownload(taskId: string): Promise<void> {
  return invoke("start_download", { taskId, task_id: taskId });
}

export async function getDownloadTasks(): Promise<unknown[]> {
  const result = await invoke<{ success: boolean; tasks?: unknown[] }>("get_download_tasks");
  return result.tasks || [];
}

export async function cancelDownloadTask(taskId: string): Promise<ApiResponse> {
  return invoke("cancel_download_task", { taskId, task_id: taskId });
}

export async function removeDownloadTask(taskId: string): Promise<void> {
  return invoke("remove_download_task", { taskId, task_id: taskId });
}

export async function pauseDownload(taskId: string): Promise<ApiResponse> {
  return invoke("pause_download", { taskId, task_id: taskId });
}

export async function resumeDownload(taskId: string): Promise<ApiResponse> {
  return invoke("resume_download", { taskId, task_id: taskId });
}

// Feed & Likes

export async function getRecommended(cursor: number, count: number): Promise<RecommendedResponse> {
  const result = await invoke<RecommendedResponse & { videos?: unknown[] }>("get_recommended", { cursor, count });
  return {
    ...result,
    videos: normalizeVideos(result.videos),
  };
}

export async function getLikedVideos(
  count: number,
  secUid = "",
  cursor = 0
): Promise<LikedVideosResponse> {
  const result = await invoke<LikedVideosResponse & { data?: unknown[] }>("get_liked_videos", {
    count,
    secUid,
    sec_uid: secUid,
    cursor,
  });

  return {
    ...result,
    data: Array.isArray(result.data)
      ? result.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[]
      : [],
  };
}

export async function getLikedAuthors(count: number): Promise<LikedAuthorsResponse> {
  const result = await invoke<LikedAuthorsResponse & { data?: unknown[] }>("get_liked_authors", { count });
  return {
    ...result,
    data: Array.isArray(result.data) ? result.data.map(normalizeUser) : [],
  };
}

export async function getCollectedVideos(cursor: number, count: number): Promise<CollectedVideosResponse> {
  const result = await invoke<CollectedVideosResponse & { data?: unknown[] }>("get_collected_videos", {
    cursor,
    count,
  });
  return {
    ...result,
    data: Array.isArray(result.data)
      ? (result.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[])
      : [],
  };
}

export async function getCollectedMixes(cursor: number, count: number): Promise<CollectedMixesResponse> {
  const result = await invoke<CollectedMixesResponse & { data?: CollectedMixItem[] }>("get_collected_mixes", {
    cursor,
    count,
  });
  return {
    ...result,
    data: Array.isArray(result.data) ? result.data : [],
  };
}

export async function getMixVideos(seriesId: string, cursor: number, count: number): Promise<MixVideosResponse> {
  const result = await invoke<MixVideosResponse & { data?: unknown[] }>("get_mix_videos", {
    seriesId,
    series_id: seriesId,
    cursor,
    count,
  });
  return {
    ...result,
    data: Array.isArray(result.data) ? normalizeVideos(result.data) : [],
  };
}

export async function getComments(awemeId: string, count: number, cursor?: number): Promise<unknown> {
  return invoke("get_comments", { awemeId, count, cursor });
}

// Cookie

export async function verifyCookie(): Promise<CookieStatus> {
  return invoke("verify_cookie");
}

export async function cookieBrowserLogin(timeout?: number, browser?: string): Promise<{ success: boolean; message: string }> {
  return invoke("cookie_browser_login", { timeout, browser });
}

export async function cancelCookieBrowserLogin(): Promise<{ success: boolean; message: string }> {
  return invoke("cancel_cookie_browser_login");
}

export async function openVerifyBrowser(targetUrl?: string): Promise<{ success: boolean; message: string }> {
  return invoke("open_verify_browser", { targetUrl, target_url: targetUrl });
}

// History

export async function getHistory(): Promise<HistoryItem[]> {
  const result = await invoke<{ success: boolean; items?: unknown[] }>("get_history");
  return (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[];
}

export async function listDownloadFiles(options?: {
  offset?: number;
  limit?: number;
  forceRefresh?: boolean;
  query?: string;
  mediaType?: string;
  sortBy?: string;
}): Promise<HistoryItem[]> {
  const result = await invoke<{ success: boolean; items?: unknown[] }>("list_download_files", {
    offset: options?.offset,
    limit: options?.limit,
    forceRefresh: options?.forceRefresh,
    query: options?.query,
    mediaType: options?.mediaType,
    media_type: options?.mediaType,
    sortBy: options?.sortBy,
    sort_by: options?.sortBy,
  });
  return (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[];
}

export async function listDownloadFilesPage(options: {
  offset?: number;
  limit?: number;
  forceRefresh?: boolean;
  query?: string;
  mediaType?: string;
  sortBy?: string;
} = {}): Promise<DownloadFilesResult> {
  const result = await invoke<{ success: boolean; items?: unknown[]; total?: number; total_size?: number; latest?: unknown }>(
    "list_download_files",
    {
      offset: options.offset,
      limit: options.limit,
      forceRefresh: options.forceRefresh,
      query: options.query,
      mediaType: options.mediaType,
      media_type: options.mediaType,
      sortBy: options.sortBy,
      sort_by: options.sortBy,
    }
  );
  return {
    items: (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[],
    total: Number(result.total ?? 0) || 0,
    totalSize: Number(result.total_size ?? 0) || 0,
    latest: normalizeHistoryItem(result.latest) as HistoryItem | null,
  };
}

export async function clearHistory(): Promise<void> {
  return invoke("clear_history");
}

export async function deleteHistory(id: string): Promise<void> {
  return invoke("delete_history", { awemeId: id, aweme_id: id });
}

export async function addHistory(entry: Omit<HistoryItem, "id">): Promise<void> {
  return invoke("add_history", { entry });
}

// File operations

export async function openFile(path: string): Promise<void> {
  return invoke("open_file", { path });
}

export async function openDownloadDirectory(): Promise<void> {
  return invoke("open_download_directory");
}

export async function openFileLocation(path: string): Promise<void> {
  return invoke("open_file_location", { path });
}

export async function deleteFile(path: string): Promise<void> {
  return invoke("delete_file", { path });
}
