import { useEffect, useState, useRef } from "react";
import { listenEvent } from "@/lib/tauri";
import {
  type ChatMessages,
  type ChatSummaries,
  type FriendStatusItem,
  type ImConnectionStatus,
  type LocalChatMessage,
  type UnreadCounts,
} from "./friends-status-types";
import {
  fallbackMessageText,
  numberField,
  persistChatMessages,
  persistChatSummaries,
  persistUnreadCounts,
  stringField,
} from "./friends-status-utils";

interface ImEventsProps {
  friends: FriendStatusItem[];
  currentSecUid: string;
  selectedFriendIdRef: React.RefObject<string>;
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessages>>;
  setChatSummaries: React.Dispatch<React.SetStateAction<ChatSummaries>>;
  setUnreadCounts: React.Dispatch<React.SetStateAction<UnreadCounts>>;
}

export function useFriendsImEvents({
  friends,
  currentSecUid,
  selectedFriendIdRef,
  setChatMessages,
  setChatSummaries,
  setUnreadCounts,
}: ImEventsProps) {
  const [imStatus, setImStatus] = useState<ImConnectionStatus>({
    connected: false,
    message: "接收通道未连接",
    updatedAt: 0,
  });

  const currentSecUidRef = useRef(currentSecUid);
  useEffect(() => {
    currentSecUidRef.current = currentSecUid;
  }, [currentSecUid]);

  // Listen to im-status events
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

  // Listen to im-message events
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
      const isSelectedFriend = friend.secUid === selectedFriendIdRef.current;
      setChatSummaries((current) => {
        const currentSummary = current[friend.secUid];
        const nextUnreadCount = isSelectedFriend
          ? 0
          : (currentSummary?.unreadCount || 0) + 1;
        const next = {
          ...current,
          [friend.secUid]: {
            latestMessage: message,
            latestMessageAt: Math.max(message.createdAt, currentSummary?.latestMessageAt || 0),
            unreadCount: nextUnreadCount,
          },
        };
        persistChatSummaries(next, currentSecUidRef.current);
        return next;
      });
      if (!isSelectedFriend) {
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
  }, [friends, setChatMessages, setChatSummaries, setUnreadCounts, selectedFriendIdRef]);

  return {
    imStatus,
  };
}
