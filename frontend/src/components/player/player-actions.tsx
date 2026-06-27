import {
  Check,
  Download,
  Gauge,
  Heart,
  Info,
  Loader2,
  MessageCircle,
  Music,
  Pause,
  Play,
  Share2,
  Star,
  Volume2,
  VolumeX,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, UIEvent as ReactUIEvent } from "react";
import { cn } from "@/lib/utils";
import { mediaProxyUrl, type CommentInfo, type ShareFriend } from "@/lib/tauri";
import type { VideoQualityOption } from "@/lib/video-media";
import { InlinePlayerButton, PlayerIconButton } from "./player-components";
import type { CommentRepliesState, CommentReplyTarget, PlayerPanel } from "./player-utils";
import { PLAYBACK_RATES } from "./player-utils";
import { CommentsPanel } from "./player-comments";

interface RelationButtonsProps {
  liked: boolean;
  favorited: boolean;
  likeCount: number;
  favoriteCount: number;
  relationSubmitting: "like" | "collect" | null;
  onToggleLike: (event: ReactMouseEvent) => void;
  onToggleCollect: (event: ReactMouseEvent) => void;
}

function RelationButtons({
  liked,
  favorited,
  likeCount,
  favoriteCount,
  relationSubmitting,
  onToggleLike,
  onToggleCollect,
}: RelationButtonsProps) {
  return (
    <>
      <InlinePlayerButton
        label="点赞"
        count={likeCount}
        active={liked}
        activeClassName="fill-accent text-accent"
        disabled={relationSubmitting !== null}
        onClick={onToggleLike}
      >
        {relationSubmitting === "like" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Heart className={cn("h-4 w-4", liked && "fill-accent text-accent")} />
        )}
      </InlinePlayerButton>

      <InlinePlayerButton
        label="收藏"
        count={favoriteCount}
        active={favorited}
        activeClassName="fill-warning text-warning"
        disabled={relationSubmitting !== null}
        onClick={onToggleCollect}
      >
        {relationSubmitting === "collect" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Star className={cn("h-4 w-4", favorited && "fill-warning text-warning")} />
        )}
      </InlinePlayerButton>
    </>
  );
}

interface VolumePanelProps {
  openPanel: PlayerPanel | null;
  muted: boolean;
  volume: number;
  effectiveVolume: number;
  onToggleMute: (event: ReactMouseEvent) => void;
  onVolumeChange: (nextVolume: number) => void;
  onTogglePanel: (panel: PlayerPanel, event: ReactMouseEvent) => void;
  onOpenPanelOnPointerEnter: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onClosePanelOnPointerLeave: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenToolPanel: (panel: PlayerPanel) => void;
  onSchedulePanelClose: (panel?: PlayerPanel) => void;
  onOpenPanelOnPointerDown: (panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function VolumePanel({
  openPanel,
  muted,
  volume,
  effectiveVolume,
  onToggleMute,
  onVolumeChange,
  onTogglePanel,
  onOpenPanelOnPointerEnter,
  onClosePanelOnPointerLeave,
  onOpenToolPanel,
  onSchedulePanelClose,
  onOpenPanelOnPointerDown,
}: VolumePanelProps) {
  return (
    <div
      className="relative shrink-0"
      onPointerEnter={(event) => onOpenPanelOnPointerEnter("volume", event)}
      onPointerLeave={(event) => onClosePanelOnPointerLeave("volume", event)}
      onMouseEnter={() => onOpenToolPanel("volume")}
      onMouseLeave={() => onSchedulePanelClose("volume")}
    >
      <PlayerIconButton
        label="音量"
        onClick={(event) => onTogglePanel("volume", event)}
        onPointerDown={(event) => onOpenPanelOnPointerDown("volume", event)}
        active={openPanel === "volume"}
      >
        {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </PlayerIconButton>
      <AnimatePresence>
        {openPanel === "volume" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="absolute bottom-9 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-[#141414]/95 px-3 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            onPointerEnter={(event) => onOpenPanelOnPointerEnter("volume", event)}
            onPointerLeave={(event) => onClosePanelOnPointerLeave("volume", event)}
            onMouseEnter={() => onOpenToolPanel("volume")}
            onMouseLeave={() => onSchedulePanelClose("volume")}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={onToggleMute}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:text-white/70"
              aria-label={muted ? "取消静音" : "静音"}
            >
              {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={effectiveVolume}
              onChange={(event) => onVolumeChange(Number(event.currentTarget.value))}
              className="h-1 w-[100px] cursor-pointer accent-accent"
              aria-label="音量"
            />
            <span className="min-w-9 text-center text-[0.78rem] font-medium tabular-nums text-white/90">
              {effectiveVolume}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface RatePanelProps {
  openPanel: PlayerPanel | null;
  playbackRate: number;
  onPlaybackRateChange: (rate: number, event: ReactMouseEvent) => void;
  onTogglePanel: (panel: PlayerPanel, event: ReactMouseEvent) => void;
  onOpenPanelOnPointerEnter: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onClosePanelOnPointerLeave: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenToolPanel: (panel: PlayerPanel) => void;
  onSchedulePanelClose: (panel?: PlayerPanel) => void;
  onOpenPanelOnPointerDown: (panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function RatePanel({
  openPanel,
  playbackRate,
  onPlaybackRateChange,
  onTogglePanel,
  onOpenPanelOnPointerEnter,
  onClosePanelOnPointerLeave,
  onOpenToolPanel,
  onSchedulePanelClose,
  onOpenPanelOnPointerDown,
}: RatePanelProps) {
  return (
    <div
      className="relative shrink-0"
      onPointerEnter={(event) => onOpenPanelOnPointerEnter("rate", event)}
      onPointerLeave={(event) => onClosePanelOnPointerLeave("rate", event)}
      onMouseEnter={() => onOpenToolPanel("rate")}
      onMouseLeave={() => onSchedulePanelClose("rate")}
    >
      <PlayerIconButton
        label="倍速"
        onClick={(event) => onTogglePanel("rate", event)}
        onPointerDown={(event) => onOpenPanelOnPointerDown("rate", event)}
        active={openPanel === "rate"}
      >
        <span className="text-[0.78rem] font-semibold tabular-nums">{playbackRate}x</span>
      </PlayerIconButton>
      <AnimatePresence>
        {openPanel === "rate" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="absolute bottom-9 left-1/2 z-40 flex max-w-[200px] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl bg-[#141414]/95 p-2 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            onPointerEnter={(event) => onOpenPanelOnPointerEnter("rate", event)}
            onPointerLeave={(event) => onClosePanelOnPointerLeave("rate", event)}
            onMouseEnter={() => onOpenToolPanel("rate")}
            onMouseLeave={() => onSchedulePanelClose("rate")}
            onClick={(event) => event.stopPropagation()}
          >
            {PLAYBACK_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={(event) => onPlaybackRateChange(rate, event)}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 text-[0.72rem] font-medium text-white/70 transition-colors hover:bg-white/12 hover:text-white",
                  rate === playbackRate && "bg-accent/20 text-accent"
                )}
              >
                {rate}x
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface QualityPanelProps {
  openPanel: PlayerPanel | null;
  qualityOptions: VideoQualityOption[];
  activeQualityOption: VideoQualityOption | null;
  showQualityControl: boolean;
  onQualityChange: (qualityKey: string, event: ReactMouseEvent) => void;
  onTogglePanel: (panel: PlayerPanel, event: ReactMouseEvent) => void;
  onOpenPanelOnPointerEnter: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onClosePanelOnPointerLeave: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenToolPanel: (panel: PlayerPanel) => void;
  onSchedulePanelClose: (panel?: PlayerPanel) => void;
  onOpenPanelOnPointerDown: (panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function QualityPanel({
  openPanel,
  qualityOptions,
  activeQualityOption,
  showQualityControl,
  onQualityChange,
  onTogglePanel,
  onOpenPanelOnPointerEnter,
  onClosePanelOnPointerLeave,
  onOpenToolPanel,
  onSchedulePanelClose,
  onOpenPanelOnPointerDown,
}: QualityPanelProps) {
  if (!showQualityControl) return null;

  return (
    <div
      className="relative shrink-0"
      onPointerEnter={(event) => onOpenPanelOnPointerEnter("quality", event)}
      onPointerLeave={(event) => onClosePanelOnPointerLeave("quality", event)}
      onMouseEnter={() => onOpenToolPanel("quality")}
      onMouseLeave={() => onSchedulePanelClose("quality")}
    >
      <PlayerIconButton
        label={`画质 ${activeQualityOption?.label || "自动"}`}
        onClick={(event) => onTogglePanel("quality", event)}
        onPointerDown={(event) => onOpenPanelOnPointerDown("quality", event)}
        active={openPanel === "quality"}
      >
        <Gauge className="h-4 w-4" />
      </PlayerIconButton>
      <AnimatePresence>
        {openPanel === "quality" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="absolute bottom-9 left-1/2 z-40 flex w-[160px] -translate-x-1/2 flex-col gap-1 rounded-xl bg-[#141414]/95 p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            onPointerEnter={(event) => onOpenPanelOnPointerEnter("quality", event)}
            onPointerLeave={(event) => onClosePanelOnPointerLeave("quality", event)}
            onMouseEnter={() => onOpenToolPanel("quality")}
            onMouseLeave={() => onSchedulePanelClose("quality")}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-1.5 pb-1">
              <span className="text-[0.68rem] font-semibold uppercase tracking-wider text-white/45">
                画质
              </span>
              <span className="text-[0.68rem] font-bold tabular-nums text-accent">
                {activeQualityOption?.label || "自动"}
              </span>
            </div>
            {qualityOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={(event) => onQualityChange(option.key, event)}
                className={cn(
                  "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-white/12",
                  option.key === activeQualityOption?.key && "bg-accent/18 text-accent"
                )}
              >
                <span className="min-w-0 flex-1 text-[0.78rem] font-bold tabular-nums">
                  {option.label}
                </span>
                {option.key === activeQualityOption?.key && (
                  <Check className="h-3.5 w-3.5 shrink-0" />
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface SharePanelProps {
  openPanel: PlayerPanel | null;
  shareFriends: ShareFriend[];
  shareFriendsLoading: boolean;
  shareFriendsError: string;
  shareSendingFriendKey: string;
  shareSentFriendKeys: Set<string>;
  onShareFriendClick: (friend: ShareFriend, event: ReactMouseEvent) => void;
  onTogglePanel: (panel: PlayerPanel, event: ReactMouseEvent) => void;
  onOpenPanelOnPointerEnter: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onClosePanelOnPointerLeave: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenToolPanel: (panel: PlayerPanel) => void;
  onSchedulePanelClose: (panel?: PlayerPanel) => void;
  onOpenPanelOnPointerDown: (panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function SharePanel({
  openPanel,
  shareFriends,
  shareFriendsLoading,
  shareFriendsError,
  shareSendingFriendKey,
  shareSentFriendKeys,
  onShareFriendClick,
  onTogglePanel,
  onOpenPanelOnPointerEnter,
  onClosePanelOnPointerLeave,
  onOpenToolPanel,
  onSchedulePanelClose,
  onOpenPanelOnPointerDown,
}: SharePanelProps) {
  return (
    <div
      className="relative shrink-0"
      onPointerEnter={(event) => onOpenPanelOnPointerEnter("share", event)}
      onPointerLeave={(event) => onClosePanelOnPointerLeave("share", event)}
      onMouseEnter={() => onOpenToolPanel("share")}
      onMouseLeave={() => onSchedulePanelClose("share")}
    >
      <PlayerIconButton
        label="分享"
        onClick={(event) => onTogglePanel("share", event)}
        onPointerDown={(event) => onOpenPanelOnPointerDown("share", event)}
        active={openPanel === "share"}
      >
        <Share2 className="h-4 w-4" />
      </PlayerIconButton>
      <AnimatePresence>
        {openPanel === "share" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="absolute bottom-9 right-0 z-40 w-[268px] overflow-hidden rounded-xl bg-[#141414]/95 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            onPointerEnter={(event) => onOpenPanelOnPointerEnter("share", event)}
            onPointerLeave={(event) => onClosePanelOnPointerLeave("share", event)}
            onMouseEnter={() => onOpenToolPanel("share")}
            onMouseLeave={() => onSchedulePanelClose("share")}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="border-b border-white/[0.08] px-3 py-2">
              <div className="text-[0.74rem] font-semibold text-white/85">分享给好友</div>
              <div className="mt-0.5 text-[0.66rem] text-white/42">点击好友即可发送</div>
            </div>
            <div className="share-friends-scroll max-h-[320px] overflow-y-auto p-1.5">
              {shareFriendsLoading ? (
                <div className="flex h-20 items-center justify-center gap-2 text-[0.72rem] text-white/60">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在获取好友
                </div>
              ) : shareFriendsError ? (
                <div className="rounded-md bg-white/[0.06] px-2 py-2 text-[0.72rem] leading-5 text-white/60">
                  {shareFriendsError}
                </div>
              ) : shareFriends.length === 0 ? (
                <div className="rounded-md bg-white/[0.06] px-2 py-2 text-[0.72rem] text-white/55">
                  暂无可分享好友
                </div>
              ) : (
                shareFriends.slice(0, 20).map((friend) => {
                  const avatar = friend.avatar_thumb || friend.avatar_medium;
                  const subtitle = friend.unique_id || friend.short_id || friend.uid;
                  const friendKey = friend.sec_uid || friend.uid;
                  const sending = shareSendingFriendKey === friendKey;
                  const sent = shareSentFriendKeys.has(friendKey);
                  return (
                    <button
                      key={friendKey}
                      type="button"
                      onClick={(event) => onShareFriendClick(friend, event)}
                      disabled={Boolean(shareSendingFriendKey)}
                      className="flex h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-white/[0.08] disabled:cursor-default disabled:opacity-70"
                    >
                      <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                        {avatar ? (
                          <img
                            src={mediaProxyUrl(avatar, "image")}
                            alt={friend.nickname}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-accent/30 text-[0.72rem] font-bold text-white">
                            {friend.nickname.slice(0, 1)}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[0.78rem] font-semibold text-white/90">
                          {friend.nickname}
                        </div>
                        {subtitle && (
                          <div className="truncate text-[0.66rem] text-white/42">
                            {subtitle}
                          </div>
                        )}
                      </div>
                      {sending ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/60" />
                      ) : sent ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : friend.is_recent_share && (
                        <span className="shrink-0 rounded-full bg-accent/18 px-1.5 py-0.5 text-[0.62rem] font-semibold text-accent">
                          最近
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface DownloadPanelProps {
  openPanel: PlayerPanel | null;
  downloadSubmitting: boolean;
  hasDownloadHandler: boolean;
  onDownloadCurrent: (event: ReactMouseEvent) => void;
  onCopyCurrentMediaUrl: (event: ReactMouseEvent) => void;
  onTogglePanel: (panel: PlayerPanel, event: ReactMouseEvent) => void;
  onOpenPanelOnPointerEnter: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onClosePanelOnPointerLeave: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenToolPanel: (panel: PlayerPanel) => void;
  onSchedulePanelClose: (panel?: PlayerPanel) => void;
}

function DownloadPanel({
  openPanel,
  downloadSubmitting,
  hasDownloadHandler,
  onDownloadCurrent,
  onCopyCurrentMediaUrl,
  onTogglePanel,
  onOpenPanelOnPointerEnter,
  onClosePanelOnPointerLeave,
  onOpenToolPanel,
  onSchedulePanelClose,
}: DownloadPanelProps) {
  return (
    <div
      className="relative shrink-0"
      onPointerEnter={(event) => onOpenPanelOnPointerEnter("download", event)}
      onPointerLeave={(event) => onClosePanelOnPointerLeave("download", event)}
      onMouseEnter={() => onOpenToolPanel("download")}
      onMouseLeave={() => onSchedulePanelClose("download")}
    >
      <PlayerIconButton
        label={downloadSubmitting ? "正在加入下载" : "下载作品"}
        onClick={onDownloadCurrent}
        active={openPanel === "download" || downloadSubmitting}
        disabled={!hasDownloadHandler || downloadSubmitting}
      >
        {downloadSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </PlayerIconButton>
      <AnimatePresence>
        {openPanel === "download" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="absolute bottom-9 right-0 z-40 w-[160px] rounded-xl bg-[#141414]/95 p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            onPointerEnter={(event) => onOpenPanelOnPointerEnter("download", event)}
            onPointerLeave={(event) => onClosePanelOnPointerLeave("download", event)}
            onMouseEnter={() => onOpenToolPanel("download")}
            onMouseLeave={() => onSchedulePanelClose("download")}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="flex flex-col gap-1">
              <button
                type="button"
                disabled={!hasDownloadHandler || downloadSubmitting}
                onClick={onDownloadCurrent}
                className="flex h-8 items-center justify-center gap-1 rounded-md bg-accent/18 text-[0.72rem] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {downloadSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {downloadSubmitting ? "正在加入" : "下载作品"}
              </button>
              <button
                type="button"
                onClick={onCopyCurrentMediaUrl}
                className="flex h-8 items-center justify-center rounded-md bg-white/[0.08] text-[0.72rem] font-semibold text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                复制播放地址
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface MusicPanelProps {
  openPanel: PlayerPanel | null;
  musicUrl: string;
  bgmPlaying: boolean;
  bgmProxyUrl: string;
  onToggleBgm: (event: ReactMouseEvent) => void;
  onTogglePanel: (panel: PlayerPanel, event: ReactMouseEvent) => void;
  onOpenPanelOnPointerEnter: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onClosePanelOnPointerLeave: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenToolPanel: (panel: PlayerPanel) => void;
  onSchedulePanelClose: (panel?: PlayerPanel) => void;
  onOpenPanelOnPointerDown: (panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function MusicPanel({
  openPanel,
  musicUrl,
  bgmPlaying,
  bgmProxyUrl,
  onToggleBgm,
  onTogglePanel,
  onOpenPanelOnPointerEnter,
  onClosePanelOnPointerLeave,
  onOpenToolPanel,
  onSchedulePanelClose,
  onOpenPanelOnPointerDown,
}: MusicPanelProps) {
  return (
    <div
      className="relative shrink-0"
      onPointerEnter={(event) => onOpenPanelOnPointerEnter("music", event)}
      onPointerLeave={(event) => onClosePanelOnPointerLeave("music", event)}
      onMouseEnter={() => onOpenToolPanel("music")}
      onMouseLeave={() => onSchedulePanelClose("music")}
    >
      <PlayerIconButton
        label="背景音乐"
        onClick={(event) => onTogglePanel("music", event)}
        onPointerDown={(event) => onOpenPanelOnPointerDown("music", event)}
        active={openPanel === "music"}
      >
        <Music className="h-4 w-4" />
      </PlayerIconButton>
      <AnimatePresence>
        {openPanel === "music" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16 }}
            className="absolute bottom-9 right-0 z-40 w-[160px] rounded-xl bg-[#141414]/95 p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
            onPointerEnter={(event) => onOpenPanelOnPointerEnter("music", event)}
            onPointerLeave={(event) => onClosePanelOnPointerLeave("music", event)}
            onMouseEnter={() => onOpenToolPanel("music")}
            onMouseLeave={() => onSchedulePanelClose("music")}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            {musicUrl ? (
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={onToggleBgm}
                  className="flex h-8 items-center justify-center gap-1 rounded-md bg-accent/18 text-[0.72rem] font-semibold text-accent transition-colors hover:bg-accent/25"
                >
                  {bgmPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                  {bgmPlaying ? "暂停 BGM" : "播放 BGM"}
                </button>
                <a
                  href={bgmProxyUrl}
                  download
                  className="flex h-8 items-center justify-center gap-1 rounded-md bg-white/[0.08] text-[0.72rem] font-semibold text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Download className="h-3.5 w-3.5" />
                  下载
                </a>
              </div>
            ) : (
              <div className="rounded-md bg-white/[0.06] px-2 py-2 text-[0.72rem] text-white/55">
                当前作品没有返回音频地址
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface PlayerActionButtonsProps {
  liked: boolean;
  favorited: boolean;
  likeCount: number;
  favoriteCount: number;
  relationSubmitting: "like" | "collect" | null;
  openPanel: PlayerPanel | null;
  muted: boolean;
  volume: number;
  effectiveVolume: number;
  playbackRate: number;
  qualityOptions: VideoQualityOption[];
  activeQualityOption: VideoQualityOption | null;
  showQualityControl: boolean;
  shareFriends: ShareFriend[];
  shareFriendsLoading: boolean;
  shareFriendsError: string;
  shareSendingFriendKey: string;
  shareSentFriendKeys: Set<string>;
  downloadSubmitting: boolean;
  musicUrl: string;
  bgmPlaying: boolean;
  bgmProxyUrl: string;
  hasDownloadHandler: boolean;
  // Comment props
  commentsOpen: boolean;
  comments: CommentInfo[];
  commentsLoading: boolean;
  commentsError: string;
  commentsHasMore: boolean;
  commentsTotal: number;
  commentReplies: CommentRepliesState;
  expandedCommentReplyIds: Set<string>;
  commentDiggingIds: Set<string>;
  commentDraft: string;
  commentSubmitting: boolean;
  commentReplyTarget: CommentReplyTarget;
  currentVideoCommentCount: number;
  // Callbacks
  onToggleLike: (event: ReactMouseEvent) => void;
  onToggleCollect: (event: ReactMouseEvent) => void;
  onToggleMute: (event: ReactMouseEvent) => void;
  onVolumeChange: (nextVolume: number) => void;
  onPlaybackRateChange: (rate: number, event: ReactMouseEvent) => void;
  onQualityChange: (qualityKey: string, event: ReactMouseEvent) => void;
  onShareFriendClick: (friend: ShareFriend, event: ReactMouseEvent) => void;
  onDownloadCurrent: (event: ReactMouseEvent) => void;
  onCopyCurrentMediaUrl: (event: ReactMouseEvent) => void;
  onToggleBgm: (event: ReactMouseEvent) => void;
  onShowDetail: () => void;
  onTogglePanel: (panel: PlayerPanel, event: ReactMouseEvent) => void;
  onOpenPanelOnPointerEnter: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onClosePanelOnPointerLeave: (panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenToolPanel: (panel: PlayerPanel) => void;
  onSchedulePanelClose: (panel?: PlayerPanel) => void;
  onOpenPanelOnPointerDown: (panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => void;
  // Comment callbacks
  onCommentsScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onToggleCommentReplies: (comment: CommentInfo) => void;
  onToggleCommentLike: (comment: CommentInfo, level: number) => void;
  onSetCommentReplyTarget: (target: CommentReplyTarget) => void;
  onCommentDraftChange: (draft: string) => void;
  onSubmitComment: () => void;
  onLoadCommentReplies: (comment: CommentInfo, mode: "initial" | "more") => void;
  onLoadMoreComments: () => void;
  onCloseCommentsPanel: (event?: ReactMouseEvent) => void;
  onOpenCommentsPanel: (event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>, options?: { sticky?: boolean }) => void;
  onMarkCommentsPanelSticky: (event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>) => void;
  onScheduleTransientCommentsClose: (event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>) => void;
  onClearPanelCloseTimer: () => void;
}

export function PlayerActionButtons({
  liked,
  favorited,
  likeCount,
  favoriteCount,
  relationSubmitting,
  openPanel,
  muted,
  volume,
  effectiveVolume,
  playbackRate,
  qualityOptions,
  activeQualityOption,
  showQualityControl,
  shareFriends,
  shareFriendsLoading,
  shareFriendsError,
  shareSendingFriendKey,
  shareSentFriendKeys,
  downloadSubmitting,
  musicUrl,
  bgmPlaying,
  bgmProxyUrl,
  hasDownloadHandler,
  commentsOpen,
  comments,
  commentsLoading,
  commentsError,
  commentsHasMore,
  commentsTotal,
  commentReplies,
  expandedCommentReplyIds,
  commentDiggingIds,
  commentDraft,
  commentSubmitting,
  commentReplyTarget,
  currentVideoCommentCount,
  onToggleLike,
  onToggleCollect,
  onToggleMute,
  onVolumeChange,
  onPlaybackRateChange,
  onQualityChange,
  onShareFriendClick,
  onDownloadCurrent,
  onCopyCurrentMediaUrl,
  onToggleBgm,
  onShowDetail,
  onTogglePanel,
  onOpenPanelOnPointerEnter,
  onClosePanelOnPointerLeave,
  onOpenToolPanel,
  onSchedulePanelClose,
  onOpenPanelOnPointerDown,
  onCommentsScroll,
  onToggleCommentReplies,
  onToggleCommentLike,
  onSetCommentReplyTarget,
  onCommentDraftChange,
  onSubmitComment,
  onLoadCommentReplies,
  onLoadMoreComments,
  onCloseCommentsPanel,
  onOpenCommentsPanel,
  onMarkCommentsPanelSticky,
  onScheduleTransientCommentsClose,
  onClearPanelCloseTimer,
}: PlayerActionButtonsProps) {
  return (
    <div className="flex min-w-0 max-w-[66vw] items-center gap-1 overflow-visible pb-0.5">
      <RelationButtons
        liked={liked}
        favorited={favorited}
        likeCount={likeCount}
        favoriteCount={favoriteCount}
        relationSubmitting={relationSubmitting}
        onToggleLike={onToggleLike}
        onToggleCollect={onToggleCollect}
      />

      <VolumePanel
        openPanel={openPanel}
        muted={muted}
        volume={volume}
        effectiveVolume={effectiveVolume}
        onToggleMute={onToggleMute}
        onVolumeChange={onVolumeChange}
        onTogglePanel={onTogglePanel}
        onOpenPanelOnPointerEnter={onOpenPanelOnPointerEnter}
        onClosePanelOnPointerLeave={onClosePanelOnPointerLeave}
        onOpenToolPanel={onOpenToolPanel}
        onSchedulePanelClose={onSchedulePanelClose}
        onOpenPanelOnPointerDown={onOpenPanelOnPointerDown}
      />

      <RatePanel
        openPanel={openPanel}
        playbackRate={playbackRate}
        onPlaybackRateChange={onPlaybackRateChange}
        onTogglePanel={onTogglePanel}
        onOpenPanelOnPointerEnter={onOpenPanelOnPointerEnter}
        onClosePanelOnPointerLeave={onClosePanelOnPointerLeave}
        onOpenToolPanel={onOpenToolPanel}
        onSchedulePanelClose={onSchedulePanelClose}
        onOpenPanelOnPointerDown={onOpenPanelOnPointerDown}
      />

      <QualityPanel
        openPanel={openPanel}
        qualityOptions={qualityOptions}
        activeQualityOption={activeQualityOption}
        showQualityControl={showQualityControl}
        onQualityChange={onQualityChange}
        onTogglePanel={onTogglePanel}
        onOpenPanelOnPointerEnter={onOpenPanelOnPointerEnter}
        onClosePanelOnPointerLeave={onClosePanelOnPointerLeave}
        onOpenToolPanel={onOpenToolPanel}
        onSchedulePanelClose={onSchedulePanelClose}
        onOpenPanelOnPointerDown={onOpenPanelOnPointerDown}
      />

      <div
        className="relative shrink-0"
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") onOpenCommentsPanel(event);
        }}
        onMouseEnter={() => onOpenCommentsPanel()}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") onScheduleTransientCommentsClose(event);
        }}
        onMouseLeave={() => onScheduleTransientCommentsClose()}
      >
        <PlayerIconButton
          label="评论区"
          onClick={(event) => {
            event.stopPropagation();
            onClearPanelCloseTimer();
            if (commentsOpen) {
              onCloseCommentsPanel(event);
            } else {
              onOpenCommentsPanel(event, { sticky: true });
            }
          }}
          active={commentsOpen}
        >
          <MessageCircle className="h-4 w-4" />
        </PlayerIconButton>
        <AnimatePresence>
          {commentsOpen && (
            <CommentsPanel
              comments={comments}
              commentsLoading={commentsLoading}
              commentsError={commentsError}
              commentsHasMore={commentsHasMore}
              commentsTotal={commentsTotal}
              commentReplies={commentReplies}
              expandedCommentReplyIds={expandedCommentReplyIds}
              commentDiggingIds={commentDiggingIds}
              commentDraft={commentDraft}
              commentSubmitting={commentSubmitting}
              commentReplyTarget={commentReplyTarget}
              currentVideoCommentCount={currentVideoCommentCount}
              currentCommentCount={comments.length}
              onCommentsScroll={onCommentsScroll}
              onToggleCommentReplies={onToggleCommentReplies}
              onToggleCommentLike={onToggleCommentLike}
              onSetCommentReplyTarget={onSetCommentReplyTarget}
              onCommentDraftChange={onCommentDraftChange}
              onSubmitComment={onSubmitComment}
              onLoadCommentReplies={onLoadCommentReplies}
              onLoadMoreComments={onLoadMoreComments}
              onClose={onCloseCommentsPanel}
              onMarkSticky={onMarkCommentsPanelSticky}
            />
          )}
        </AnimatePresence>
      </div>

      <SharePanel
        openPanel={openPanel}
        shareFriends={shareFriends}
        shareFriendsLoading={shareFriendsLoading}
        shareFriendsError={shareFriendsError}
        shareSendingFriendKey={shareSendingFriendKey}
        shareSentFriendKeys={shareSentFriendKeys}
        onShareFriendClick={onShareFriendClick}
        onTogglePanel={onTogglePanel}
        onOpenPanelOnPointerEnter={onOpenPanelOnPointerEnter}
        onClosePanelOnPointerLeave={onClosePanelOnPointerLeave}
        onOpenToolPanel={onOpenToolPanel}
        onSchedulePanelClose={onSchedulePanelClose}
        onOpenPanelOnPointerDown={onOpenPanelOnPointerDown}
      />

      <DownloadPanel
        openPanel={openPanel}
        downloadSubmitting={downloadSubmitting}
        hasDownloadHandler={hasDownloadHandler}
        onDownloadCurrent={onDownloadCurrent}
        onCopyCurrentMediaUrl={onCopyCurrentMediaUrl}
        onTogglePanel={onTogglePanel}
        onOpenPanelOnPointerEnter={onOpenPanelOnPointerEnter}
        onClosePanelOnPointerLeave={onClosePanelOnPointerLeave}
        onOpenToolPanel={onOpenToolPanel}
        onSchedulePanelClose={onSchedulePanelClose}
      />

      <MusicPanel
        openPanel={openPanel}
        musicUrl={musicUrl}
        bgmPlaying={bgmPlaying}
        bgmProxyUrl={bgmProxyUrl}
        onToggleBgm={onToggleBgm}
        onTogglePanel={onTogglePanel}
        onOpenPanelOnPointerEnter={onOpenPanelOnPointerEnter}
        onClosePanelOnPointerLeave={onClosePanelOnPointerLeave}
        onOpenToolPanel={onOpenToolPanel}
        onSchedulePanelClose={onSchedulePanelClose}
        onOpenPanelOnPointerDown={onOpenPanelOnPointerDown}
      />

      {onShowDetail && (
        <PlayerIconButton
          label="查看详情"
          onClick={(event) => {
            event.stopPropagation();
            onShowDetail();
          }}
        >
          <Info className="h-4 w-4" />
        </PlayerIconButton>
      )}
    </div>
  );
}
