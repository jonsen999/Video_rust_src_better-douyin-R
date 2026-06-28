import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import {
  getFriendChatState,
  getFriendMessageHistory,
  listenEvent,
  saveFriendChatState,
  sendFriendImageMessage,
  sendFriendMessage,
} from "@/lib/tauri";
import type { FriendMessageHistoryItem, UserInfo } from "@/lib/contracts";
import {
  COOKIE_REQUIRED_PATTERN,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  MAX_SEND_IMAGE_BYTES,
  STORAGE_KEY,
  type ChatDrafts,
  type ChatMessages,
  type ChatSummaries,
  type FriendStatusItem,
  type HistoryPageState,
  type ImConnectionStatus,
  type JsonRecord,
  type LocalChatMessage,
  type UnreadCounts,
} from "./friends-status-types";
import {
  fallbackMessageText,
  imageMessageRawContent,
  isRecord,
  latestChatMessage,
  messagePreviewText,
  normalizeMessageDirection,
  normalizeMessageStatus,
  numberField,
  persistChatDrafts,
  persistChatMessages,
  persistChatSummaries,
  persistUnreadCounts,
  readChatDrafts,
  readChatMessages,
  readChatSummaries,
  readUnreadCounts,
  readFileAsDataUrl,
  readImageSize,
  stringField,
} from "./friends-status-utils";

export function useFriendsChat(
  friends: FriendStatusItem[],
  currentSecUid: string,
  setError: (msg: string) => void
) {
  const setFriendUnreadCount = useAppStore((state) => state.setFriendUnreadCount);

  const [chatDrafts, setChatDrafts] = useState<ChatDrafts>(() => readChatDrafts(currentSecUid));
  const [chatMessages, setChatMessages] = useState<ChatMessages>(() => readChatMessages(currentSecUid));
  const [unreadCounts, setUnreadCounts] = useState<UnreadCounts>(() => readUnreadCounts(currentSecUid));
  const [chatSummaries, setChatSummaries] = useState<ChatSummaries>(() => readChatSummaries(currentSecUid));
  const [selectedFriendId, setSelectedFriendId] = useState("");
  const [historyState, setHistoryState] = useState<HistoryPageState>({});

  const [imStatus, setImStatus] = useState<ImConnectionStatus>({
    connected: false,
    message: "接收通道未连接",
    updatedAt: 0,
  });

  const chatStateLoadedRef = useRef(false);
  const selectedFriendIdRef = useRef(selectedFriendId);
  const currentSecUidRef = useRef(currentSecUid);

  useEffect(() => {
    currentSecUidRef.current = currentSecUid;
    if (currentSecUid) {
      setChatDrafts(readChatDrafts(currentSecUid));
      setChatMessages(readChatMessages(currentSecUid));
      setUnreadCounts(readUnreadCounts(currentSecUid));
      setChatSummaries(readChatSummaries(currentSecUid));
    }
  }, [currentSecUid]);

  useEffect(() => {
    selectedFriendIdRef.current = selectedFriendId;
  }, [selectedFriendId]);

  const selectedFriend = useMemo(
    () => friends.find((friend) => friend.secUid === selectedFriendId) || null,
    [friends, selectedFriendId],
  );

  const selectedMessages = selectedFriend ? chatMessages[selectedFriend.secUid] || [] : [];
  const selectedHistory = selectedFriend ? historyState[selectedFriend.secUid] : undefined;

  const updateDraft = useCallback((secUid: string, value: string) => {
    setChatDrafts((current) => {
      const next = { ...current };
      if (value) {
        next[secUid] = value;
      } else {
        delete next[secUid];
      }
      persistChatDrafts(next, currentSecUidRef.current);
      return next;
    });
  }, []);

  const patchMessage = useCallback((secUid: string, messageId: string, patch: Partial<LocalChatMessage>) => {
    setChatMessages((current) => {
      const next = {
        ...current,
        [secUid]: (current[secUid] || []).map((message) =>
          message.id === messageId ? { ...message, ...patch } : message,
        ),
      };
      persistChatMessages(next, currentSecUidRef.current);
      return next;
    });
  }, []);

  const clearUnread = useCallback((secUid: string) => {
    setUnreadCounts((current) => {
      const next = { ...current };
      delete next[secUid];
      persistUnreadCounts(next, currentSecUidRef.current);
      return next;
    });
    setChatSummaries((current) => {
      const summary = current[secUid];
      if (!summary || summary.unreadCount === 0) return current;
      const next = {
        ...current,
        [secUid]: {
          ...summary,
          unreadCount: 0,
        },
      };
      persistChatSummaries(next, currentSecUidRef.current);
      return next;
    });
  }, []);

  const sendLocalMessage = useCallback(async (friend: FriendStatusItem, value: string) => {
    const text = value.trim();
    if (!text) return;
    const message: LocalChatMessage = {
      id: `${friend.secUid}-${Date.now()}`,
      text,
      rawContent: undefined,
      createdAt: Date.now(),
      status: "pending",
      direction: "out",
    };
    setChatMessages((current) => {
      const next = {
        ...current,
        [friend.secUid]: [...(current[friend.secUid] || []), message],
      };
      persistChatMessages(next, currentSecUidRef.current);
      return next;
    });
    updateDraft(friend.secUid, "");

    if (!friend.uid) {
      patchMessage(friend.secUid, message.id, {
        status: "error",
        error: "缺少好友数字 uid，无法发送",
      });
      return;
    }

    try {
      const result = await sendFriendMessage({ toUserId: friend.uid, content: text });
      if (!result.success) {
        throw new Error(result.message || "发送失败");
      }
      patchMessage(friend.secUid, message.id, { status: "sent", error: "" });
    } catch (caught) {
      patchMessage(friend.secUid, message.id, {
        status: "error",
        error: caught instanceof Error ? caught.message : "发送失败",
      });
    }
  }, [patchMessage, updateDraft]);

  const sendLocalImageMessage = useCallback(async (friend: FriendStatusItem, file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (file.size > MAX_SEND_IMAGE_BYTES) {
      setError("图片不能超过 8MB");
      return;
    }
    if (!friend.uid) {
      setError("缺少好友数字 uid，无法发送图片");
      return;
    }
    setError("");
    const imageDataUrl = await readFileAsDataUrl(file);
    if (!imageDataUrl) {
      setError("读取图片失败");
      return;
    }
    const size = await readImageSize(imageDataUrl);
    const message: LocalChatMessage = {
      id: `${friend.secUid}-${Date.now()}`,
      text: "[图片]",
      rawContent: imageMessageRawContent("", size.width, size.height, file.name),
      imagePreviewUrl: URL.createObjectURL(file),
      createdAt: Date.now(),
      status: "pending",
      direction: "out",
    };
    setChatMessages((current) => {
      const next = {
        ...current,
        [friend.secUid]: [...(current[friend.secUid] || []), message],
      };
      persistChatMessages(next, currentSecUidRef.current);
      return next;
    });

    try {
      const result = await sendFriendImageMessage({
        toUserId: friend.uid,
        imageDataUrl,
        width: size.width,
        height: size.height,
        fileName: file.name,
        mimeType: file.type,
      });
      if (!result.success) {
        throw new Error(result.message || "发送图片失败");
      }
      patchMessage(friend.secUid, message.id, { status: "sent", error: "" });
    } catch (caught) {
      patchMessage(friend.secUid, message.id, {
        status: "error",
        error: caught instanceof Error ? caught.message : "发送图片失败",
      });
    }
  }, [patchMessage, setError]);

  const selectFriend = useCallback((friend: FriendStatusItem) => {
    setSelectedFriendId(friend.secUid);
    clearUnread(friend.secUid);
  }, [clearUnread]);

  const mergeHistoryMessages = useCallback((items: FriendMessageHistoryItem[], fallbackFriend?: FriendStatusItem | null) => {
    if (!items.length) return 0;
    let mergedCount = 0;
    setChatMessages((current) => {
      const next: ChatMessages = { ...current };
      for (const item of items) {
        const conversationId = stringField(item as JsonRecord, ["conversation_id", "conversationId"]);
        const senderUid = stringField(item as JsonRecord, ["sender_uid", "senderUid"]);
        const rawContent = stringField(item as JsonRecord, ["raw_content", "rawContent"]) || undefined;
        const text = stringField(item as JsonRecord, ["content", "text"]) || fallbackMessageText(rawContent);
        const messageId = stringField(item as JsonRecord, ["server_message_id", "message_id", "id"]);
        if (!text) continue;
        if (text.trim().startsWith('{') && text.includes("command_type")) {
          continue;
        }
        const friend = fallbackFriend || friends.find((candidate) =>
          (senderUid && candidate.uid === senderUid) ||
          (candidate.uid && conversationId.includes(candidate.uid))
        );
        if (!friend) continue;
        const rawCreatedAt = numberField(item as JsonRecord, ["created_at", "createdAt", "create_time", "createTime"]);
        const createdAt = rawCreatedAt > 0 && rawCreatedAt < 10_000_000_000
          ? rawCreatedAt * 1000
          : rawCreatedAt || Date.now();
        const message: LocalChatMessage = {
          id: messageId || `${friend.secUid}-${createdAt}`,
          text,
          rawContent,
          createdAt,
          status: "sent",
          direction: senderUid && senderUid === friend.uid ? "in" : "out",
          senderUid,
        };
        const currentMessages = next[friend.secUid] || [];
        if (currentMessages.some((existing) => existing.id === message.id)) continue;
        next[friend.secUid] = [...currentMessages, message].sort((a, b) => a.createdAt - b.createdAt);
        mergedCount += 1;
      }
      if (mergedCount > 0) {
        persistChatMessages(next, currentSecUidRef.current);
        return next;
      }
      return current;
    });
    return mergedCount;
  }, [friends]);

  const loadHistoryMessages = useCallback(async (friend: FriendStatusItem, cursor = 0) => {
    const current = historyState[friend.secUid];
    if (current?.loading) return;
    if (cursor > 0 && current?.hasMore === false) return;
    const currentMessages = chatMessages[friend.secUid] || [];
    setHistoryState((state) => ({
      ...state,
      [friend.secUid]: {
        loaded: Boolean(state[friend.secUid]?.loaded),
        loading: true,
        nextCursor: state[friend.secUid]?.nextCursor || 0,
        hasMore: state[friend.secUid]?.hasMore ?? true,
        error: "",
      },
    }));
    try {
      const result = await getFriendMessageHistory({ cursor, toUserId: friend.uid });
      if (!result.success) {
        throw new Error(result.message || "获取历史消息失败");
      }
      const messages = Array.isArray(result.messages) ? result.messages : [];
      mergeHistoryMessages(messages, friend);
      const nextCursor = Number(result.next_cursor || 0) || 0;
      setHistoryState((state) => ({
        ...state,
        [friend.secUid]: {
          loaded: true,
          loading: false,
          nextCursor,
          hasMore: Boolean(nextCursor && messages.length > 0),
          error: "",
        },
      }));
    } catch (caught) {
      setHistoryState((state) => ({
        ...state,
        [friend.secUid]: {
          loaded: cursor === 0 ? true : Boolean(state[friend.secUid]?.loaded),
          loading: false,
          nextCursor: state[friend.secUid]?.nextCursor || 0,
          hasMore: false,
          error: cursor === 0 && currentMessages.length === 0
            ? caught instanceof Error ? caught.message : "获取历史消息失败"
            : "",
        },
      }));
    }
  }, [chatMessages, historyState, mergeHistoryMessages]);

  useEffect(() => {
    if (!selectedFriend || !selectedFriend.uid) return;
    const current = historyState[selectedFriend.secUid];
    if (current?.loaded || current?.loading) return;
    void loadHistoryMessages(selectedFriend, 0);
  }, [historyState, loadHistoryMessages, selectedFriend]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<Record<string, unknown>>("im-status", (payload) => {
      if (disposed || !payload || typeof payload !== "object") return;
      setImStatus({
        connected: Boolean(payload.connected),
        message: stringField(payload, ["message"]) || (payload.connected ? "私信接收已连接" : "私信接收未连接"),
        updatedAt: numberField(payload, ["updated_at", "updatedAt"]) || Date.now(),
      });
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<Record<string, unknown>>("im-message", (payload) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const senderUid = stringField(payload, ["sender_uid", "senderUid"]);
      const rawContent = stringField(payload, ["raw_content", "rawContent"]) || undefined;
      const text = stringField(payload, ["content", "text"]) || fallbackMessageText(rawContent);
      const serverMessageId = stringField(payload, ["server_message_id", "message_id", "id"]);
      if (!senderUid || !text) return;
      const friend = friends.find((item) => item.uid === senderUid);
      if (!friend) return;
      const message: LocalChatMessage = {
        id: serverMessageId || `${friend.secUid}-${Date.now()}`,
        text,
        rawContent,
        createdAt: numberField(payload, ["created_at", "createdAt"]) || Date.now(),
        status: "sent",
        direction: "in",
        senderUid,
      };
      setChatMessages((current) => {
        const currentMessages = current[friend.secUid] || [];
        if (currentMessages.some((item) => item.id === message.id)) return current;
        const next = {
          ...current,
          [friend.secUid]: [...currentMessages, message],
        };
        persistChatMessages(next, currentSecUidRef.current);
        return next;
      });
      if (friend.secUid !== selectedFriendIdRef.current) {
        setUnreadCounts((current) => {
          const next = {
            ...current,
            [friend.secUid]: (current[friend.secUid] || 0) + 1,
          };
          persistUnreadCounts(next, currentSecUidRef.current);
          return next;
        });
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [friends]);

  useEffect(() => {
    if (friends.length === 0) {
      setSelectedFriendId("");
      return;
    }
    if (selectedFriendId && !friends.some((friend) => friend.secUid === selectedFriendId)) {
      setSelectedFriendId("");
    }
  }, [friends, selectedFriendId]);

  useEffect(() => {
    if (selectedFriend) {
      clearUnread(selectedFriend.secUid);
    }
  }, [clearUnread, selectedFriend]);

  useEffect(() => {
    let cancelled = false;
    void getFriendChatState()
      .then((result) => {
        if (cancelled) return;
        chatStateLoadedRef.current = true;
        const summaries = isRecord(result.summaries) ? result.summaries : {};
        const unread = isRecord(result.unreadCounts) ? result.unreadCounts : {};
        const nextSummaries = readChatSummaries(currentSecUidRef.current);
        let messagesMerged = false;

        setChatMessages((currentChatMessages) => {
          const nextChatMessages = { ...currentChatMessages };
          for (const [secUid, value] of Object.entries(summaries)) {
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

            if (latestMessage && latestMessage.text) {
              const currentList = nextChatMessages[secUid] || [];
              if (!currentList.some((existing) =>
                existing.id === latestMessage.id ||
                (existing.text === latestMessage.text && Math.abs(existing.createdAt - latestMessage.createdAt) < 60000)
              )) {
                nextChatMessages[secUid] = [...currentList, latestMessage].sort((a, b) => a.createdAt - b.createdAt);
                messagesMerged = true;
              }
            }

            const latestMessageAt = Math.max(numberField(value, ["latestMessageAt"]), latestMessage?.createdAt || 0);
            const unreadCount = Math.max(0, numberField(value, ["unreadCount"]));
            const current = nextSummaries[secUid];
            if (latestMessageAt >= (current?.latestMessageAt || 0)) {
              nextSummaries[secUid] = {
                latestMessage: latestMessage?.text ? latestMessage : current?.latestMessage,
                latestMessageAt,
                unreadCount: Math.max(unreadCount, current?.unreadCount || 0),
              };
            }
          }
          if (messagesMerged) {
            persistChatMessages(nextChatMessages, currentSecUidRef.current);
          }
          return nextChatMessages;
        });

        for (const [secUid, value] of Object.entries(unread)) {
          const count = Math.max(0, Number(value) || 0);
          if (!count) continue;
          nextSummaries[secUid] = {
            latestMessage: nextSummaries[secUid]?.latestMessage,
            latestMessageAt: nextSummaries[secUid]?.latestMessageAt || 0,
            unreadCount: secUid === selectedFriendIdRef.current ? 0 : Math.max(count, nextSummaries[secUid]?.unreadCount || 0),
          };
        }
        persistChatSummaries(nextSummaries, currentSecUidRef.current);
        setChatSummaries(nextSummaries);
        setUnreadCounts((current) => {
          const next = { ...current };
          for (const [secUid, summary] of Object.entries(nextSummaries)) {
            if (summary.unreadCount > 0 && secUid !== selectedFriendIdRef.current) {
              next[secUid] = Math.max(next[secUid] || 0, summary.unreadCount);
            } else if (secUid === selectedFriendIdRef.current) {
              delete next[secUid];
            }
          }
          persistUnreadCounts(next, currentSecUidRef.current);
          return next;
        });
      })
      .catch(() => {
        chatStateLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [currentSecUid]);

  useEffect(() => {
    setChatSummaries((current) => {
      let changed = false;
      const next: ChatSummaries = { ...current };
      for (const [secUid, messages] of Object.entries(chatMessages)) {
        const latestMessage = latestChatMessage(messages);
        if (!latestMessage) continue;
        const unreadCount = unreadCounts[secUid] || 0;
        const currentSummary = next[secUid];
        if (
          latestMessage.createdAt >= (currentSummary?.latestMessageAt || 0) ||
          unreadCount !== (currentSummary?.unreadCount || 0)
        ) {
          next[secUid] = {
            latestMessage,
            latestMessageAt: Math.max(latestMessage.createdAt, currentSummary?.latestMessageAt || 0),
            unreadCount,
          };
          changed = true;
        }
      }
      for (const [secUid, count] of Object.entries(unreadCounts)) {
        if ((next[secUid]?.unreadCount || 0) === count) continue;
        next[secUid] = {
          latestMessage: next[secUid]?.latestMessage,
          latestMessageAt: next[secUid]?.latestMessageAt || 0,
          unreadCount: count,
        };
        changed = true;
      }
      if (!changed) return current;
      persistChatSummaries(next, currentSecUidRef.current);
      return next;
    });
  }, [chatMessages, unreadCounts]);

  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    setFriendUnreadCount(total);
  }, [setFriendUnreadCount, unreadCounts]);

  useEffect(() => {
    if (!chatStateLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveFriendChatState({
        summaries: chatSummaries,
        unreadCounts,
      }, currentSecUidRef.current).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [chatSummaries, unreadCounts]);

  return {
    chatDrafts,
    chatMessages,
    unreadCounts,
    chatSummaries,
    historyState,
    selectedFriendId,
    setSelectedFriendId,
    selectedFriend,
    selectedMessages,
    selectedHistory,
    imStatus,
    setChatDrafts,
    setChatMessages,
    setUnreadCounts,
    setChatSummaries,
    updateDraft,
    sendLocalMessage,
    sendLocalImageMessage,
    loadHistoryMessages,
    clearUnread,
    selectFriend,
  };
}
