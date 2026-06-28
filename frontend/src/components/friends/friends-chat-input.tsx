import { type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { ImagePlus, Loader2, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  FriendStatusItem,
  PendingImageAttachment,
} from "./friends-status-types";

interface FriendsChatInputProps {
  friend: FriendStatusItem | null;
  draft: string;
  onDraftChange: (secUid: string, value: string) => void;
  onSendMessage: () => void;
  onPickImage: () => void;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  onImageInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  pendingImages: PendingImageAttachment[];
  onRemovePendingImage: (id: string) => void;
  onDraftKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  textSending: boolean;
  displayName: string;
}

export function FriendsChatInput({
  friend,
  draft,
  onDraftChange,
  onSendMessage,
  onPickImage,
  imageInputRef,
  onImageInputChange,
  pendingImages,
  onRemovePendingImage,
  onDraftKeyDown,
  onDraftPaste,
  canSend,
  textSending,
  displayName,
}: FriendsChatInputProps) {
  return (
    <div className="border-t border-border bg-surface/40 p-3">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={onImageInputChange}
        />
        {pendingImages.length > 0 && (
          <div className="col-span-3 mb-1 flex max-h-28 gap-2 overflow-x-auto rounded-[14px] border border-border bg-surface-solid p-2">
            {pendingImages.map((image) => (
              <div
                key={image.id}
                className="relative h-20 w-20 shrink-0 overflow-hidden rounded-[12px] border border-border bg-surface-raised"
              >
                <img src={image.previewUrl} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => onRemovePendingImage(image.id)}
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:bg-black/70"
                  aria-label="移除图片"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={!friend}
          onClick={onPickImage}
          className="h-10 w-10 px-0"
          title="发送图片"
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </Button>
        <Textarea
          value={draft}
          onChange={(event) => friend && onDraftChange(friend.secUid, event.target.value)}
          onKeyDown={onDraftKeyDown}
          onPaste={onDraftPaste}
          disabled={!friend}
          placeholder={friend ? `给 ${displayName} 写点内容...` : "选择好友后输入"}
          className="h-10 min-h-10 resize-none bg-surface-solid py-2 leading-5"
        />
        <Button disabled={!canSend || textSending} onClick={onSendMessage} className="h-10 px-4">
          {textSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          发送
        </Button>
      </div>
    </div>
  );
}
