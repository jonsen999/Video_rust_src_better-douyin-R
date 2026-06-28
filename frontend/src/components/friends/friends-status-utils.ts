import type { FriendOnlineStatusResponse } from "@/lib/tauri";
import {
  CHAT_DRAFTS_KEY,
  CHAT_MESSAGES_KEY,
  CHAT_SUMMARIES_KEY,
  CHAT_UNREAD_KEY,
  ONLINE_WINDOW_SECONDS,
  type ChatDrafts,
  type ChatMessages,
  type ChatSummaries,
  type FriendStatusItem,
  type JsonRecord,
  type LocalChatMessage,
  type UnreadCounts,
} from "./friends-status-types";
import {
  compactChatMessagesForStorage,
  normalizeStoredChatMessage,
} from "./friends-message-utils";
import {
  formatLastActive,
} from "./friends-status-format";

export * from "./friends-message-utils";
export * from "./friends-status-format";

// ==================== localStorage 持久化 ====================

export function getNamespacedKey(baseKey: string, currentSecUid?: string): string {
  if (!currentSecUid) return baseKey;
  return `${baseKey}.${currentSecUid}`;
}

export function readChatDrafts(currentSecUid?: string): ChatDrafts {
  try {
    const key = getNamespacedKey(CHAT_DRAFTS_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return isRecord(parsed) ? Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string"),
    ) as ChatDrafts : {};
  } catch {
    return {};
  }
}

export function readChatMessages(currentSecUid?: string): ChatMessages {
  try {
    const key = getNamespacedKey(CHAT_MESSAGES_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    if (!isRecord(parsed)) return {};
    const result: ChatMessages = {};
    for (const [secUid, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const messages: LocalChatMessage[] = value
        .filter(isRecord)
        .map((message) => normalizeStoredChatMessage(secUid, message))
        .filter((message) => {
          if (!message.text || message.createdAt <= 0) return false;
          if (message.text.trim().startsWith('{') && message.text.includes("command_type")) {
            return false;
          }
          return true;
        });
      if (messages.length > 0) {
        result[secUid] = messages;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function readUnreadCounts(currentSecUid?: string): UnreadCounts {
  try {
    const key = getNamespacedKey(CHAT_UNREAD_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    if (!isRecord(parsed)) return {};
    const result: UnreadCounts = {};
    for (const [keyVal, value] of Object.entries(parsed)) {
      const count = Math.max(0, Number(value) || 0);
      if (count > 0) result[keyVal] = count;
    }
    return result;
  } catch {
    return {};
  }
}

export function readChatSummaries(currentSecUid?: string): ChatSummaries {
  try {
    const key = getNamespacedKey(CHAT_SUMMARIES_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    if (!isRecord(parsed)) return {};
    const result: ChatSummaries = {};
    for (const [secUid, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const latestRaw = isRecord(value.latestMessage) ? value.latestMessage : undefined;
      const latestMessage = latestRaw ? {
        id: stringField(latestRaw, ["id"]) || `${secUid}-${numberField(latestRaw, ["createdAt"])}`,
        text: stringField(latestRaw, ["text"]),
        rawContent: stringField(latestRaw, ["rawContent", "raw_content"]) || undefined,
        imagePreviewUrl: stringField(latestRaw, ["imagePreviewUrl"]).startsWith("blob:") ? undefined : stringField(latestRaw, ["imagePreviewUrl"]) || undefined,
        createdAt: numberField(latestRaw, ["createdAt"]),
        status: normalizeMessageStatus(stringField(latestRaw, ["status"])),
        direction: normalizeMessageDirection(stringField(latestRaw, ["direction"])),
        senderUid: stringField(latestRaw, ["senderUid", "sender_uid"]),
        error: stringField(latestRaw, ["error"]) || undefined,
      } : undefined;
      const latestMessageAt = Math.max(
        numberField(value, ["latestMessageAt"]),
        latestMessage?.createdAt || 0,
      );
      const unreadCount = Math.max(0, numberField(value, ["unreadCount"]));
      if (latestMessageAt > 0 || unreadCount > 0) {
        result[secUid] = {
          latestMessage: latestMessage?.text ? latestMessage : undefined,
          latestMessageAt,
          unreadCount,
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota errors
  }
}

export function persistChatMessages(messages: ChatMessages, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_MESSAGES_KEY, currentSecUid);
  const next = compactChatMessagesForStorage(messages);
  safeSetLocalStorage(key, JSON.stringify(next));
}

export function sanitizePersistedSummaries(summaries: ChatSummaries): ChatSummaries {
  const result: ChatSummaries = {};
  for (const [secUid, value] of Object.entries(summaries)) {
    result[secUid] = {
      latestMessage: value.latestMessage ? {
        id: value.latestMessage.id,
        text: value.latestMessage.text,
        createdAt: value.latestMessage.createdAt,
        status: value.latestMessage.status === "pending" ? "error" : value.latestMessage.status,
        direction: value.latestMessage.direction,
        senderUid: value.latestMessage.senderUid,
        error: value.latestMessage.status === "pending" ? "发送未完成" : value.latestMessage.error,
      } : undefined,
      latestMessageAt: value.latestMessageAt,
      unreadCount: value.unreadCount,
    };
  }
  return result;
}

export function persistChatSummaries(summaries: ChatSummaries, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_SUMMARIES_KEY, currentSecUid);
  const next = sanitizePersistedSummaries(summaries);
  safeSetLocalStorage(key, JSON.stringify(next));
}

export function persistChatDrafts(drafts: ChatDrafts, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_DRAFTS_KEY, currentSecUid);
  safeSetLocalStorage(key, JSON.stringify(drafts));
}

export function persistUnreadCounts(counts: UnreadCounts, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_UNREAD_KEY, currentSecUid);
  safeSetLocalStorage(key, JSON.stringify(counts));
}

export function normalizeMessageStatus(value: string): LocalChatMessage["status"] {
  if (value === "pending" || value === "error") return value;
  return "sent";
}

export function normalizeMessageDirection(value: string): LocalChatMessage["direction"] {
  return value === "in" ? "in" : "out";
}

export function normalizeImUrl(value: string) {
  if (!value) return "";
  return value.replace(/^http:/, "https:");
}

export function unsignedMediaUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.searchParams.delete("x-expires");
    url.searchParams.delete("x-signature");
    return url.toString();
  } catch {
    return value;
  }
}

export function firstUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    return firstUrl(value[0]);
  }
  if (isRecord(value)) {
    const list = value.url_list || value.urlList;
    if (Array.isArray(list) && list.length > 0) {
      return firstUrl(list[0]);
    }
  }
  return "";
}

export function inlineImageDataUrl(value: string) {
  if (!value) return "";
  if (value.startsWith("data:image/")) return value;
  return `data:image/jpeg;base64,${value}`;
}

export function imageMessageRawContent(imageDataUrl: string, width = 0, height = 0, fileName = "") {
  return JSON.stringify({
    aweType: 2704,
    type: 7,
    inline_pic: imageDataUrl.replace(/^data:image\/[a-z]+;base64,/, ""),
    width,
    height,
    file_name: fileName,
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

export function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = src;
  });
}

export function deepStringField(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

export function deepFirstUrl(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = firstUrl(record[key]);
    if (value) return value;
  }
  return "";
}

export function hasDeepField(record: JsonRecord, keys: string[]) {
  return keys.some((key) => record[key] !== undefined);
}

export function parseJsonContent(value: string): JsonRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function walkRecords(value: unknown, visit: (record: JsonRecord) => void) {
  if (isRecord(value)) {
    visit(value);
    Object.values(value).forEach((child) => walkRecords(child, visit));
  } else if (Array.isArray(value)) {
    value.forEach((child) => walkRecords(child, visit));
  }
}

export function arrayField(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function stringField(record: JsonRecord | undefined, keys: string[]) {
  if (!record) return "";
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
    if (typeof record[key] === "number" || typeof record[key] === "boolean") return String(record[key]);
  }
  return "";
}

export function numberField(record: JsonRecord | undefined, keys: string[]) {
  if (!record) return 0;
  for (const key of keys) {
    if (typeof record[key] === "number") return record[key] as number;
    if (typeof record[key] === "string") {
      const parsed = Number(record[key]);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

export function extractSecUid(record: JsonRecord) {
  return stringField(record, ["sec_uid", "secUid", "sec_user_id", "secUserId"]);
}

export function extractAvatar(record: JsonRecord | undefined) {
  if (!record) return "";
  const avatar = record.avatar_thumb || record.avatarThumb || record.avatar_medium || record.avatarMedium;
  const url = firstUrl(avatar);
  if (url) return url;
  const schema = stringField(record, ["avatar_uri", "avatarUri", "uri"]);
  if (schema) return schema;
  return "";
}

export function extractIds(text: string) {
  const matches = text.match(/MS4w\.?LjAB[A-Za-z0-9_-]+/g) || [];
  const lines = text
    .split(/[\n,\s]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.startsWith("MS4wLjAB") || item.startsWith("MS4w.LjAB"));
  return Array.from(new Set([...matches, ...lines]));
}

// ==================== 在线状态响应解析 ====================

export function responseNowSeconds(response: FriendOnlineStatusResponse) {
  const active = response.active_status;
  if (isRecord(active) && isRecord(active.extra)) {
    const now = numberField(active.extra, ["now"]);
    if (now > 1_000_000_000_000) return Math.floor(now / 1000);
    if (now > 0) return Math.floor(now);
  }
  return Math.floor(Date.now() / 1000);
}

export function collectRecordsBySecUid(value: unknown) {
  const map = new Map<string, JsonRecord>();
  const direct = arrayField(value);
  if (direct.length > 0) {
    direct.forEach((record) => {
      const secUid = extractSecUid(record);
      if (secUid) map.set(secUid, record);
    });
    return map;
  }

  walkRecords(value, (record) => {
    const secUid = extractSecUid(record);
    if (secUid) map.set(secUid, record);
  });
  return map;
}

export function mapResponse(response: FriendOnlineStatusResponse): FriendStatusItem[] {
  const nowSeconds = responseNowSeconds(response);
  const users = collectRecordsBySecUid(response.user_info);
  const statuses = collectRecordsBySecUid(response.active_status);
  const ids = Array.from(new Set([...statuses.keys(), ...users.keys(), ...(response.sec_user_ids || [])]));

  return ids
    .map((secUid) => {
      const user = users.get(secUid);
      const status = statuses.get(secUid);
      const lastActiveTime = numberField(status, ["last_active_time", "active_time", "last_seen"]);
      const online =
        lastActiveTime > 0 &&
        nowSeconds - lastActiveTime >= 0 &&
        nowSeconds - lastActiveTime <= 60; // ONLINE_WINDOW_SECONDS

      return {
        secUid,
        uid: stringField(user, ["uid", "user_id", "id", "uid_str", "short_id"]),
        nickname: stringField(user, ["nickname", "nick_name", "display_name", "unique_id"]),
        remarkName: stringField(user, ["remark_name"]),
        avatar: extractAvatar(user),
        signature: stringField(user, ["signature", "desc"]),
        online,
        statusText: online ? "在线" : lastActiveTime > 0 ? "最近活跃" : "未显示",
        lastActive: formatLastActive(lastActiveTime),
        lastActiveTime,
      };
    })
    .sort((a, b) => {
      if (!a.lastActiveTime && !b.lastActiveTime) return 0;
      if (!a.lastActiveTime) return 1;
      if (!b.lastActiveTime) return -1;
      return b.lastActiveTime - a.lastActiveTime;
    });
}
