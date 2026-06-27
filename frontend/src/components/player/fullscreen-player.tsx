import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { prewarmVideoForPlayback } from "@/lib/media-prewarm";
import {
  copyTextToClipboard,
  getCommentReplies,
  getComments,
  getShareFriends,
  getVideoDetail,
  mediaProxyUrl,
  publishComment,
  sendFriendVideoShare,
  setVideoCollected,
  setCommentLiked,
  setVideoLiked,
  type CommentInfo,
  type ShareFriend,
  type VideoInfo,
} from "@/lib/tauri";
import {
  collectVideoMedia,
  collectVideoQualityOptions,
  getMediaProxyType,
  getVideoBgmUrl,
  isVideoLikeMedia,
  shouldUseSeparateBgmForVideo,
  type VideoMediaItem,
} from "@/lib/video-media";
import { PlayerDescription } from "./player-description";
import { PlayerPlaybackBar } from "./player-playback-bar";
import { AuthorInfo } from "./player-info";
import { PlayerActionButtons } from "./player-actions";
import { TopCloseOverlay } from "./player-overlays";
import { PlayerMediaStage } from "./player-media-stage";
import {
  IMAGE_DURATION_SECONDS,
  LOAD_MORE_THRESHOLD,
  MAX_PRELOADED_MEDIA_NODES,
  PLAYER_MEDIA_ADVANCE_PRELOAD_TIMEOUT_MS,
  PLAYER_NEXT_VIDEO_PRELOAD_AHEAD_SECONDS,
  PLAYER_PANEL_CLOSE_DELAY_MS,
  PLAYER_VIDEO_INITIAL_STATUS_DELAY_MS,
  PLAYER_VIDEO_LOAD_TIMEOUT_MS,
  PLAYER_VIDEO_MAX_AUTO_RETRIES,
  PLAYER_VIDEO_REBUFFER_STATUS_DELAY_MS,
  SESSION_CACHE_BUSTER,
  WHEEL_IDLE_RESET_MS,
  WHEEL_VIDEO_SWITCH_LOCK_MS,
  WHEEL_VIDEO_SWITCH_THRESHOLD,
  applyPlaybackRateToNode,
  finiteMediaTime,
  getDocumentVideoNode,
  isKeyboardInputTarget,
  mediaMotionVariants,
  normalizeWheelDelta,
  playerMediaProxyUrl,
  readMediaDuration,
  releaseMediaElement,
  releaseScopedMediaElements,
  resolveMediaDirection,
  type CommentRepliesState,
  type CommentReplyTarget,
  type PlayerPanel,
} from "./player-utils";

interface FullscreenPlayerProps {
  videos: VideoInfo[];
  initialIndex?: number;
  initialMediaIndex?: number;
  open: boolean;
  onClose: () => void;
  onDownload?: (video: VideoInfo) => void | Promise<void>;
  onLoadMore?: () => void;
  onShowDetail?: (video: VideoInfo) => void;
  onAuthor?: (video: VideoInfo) => void;
  onVideoUpdate?: (video: VideoInfo) => void;
}

export function FullscreenPlayer({
  videos,
  initialIndex = 0,
  initialMediaIndex = 0,
  open,
  onClose,
  onDownload,
  onLoadMore,
  onShowDetail,
  onAuthor,
  onVideoUpdate,
}: FullscreenPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [mediaIndex, setMediaIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [liked, setLiked] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [relationHydrating, setRelationHydrating] = useState(false);
  const [relationSubmitting, setRelationSubmitting] = useState<"like" | "collect" | null>(null);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedQualityKey, setSelectedQualityKey] = useState("auto");
  const [openPanel, setOpenPanel] = useState<PlayerPanel | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [showLoadStatus, setShowLoadStatus] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [bgmPlaying, setBgmPlaying] = useState(false);
  const [downloadSubmitting, setDownloadSubmitting] = useState(false);
  const [shareFriends, setShareFriends] = useState<ShareFriend[]>([]);
  const [shareFriendsLoading, setShareFriendsLoading] = useState(false);
  const [shareFriendsError, setShareFriendsError] = useState("");
  const [shareFriendsLoaded, setShareFriendsLoaded] = useState(false);
  const [shareSendingFriendKey, setShareSendingFriendKey] = useState("");
  const [shareSentFriendKeys, setShareSentFriendKeys] = useState<Set<string>>(() => new Set());
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<CommentInfo[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState("");
  const [commentsCursor, setCommentsCursor] = useState(0);
  const [commentsHasMore, setCommentsHasMore] = useState(false);
  const [commentsTotal, setCommentsTotal] = useState(0);
  const [commentsLoadedAwemeId, setCommentsLoadedAwemeId] = useState("");
  const [commentReplies, setCommentReplies] = useState<CommentRepliesState>({});
  const [expandedCommentReplyIds, setExpandedCommentReplyIds] = useState<Set<string>>(() => new Set());
  const [commentDiggingIds, setCommentDiggingIds] = useState<Set<string>>(() => new Set());
  const [commentDraft, setCommentDraft] = useState("");
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentReplyTarget, setCommentReplyTarget] = useState<CommentReplyTarget>(null);
  const [videoOverrides, setVideoOverrides] = useState<Record<string, VideoInfo>>({});
  const [mediaTransitionDirection, setMediaTransitionDirection] = useState(0);
  const [navigationNotice, setNavigationNotice] = useState("");
  const playerRootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceHitRef = useRef<HTMLDivElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const bgmSourceKeyRef = useRef("");
  const bgmDesiredPlayingRef = useRef(false);
  const bgmPlayPendingRef = useRef(false);
  const bgmPlayRequestSeqRef = useRef(0);
  const touchStart = useRef({ x: 0, y: 0 });
  const wheelLocked = useRef(false);
  const wheelAccumulatedDeltaRef = useRef(0);
  const loadMoreRequestedForLength = useRef(0);
  const imageAdvanceQueued = useRef(false);
  const desiredPlayingRef = useRef(true);
  const playingRef = useRef(false);
  const playbackRateRef = useRef(1);
  const mediaSwitchingRef = useRef(false);
  const mediaAdvanceSeqRef = useRef(0);
  const qualitySwitchingRef = useRef(false);
  const bgmManuallyPausedRef = useRef(false);
  const mediaSwitchReleaseRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const qualitySwitchReleaseRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const panelCloseTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const commentsHoverCloseTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const commentsPanelStickyRef = useRef(false);
  const wheelResetTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const loadStatusTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const loadTimeoutTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const bufferingTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const navigationNoticeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const autoRetryCountRef = useRef(0);
  const refreshingDetailRef = useRef(false);
  const relationRefreshSeqRef = useRef(0);
  const relationRefreshedIdsRef = useRef(new Set<string>());
  const refreshedDetailIdsRef = useRef(new Set<string>());
  const videoProgressRafRef = useRef<number | null>(null);
  const progressSampleRef = useRef(0);
  const surfaceTapStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastSurfaceToggleAtRef = useRef(0);
  const pendingQualitySeekRef = useRef<number | null>(null);
  const preloadedMediaRef = useRef(new Map<string, boolean>());
  const preloadedReadyRef = useRef(new Set<string>());
  const preloadedNodesRef = useRef<Array<HTMLImageElement | HTMLVideoElement>>([]);
  const wasOpenRef = useRef(open);

  const safeInitialIndexForOpen = Math.min(Math.max(initialIndex, 0), Math.max(videos.length - 1, 0));
  const isOpeningRender = open && !wasOpenRef.current;
  const activeCurrentIndex = isOpeningRender ? safeInitialIndexForOpen : currentIndex;
  const rawCurrentVideo = videos[activeCurrentIndex] || null;
  const currentVideo = rawCurrentVideo?.aweme_id
    ? videoOverrides[rawCurrentVideo.aweme_id] || rawCurrentVideo
    : rawCurrentVideo;
  const mediaItems = useMemo(
    () => (currentVideo ? collectVideoMedia(currentVideo) : []),
    [currentVideo]
  );
  const safeInitialMediaIndexForOpen = Math.min(
    Math.max(initialMediaIndex, 0),
    Math.max(mediaItems.length - 1, 0)
  );
  const activeMediaIndex = isOpeningRender ? safeInitialMediaIndexForOpen : mediaIndex;
  const currentMedia = mediaItems[activeMediaIndex] || mediaItems[0] || null;
  const qualityOptions = useMemo(
    () => currentMedia?.type === "video" ? collectVideoQualityOptions(currentVideo, currentMedia.url) : [],
    [currentMedia?.type, currentMedia?.url, currentVideo]
  );
  const selectedQualityOption = qualityOptions.find((option) => option.key === selectedQualityKey);
  const activeQualityOption =
    selectedQualityKey === "auto" || selectedQualityOption?.isAuto
      ? null
      : selectedQualityOption || null;
  const currentPlaybackUrl =
    currentMedia && currentMedia.type === "video" && activeQualityOption
      ? activeQualityOption.url
      : currentMedia?.url || "";
  const currentMediaSrc = currentMedia
    ? playerMediaProxyUrl(currentPlaybackUrl, getMediaProxyType(currentMedia), reloadKey)
    : "";
  const mediaKey = currentMedia
    ? `${currentVideo?.aweme_id || "video"}-${activeMediaIndex}-${currentMedia.type}-${currentMedia.url}-${reloadKey}`
    : "empty";
  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const hasMultipleMedia = mediaItems.length > 1;
  const initialVideoKey = videos[initialIndex]?.aweme_id || "";
  const authorAvatar =
    currentVideo?.author?.avatar_thumb || currentVideo?.author?.avatar_medium || "";
  const authorName =
    currentVideo?.author?.nickname || currentVideo?.author?.unique_id || "用户";
  const canOpenAuthor = Boolean(onAuthor && currentVideo?.author?.sec_uid);
  const likeBaseCount = currentVideo?.statistics?.digg_count || 0;
  const favoriteBaseCount = currentVideo?.statistics?.collect_count || 0;
  const likeCount = Math.max(
    0,
    likeBaseCount + (liked && !currentVideo?.is_liked ? 1 : !liked && currentVideo?.is_liked ? -1 : 0)
  );
  const favoriteCount =
    Math.max(
      0,
      favoriteBaseCount +
        (favorited && !currentVideo?.is_collected ? 1 : !favorited && currentVideo?.is_collected ? -1 : 0)
    );
  const workMusicUrl = getVideoBgmUrl(currentVideo);
  const mediaMusicUrl = getVideoBgmUrl(currentVideo, currentMedia);
  const musicUrl = hasMultipleMedia ? workMusicUrl || mediaMusicUrl : mediaMusicUrl;
  const bgmProxyUrl = musicUrl ? mediaProxyUrl(musicUrl, "audio") : "";
  const effectiveVolume = muted ? 0 : volume;
  const shouldUseBgmForCurrentMedia = Boolean(
    currentMedia &&
      musicUrl &&
      (shouldUseSeparateBgmForVideo(currentMedia, currentVideo) || hasMultipleMedia)
  );
  const shouldAutoPlayCurrentMedia = open && (desiredPlayingRef.current || isOpeningRender);
  const showQualityControl = currentMedia?.type === "video";
  const hasQualityChoices = currentMedia?.type === "video" && qualityOptions.length > 1;

  useEffect(() => {
    setLiked(Boolean(currentVideo?.is_liked));
    setFavorited(Boolean(currentVideo?.is_collected));
    setRelationSubmitting(null);
  }, [currentVideo?.aweme_id, currentVideo?.is_liked, currentVideo?.is_collected]);

  const stopVideoProgressLoop = useCallback(() => {
    if (videoProgressRafRef.current === null) return;
    window.cancelAnimationFrame(videoProgressRafRef.current);
    videoProgressRafRef.current = null;
  }, []);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const clearLoadTimers = useCallback(() => {
    if (loadStatusTimerRef.current) {
      window.clearTimeout(loadStatusTimerRef.current);
      loadStatusTimerRef.current = null;
    }
    if (loadTimeoutTimerRef.current) {
      window.clearTimeout(loadTimeoutTimerRef.current);
      loadTimeoutTimerRef.current = null;
    }
    if (bufferingTimerRef.current) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
  }, []);

  const syncVideoProgress = useCallback((node: HTMLVideoElement) => {
    const nextTime = finiteMediaTime(node.currentTime);
    const nextDuration = readMediaDuration(node);
    setCurrentTime((current) => {
      if (nextTime > 0 || current <= 0) return nextTime;
      if (node.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || nextDuration <= 0) {
        return current;
      }
      return nextTime;
    });
    if (nextDuration > 0) {
      setDuration(nextDuration);
    }
  }, []);

  const startVideoProgressLoop = useCallback(() => {
    if (videoProgressRafRef.current !== null) return;

    const tick = () => {
      const node = videoRef.current;
      if (!node) {
        videoProgressRafRef.current = null;
        return;
      }

      const now = performance.now();
      if (now - progressSampleRef.current >= 50 || node.paused || node.ended) {
        progressSampleRef.current = now;
        syncVideoProgress(node);
      }

      if (!node.paused && !node.ended) {
        videoProgressRafRef.current = window.requestAnimationFrame(tick);
      } else {
        videoProgressRafRef.current = null;
      }
    };

    videoProgressRafRef.current = window.requestAnimationFrame(tick);
  }, [syncVideoProgress]);

  const setVideoElementRef = useCallback((node: HTMLVideoElement | null) => {
    if (!node) return;
    videoRef.current = node;
  }, []);

  const goToVideo = useCallback((index: number) => {
    if (index < 0 || index >= videos.length) return;
    mediaAdvanceSeqRef.current += 1;
    desiredPlayingRef.current = true;
    mediaSwitchingRef.current = false;
    clearLoadTimers();
    stopVideoProgressLoop();
    releaseMediaElement(videoRef.current);
    setMediaTransitionDirection(0);
    setCurrentIndex(index);
    setMediaIndex(0);
    setCurrentTime(0);
    setDuration(0);
    progressSampleRef.current = 0;
    setPlaying(false);
    setReloadKey((value) => value + 1);
  }, [clearLoadTimers, stopVideoProgressLoop, videos.length]);

  const showNavigationNotice = useCallback((message: string) => {
    setNavigationNotice(message);
    if (navigationNoticeTimerRef.current) {
      window.clearTimeout(navigationNoticeTimerRef.current);
    }
    navigationNoticeTimerRef.current = window.setTimeout(() => {
      setNavigationNotice("");
      navigationNoticeTimerRef.current = null;
    }, 1400);
  }, []);

  const patchCurrentVideoRelation = useCallback((awemeId: string, patch: Partial<VideoInfo>) => {
    setVideoOverrides((current) => {
      const base = current[awemeId] || videos.find((video) => video.aweme_id === awemeId);
      if (!base) return current;
      const nextVideo = {
        ...base,
        ...patch,
        statistics: patch.statistics
          ? {
              ...base.statistics,
              ...patch.statistics,
            }
          : base.statistics,
      };
      onVideoUpdate?.(nextVideo);
      return {
        ...current,
        [awemeId]: nextVideo,
      };
    });
  }, [onVideoUpdate, videos]);

  const refreshCurrentRelationState = useCallback(async (awemeId: string) => {
    if (!awemeId) return;
    const requestSeq = relationRefreshSeqRef.current + 1;
    relationRefreshSeqRef.current = requestSeq;
    setRelationHydrating(true);

    try {
      const result = await getVideoDetail(awemeId);
      if (relationRefreshSeqRef.current !== requestSeq || !result.success || !result.video) {
        return;
      }

      const detail = result.video;
      const nextLiked = Boolean(detail.is_liked);
      const nextCollected = Boolean(detail.is_collected);
      setLiked(nextLiked);
      setFavorited(nextCollected);
      patchCurrentVideoRelation(awemeId, {
        is_liked: nextLiked,
        is_collected: nextCollected,
        statistics: detail.statistics,
      });
    } catch {
      // Keep the list-provided relation state if the detail refresh is blocked.
    } finally {
      if (relationRefreshSeqRef.current === requestSeq) {
        setRelationHydrating(false);
      }
    }
  }, [patchCurrentVideoRelation]);

  useEffect(() => {
    if (!open || loadState !== "ready" || !currentVideo?.aweme_id) return;
    if (relationRefreshedIdsRef.current.has(currentVideo.aweme_id)) return;
    relationRefreshedIdsRef.current.add(currentVideo.aweme_id);
    const timer = window.setTimeout(() => {
      void refreshCurrentRelationState(currentVideo.aweme_id);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [currentVideo?.aweme_id, loadState, open, refreshCurrentRelationState]);

  const toggleLike = useCallback(async () => {
    const awemeId = currentVideo?.aweme_id;
    if (!awemeId || relationSubmitting) return;

    const previousLiked = liked;
    const nextLiked = !previousLiked;
    const nextCount = Math.max(0, likeBaseCount + (nextLiked ? 1 : -1));
    relationRefreshSeqRef.current += 1;
    setRelationSubmitting("like");
    setLiked(nextLiked);
    patchCurrentVideoRelation(awemeId, {
      is_liked: nextLiked,
      statistics: { ...currentVideo.statistics, digg_count: nextCount },
    });

    try {
      const result = await setVideoLiked(awemeId, nextLiked);
      if (!result.success) throw new Error(result.message || "点赞失败");
      const actualLiked = result.is_liked ?? nextLiked;
      const actualCount = Math.max(0, likeBaseCount + (actualLiked && !previousLiked ? 1 : !actualLiked && previousLiked ? -1 : 0));
      setLiked(actualLiked);
      patchCurrentVideoRelation(awemeId, {
        is_liked: actualLiked,
        statistics: { ...currentVideo.statistics, digg_count: actualCount },
      });
      if (actualLiked !== nextLiked) {
        throw new Error(result.message || "点赞状态未生效");
      }
      showNavigationNotice(actualLiked ? "已点赞" : "已取消点赞");
    } catch (error) {
      setLiked(previousLiked);
      patchCurrentVideoRelation(awemeId, {
        is_liked: previousLiked,
        statistics: currentVideo.statistics,
      });
      showNavigationNotice(error instanceof Error ? error.message : "点赞失败");
    } finally {
      setRelationSubmitting(null);
    }
  }, [currentVideo, likeBaseCount, liked, patchCurrentVideoRelation, relationSubmitting, showNavigationNotice]);

  const toggleCollect = useCallback(async () => {
    const awemeId = currentVideo?.aweme_id;
    if (!awemeId || relationSubmitting) return;

    const previousCollected = favorited;
    const nextCollected = !previousCollected;
    const nextCount = Math.max(0, favoriteBaseCount + (nextCollected ? 1 : -1));
    relationRefreshSeqRef.current += 1;
    setRelationSubmitting("collect");
    setFavorited(nextCollected);
    patchCurrentVideoRelation(awemeId, {
      is_collected: nextCollected,
      statistics: { ...currentVideo.statistics, collect_count: nextCount },
    });

    try {
      const result = await setVideoCollected(awemeId, nextCollected);
      if (!result.success) throw new Error(result.message || "收藏失败");
      showNavigationNotice(nextCollected ? "已收藏" : "已取消收藏");
    } catch (error) {
      setFavorited(previousCollected);
      patchCurrentVideoRelation(awemeId, {
        is_collected: previousCollected,
        statistics: currentVideo.statistics,
      });
      showNavigationNotice(error instanceof Error ? error.message : "收藏失败");
    } finally {
      setRelationSubmitting(null);
    }
  }, [currentVideo, favoriteBaseCount, favorited, patchCurrentVideoRelation, relationSubmitting, showNavigationNotice]);

  const playNextVideo = useCallback(() => {
    if (currentIndex < videos.length - 1) {
      goToVideo(currentIndex + 1);
      return;
    }
    if (onLoadMore) {
      showNavigationNotice("正在加载更多视频...");
      onLoadMore();
      return;
    }
    showNavigationNotice("已经是最后一个视频");
  }, [currentIndex, goToVideo, onLoadMore, showNavigationNotice, videos.length]);

  const playPrevVideo = useCallback(() => {
    if (currentIndex > 0) {
      goToVideo(currentIndex - 1);
      return;
    }
    showNavigationNotice("已经是第一个视频");
  }, [currentIndex, goToVideo, showNavigationNotice]);

  const rememberPreloadedNode = useCallback((node: HTMLImageElement | HTMLVideoElement) => {
    preloadedNodesRef.current.push(node);
    while (preloadedNodesRef.current.length > MAX_PRELOADED_MEDIA_NODES) {
      const removed = preloadedNodesRef.current.shift();
      if (removed instanceof HTMLVideoElement) {
        releaseMediaElement(removed);
      } else if (removed) {
        removed.removeAttribute("src");
      }
    }
  }, []);

  const resolvePreloadTarget = useCallback((media: VideoMediaItem | null | undefined) => {
    if (!media) return null;
    const mediaType = getMediaProxyType(media);
    const proxiedUrl = playerMediaProxyUrl(media.url, mediaType, reloadKey);
    if (!proxiedUrl) return null;
    return {
      key: `${media.type}::${proxiedUrl}`,
      url: proxiedUrl,
    };
  }, [reloadKey]);

  const waitForMediaReady = useCallback((media: VideoMediaItem | null | undefined) => {
    const target = resolvePreloadTarget(media);
    if (!target || !media) return Promise.resolve();
    if (preloadedReadyRef.current.has(target.key)) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof window.setTimeout>;

      if (media.type === "image") {
        const image = new Image();
        image.decoding = "async";
        image.loading = "eager";

        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          if (image.naturalWidth > 0) {
            preloadedReadyRef.current.add(target.key);
          }
          rememberPreloadedNode(image);
          resolve();
        };

        image.onload = () => {
          if (typeof image.decode === "function") {
            void image.decode().catch(() => undefined).finally(finish);
            return;
          }
          finish();
        };
        image.onerror = finish;
        timer = window.setTimeout(finish, PLAYER_MEDIA_ADVANCE_PRELOAD_TIMEOUT_MS);
        image.src = target.url;
        if (image.complete && image.naturalWidth > 0) finish();
        return;
      }

      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;

      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        video.removeEventListener("loadeddata", finish);
        video.removeEventListener("canplay", finish);
        video.removeEventListener("error", finish);
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          preloadedReadyRef.current.add(target.key);
        }
        rememberPreloadedNode(video);
        resolve();
      };

      video.addEventListener("loadeddata", finish);
      video.addEventListener("canplay", finish);
      video.addEventListener("error", finish);
      timer = window.setTimeout(finish, PLAYER_MEDIA_ADVANCE_PRELOAD_TIMEOUT_MS);
      video.src = target.url;
      video.load();
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish();
    });
  }, [rememberPreloadedNode, resolvePreloadTarget]);

  const releaseMediaSwitchSoon = useCallback(() => {
    if (mediaSwitchReleaseRef.current) {
      window.clearTimeout(mediaSwitchReleaseRef.current);
    }
    mediaSwitchReleaseRef.current = window.setTimeout(() => {
      mediaSwitchingRef.current = false;
      mediaSwitchReleaseRef.current = null;
    }, 650);
  }, []);

  const switchToMedia = useCallback((index: number) => {
    if (mediaItems.length === 0) return;
    mediaAdvanceSeqRef.current += 1;
    const safeIndex = ((index % mediaItems.length) + mediaItems.length) % mediaItems.length;
    const direction = resolveMediaDirection(mediaIndex, safeIndex, mediaItems.length);
    const shouldKeepPlaying = desiredPlayingRef.current || playing;
    desiredPlayingRef.current = shouldKeepPlaying;
    mediaSwitchingRef.current = true;
    if (mediaSwitchReleaseRef.current) {
      window.clearTimeout(mediaSwitchReleaseRef.current);
    }
    setMediaIndex(safeIndex);
    setMediaTransitionDirection(direction);
    setCurrentTime(0);
    setDuration(0);
    progressSampleRef.current = 0;
    setPlaying(shouldKeepPlaying);
  }, [mediaItems.length, playing]);

  const playNextMedia = useCallback(() => {
    if (mediaItems.length > 1) {
      switchToMedia(mediaIndex + 1);
      return;
    }
    playNextVideo();
  }, [mediaIndex, mediaItems.length, playNextVideo, switchToMedia]);

  const playPrevMedia = useCallback(() => {
    if (mediaItems.length > 1) {
      switchToMedia(mediaIndex - 1);
      return;
    }
    playPrevVideo();
  }, [mediaIndex, mediaItems.length, playPrevVideo, switchToMedia]);

  const advanceMediaSequence = useCallback(() => {
    if (mediaItems.length === 0) return;
    desiredPlayingRef.current = true;
    if (mediaItems.length > 1) {
      const nextIndex = (mediaIndex + 1) % mediaItems.length;
      const nextMedia = mediaItems[nextIndex];
      const nextTarget = resolvePreloadTarget(nextMedia);
      if (nextTarget && preloadedReadyRef.current.has(nextTarget.key)) {
        switchToMedia(nextIndex);
        return;
      }
      const requestSeq = ++mediaAdvanceSeqRef.current;
      mediaSwitchingRef.current = true;
      setPlaying(true);
      void waitForMediaReady(nextMedia).then(() => {
        if (requestSeq !== mediaAdvanceSeqRef.current) return;
        switchToMedia(nextIndex);
      });
      return;
    }
    imageAdvanceQueued.current = false;
    setCurrentTime(0);
    setDuration(IMAGE_DURATION_SECONDS);
    setPlaying(true);
    setReloadKey((value) => value + 1);
  }, [mediaIndex, mediaItems, resolvePreloadTarget, switchToMedia, waitForMediaReady]);

  const requestAdvanceMediaSequence = useCallback(() => {
    window.requestAnimationFrame(() => {
      advanceMediaSequence();
    });
  }, [advanceMediaSequence]);

  const togglePlay = useCallback(() => {
    if (!currentMedia) return;
    if (!isVideoLikeMedia(currentMedia)) {
      setPlaying((value) => {
        const nextPlaying = !value;
        if (!nextPlaying) {
          mediaAdvanceSeqRef.current += 1;
        }
        desiredPlayingRef.current = nextPlaying;
        return nextPlaying;
      });
      return;
    }

    const node = videoRef.current || getDocumentVideoNode(surfaceHitRef.current);
    if (!node) return;
    if (node.paused) {
      desiredPlayingRef.current = true;
      void node.play().then(() => {
        setPlaying(true);
        startVideoProgressLoop();
      }).catch(() => setPlaying(false));
    } else {
      mediaAdvanceSeqRef.current += 1;
      desiredPlayingRef.current = false;
      node.pause();
      setPlaying(false);
    }
  }, [currentMedia, startVideoProgressLoop]);

  const togglePlayFromSurface = useCallback((action?: "play" | "pause") => {
    const now = Date.now();
    if (now - lastSurfaceToggleAtRef.current < 420) return;
    lastSurfaceToggleAtRef.current = now;

    const node = videoRef.current || getDocumentVideoNode(playerRootRef.current);
    if (node) {
      const surfaceLabel = surfaceHitRef.current?.getAttribute("aria-label");
      const shouldPause = action ? action === "pause" : surfaceLabel === "暂停" || playingRef.current;
      if (!shouldPause) {
        desiredPlayingRef.current = true;
        void node.play().then(() => {
          playingRef.current = true;
          setPlaying(true);
          startVideoProgressLoop();
        }).catch(() => setPlaying(false));
      } else {
        desiredPlayingRef.current = false;
        playingRef.current = false;
        setPlaying(false);
        try {
          node.pause();
        } catch {
          // Some embedded webviews expose media methods late; keep UI state consistent.
        }
      }
      return;
    }

    togglePlay();
  }, [startVideoProgressLoop, togglePlay]);

  const rememberSurfaceTap = useCallback((x: number, y: number) => {
    surfaceTapStartRef.current = { x, y, at: Date.now() };
  }, []);

  const finishSurfaceTap = useCallback((x: number, y: number) => {
    const start = surfaceTapStartRef.current;
    surfaceTapStartRef.current = null;
    if (!start) return;
    if (Date.now() - start.at > 700) return;
    if (Math.abs(x - start.x) > 14 || Math.abs(y - start.y) > 14) return;
    togglePlayFromSurface();
  }, [togglePlayFromSurface]);

  const handleSurfacePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    rememberSurfaceTap(event.clientX, event.clientY);
  }, [rememberSurfaceTap]);

  const handleSurfacePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    finishSurfaceTap(event.clientX, event.clientY);
  }, [finishSurfaceTap]);

  const handleSurfacePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    surfaceTapStartRef.current = null;
  }, []);

  const handleSurfaceMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    rememberSurfaceTap(event.clientX, event.clientY);
  }, [rememberSurfaceTap]);

  const handleSurfaceMouseUp = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    finishSurfaceTap(event.clientX, event.clientY);
  }, [finishSurfaceTap]);

  const handleSurfaceTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    rememberSurfaceTap(touch.clientX, touch.clientY);
  }, [rememberSurfaceTap]);

  const handleSurfaceTouchEnd = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    finishSurfaceTap(touch.clientX, touch.clientY);
  }, [finishSurfaceTap]);

  const handleSurfaceClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
    togglePlayFromSurface(event.currentTarget.getAttribute("aria-label") === "暂停" ? "pause" : "play");
  }, [togglePlayFromSurface]);



  useEffect(() => {
    if (!open) return;
    const node = surfaceHitRef.current;
    if (!node) return;

    const handleNativePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      rememberSurfaceTap(event.clientX, event.clientY);
    };
    const handleNativePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      surfaceTapStartRef.current = null;
    };
    const handleNativePointerCancel = (event: PointerEvent) => {
      event.stopPropagation();
      surfaceTapStartRef.current = null;
    };
    const handleNativeMouseDown = (event: MouseEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      rememberSurfaceTap(event.clientX, event.clientY);
    };
    const handleNativeMouseUp = (event: MouseEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      finishSurfaceTap(event.clientX, event.clientY);
    };
    const handleNativeTouchStart = (event: TouchEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.stopPropagation();
      rememberSurfaceTap(touch.clientX, touch.clientY);
    };
    const handleNativeTouchEnd = (event: TouchEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.stopPropagation();
      finishSurfaceTap(touch.clientX, touch.clientY);
    };
    const handleNativeClick = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      togglePlayFromSurface(node.getAttribute("aria-label") === "暂停" ? "pause" : "play");
    };

    node.addEventListener("pointerdown", handleNativePointerDown);
    node.addEventListener("pointerup", handleNativePointerUp);
    node.addEventListener("pointercancel", handleNativePointerCancel);
    node.addEventListener("mousedown", handleNativeMouseDown);
    node.addEventListener("mouseup", handleNativeMouseUp);
    node.addEventListener("touchstart", handleNativeTouchStart, { passive: false });
    node.addEventListener("touchend", handleNativeTouchEnd, { passive: false });
    node.addEventListener("touchcancel", handleNativeTouchEnd, { passive: false });
    node.addEventListener("click", handleNativeClick);

    return () => {
      node.removeEventListener("pointerdown", handleNativePointerDown);
      node.removeEventListener("pointerup", handleNativePointerUp);
      node.removeEventListener("pointercancel", handleNativePointerCancel);
      node.removeEventListener("mousedown", handleNativeMouseDown);
      node.removeEventListener("mouseup", handleNativeMouseUp);
      node.removeEventListener("touchstart", handleNativeTouchStart);
      node.removeEventListener("touchend", handleNativeTouchEnd);
      node.removeEventListener("touchcancel", handleNativeTouchEnd);
      node.removeEventListener("click", handleNativeClick);
    };
  }, [finishSurfaceTap, open, rememberSurfaceTap, togglePlayFromSurface]);

  const clearPanelCloseTimer = useCallback(() => {
    if (!panelCloseTimerRef.current) return;
    window.clearTimeout(panelCloseTimerRef.current);
    panelCloseTimerRef.current = null;
  }, []);

  const openToolPanel = useCallback((panel: PlayerPanel) => {
    clearPanelCloseTimer();
    setOpenPanel(panel);
  }, [clearPanelCloseTimer]);

  const schedulePanelClose = useCallback((panel?: PlayerPanel) => {
    clearPanelCloseTimer();
    panelCloseTimerRef.current = window.setTimeout(() => {
      setOpenPanel((value) => (!panel || value === panel ? null : value));
      panelCloseTimerRef.current = null;
    }, PLAYER_PANEL_CLOSE_DELAY_MS);
  }, [clearPanelCloseTimer]);

  const openPanelOnPointerEnter = useCallback((panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    openToolPanel(panel);
  }, [openToolPanel]);

  const closePanelOnPointerLeave = useCallback((panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    schedulePanelClose(panel);
  }, [schedulePanelClose]);

  const togglePanel = useCallback((panel: PlayerPanel, event: ReactMouseEvent) => {
    event.stopPropagation();
    clearPanelCloseTimer();
    setOpenPanel(panel);
  }, [clearPanelCloseTimer]);

  const openPanelOnPointerDown = useCallback((panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    clearPanelCloseTimer();
    setOpenPanel(panel);
  }, [clearPanelCloseTimer]);

  const copyCurrentMediaUrl = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    const url = currentPlaybackUrl || currentMedia?.url || "";
    if (!url) return;
    void copyTextToClipboard(url).then((success) => {
      if (success) setOpenPanel(null);
    });
  }, [currentMedia?.url, currentPlaybackUrl]);

  const handleDownloadCurrent = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    clearPanelCloseTimer();
    setOpenPanel(null);

    if (!currentVideo || !onDownload || downloadSubmitting) return;

    setDownloadSubmitting(true);
    Promise.resolve(onDownload(currentVideo)).finally(() => {
      window.setTimeout(() => setDownloadSubmitting(false), 350);
    });
  }, [clearPanelCloseTimer, currentVideo, downloadSubmitting, onDownload]);

  const loadShareFriends = useCallback(async () => {
    if (shareFriendsLoading || shareFriendsLoaded) return;
    setShareFriendsLoading(true);
    setShareFriendsError("");
    try {
      const result = await getShareFriends(50);
      if (!result.success) {
        throw new Error(result.message || "获取好友列表失败");
      }
      setShareFriends(Array.isArray(result.friends) ? result.friends : []);
      setShareFriendsLoaded(true);
    } catch (error) {
      setShareFriendsError(error instanceof Error ? error.message : "获取好友列表失败");
    } finally {
      setShareFriendsLoading(false);
    }
  }, [shareFriendsLoaded, shareFriendsLoading]);

  const handleShareFriendClick = useCallback(async (friend: ShareFriend, event: ReactMouseEvent) => {
    event.stopPropagation();
    if (!currentVideo || shareSendingFriendKey) return;
    const toUserId = String(friend.uid || "").trim();
    if (!toUserId) {
      showNavigationNotice("这个好友缺少 uid，暂时无法分享");
      return;
    }
    const friendKey = friend.sec_uid || friend.uid;
    setShareSendingFriendKey(friendKey);
    try {
      const result = await sendFriendVideoShare({ toUserId, video: currentVideo });
      if (!result.success) {
        throw new Error(result.message || "分享失败");
      }
      setShareSentFriendKeys((prev) => {
        const next = new Set(prev);
        next.add(friendKey);
        return next;
      });
      showNavigationNotice(friend.nickname ? `已分享给 ${friend.nickname}` : "已分享给好友");
    } catch (error) {
      showNavigationNotice(error instanceof Error ? error.message : "分享失败");
    } finally {
      setShareSendingFriendKey("");
    }
  }, [currentVideo, shareSendingFriendKey, showNavigationNotice]);

  const loadComments = useCallback(async (mode: "initial" | "more" = "initial") => {
    if (!currentVideo?.aweme_id || commentsLoading) return;
    const isMore = mode === "more";
    setCommentsLoading(true);
    setCommentsError("");
    try {
      const result = await getComments(currentVideo.aweme_id, 20, isMore ? commentsCursor : 0);
      if (!result.success) {
        throw new Error(result.message || "获取评论失败");
      }
      const nextComments = Array.isArray(result.comments) ? result.comments : [];
      setComments((prev) => (isMore ? [...prev, ...nextComments] : nextComments));
      setCommentsCursor(Number(result.cursor || 0));
      setCommentsHasMore(Boolean(result.has_more));
      setCommentsTotal(Number(result.total || 0));
      setCommentsLoadedAwemeId(currentVideo.aweme_id);
    } catch (error) {
      setCommentsError(error instanceof Error ? error.message : "获取评论失败");
      if (!isMore) {
        setComments([]);
        setCommentsHasMore(false);
      }
    } finally {
      setCommentsLoading(false);
    }
  }, [commentsCursor, commentsLoading, currentVideo?.aweme_id]);

  const loadCommentReplies = useCallback(async (comment: CommentInfo, mode: "initial" | "more" = "initial") => {
    if (!currentVideo?.aweme_id || !comment.cid) return;
    const currentState = commentReplies[comment.cid];
    if (currentState?.loading) return;
    const isMore = mode === "more";
    const cursor = isMore ? currentState?.cursor || 0 : 0;

    setCommentReplies((prev) => ({
      ...prev,
      [comment.cid]: {
        items: isMore ? prev[comment.cid]?.items || [] : prev[comment.cid]?.items || [],
        cursor,
        hasMore: isMore ? prev[comment.cid]?.hasMore ?? false : prev[comment.cid]?.hasMore ?? false,
        loading: true,
        error: "",
        total: prev[comment.cid]?.total || comment.reply_comment_total || 0,
        loaded: prev[comment.cid]?.loaded || false,
      },
    }));

    try {
      const result = await getCommentReplies(currentVideo.aweme_id, comment.cid, 6, cursor);
      if (!result.success) {
        throw new Error(result.message || "获取回复失败");
      }
      const nextReplies = Array.isArray(result.comments) ? result.comments : [];
      setCommentReplies((prev) => {
        const previous = prev[comment.cid];
        return {
          ...prev,
          [comment.cid]: {
            items: isMore ? [...(previous?.items || []), ...nextReplies] : nextReplies,
            cursor: Number(result.cursor || 0),
            hasMore: Boolean(result.has_more),
            loading: false,
            error: "",
            total: Number(result.total || comment.reply_comment_total || nextReplies.length || 0),
            loaded: true,
          },
        };
      });
    } catch (error) {
      setCommentReplies((prev) => ({
        ...prev,
        [comment.cid]: {
          items: prev[comment.cid]?.items || [],
          cursor: prev[comment.cid]?.cursor || 0,
          hasMore: prev[comment.cid]?.hasMore || false,
          loading: false,
          error: error instanceof Error ? error.message : "获取回复失败",
          total: prev[comment.cid]?.total || comment.reply_comment_total || 0,
          loaded: true,
        },
      }));
    }
  }, [commentReplies, currentVideo?.aweme_id]);

  const toggleCommentReplies = useCallback((comment: CommentInfo) => {
    const willExpand = !expandedCommentReplyIds.has(comment.cid);
    setExpandedCommentReplyIds((prev) => {
      const next = new Set(prev);
      if (willExpand) {
        next.add(comment.cid);
      } else {
        next.delete(comment.cid);
      }
      return next;
    });
    const replyState = commentReplies[comment.cid];
    if (willExpand && !replyState?.loaded && !replyState?.loading) {
      void loadCommentReplies(comment, "initial");
    }
  }, [commentReplies, expandedCommentReplyIds, loadCommentReplies]);

  const updateCommentById = useCallback((commentId: string, updater: (comment: CommentInfo) => CommentInfo) => {
    setComments((prev) => prev.map((comment) => (comment.cid === commentId ? updater(comment) : comment)));
    setCommentReplies((prev) => {
      const next: CommentRepliesState = {};
      let anyChanged = false;
      for (const [cid, state] of Object.entries(prev)) {
        let itemsChanged = false;
        const nextItems = state.items.map((reply) => {
          if (reply.cid !== commentId) return reply;
          itemsChanged = true;
          return updater(reply);
        });
        if (itemsChanged) {
          anyChanged = true;
          next[cid] = { ...state, items: nextItems };
        } else {
          next[cid] = state;
        }
      }
      return anyChanged ? next : prev;
    });
  }, []);

  const toggleCommentLike = useCallback(async (comment: CommentInfo, level: number) => {
    if (!currentVideo?.aweme_id || !comment.cid || commentDiggingIds.has(comment.cid)) return;
    const wasLiked = Number(comment.user_digged || 0) > 0;
    const nextLiked = !wasLiked;
    const delta = nextLiked ? 1 : -1;

    setCommentDiggingIds((prev) => new Set(prev).add(comment.cid));
    updateCommentById(comment.cid, (item) => ({
      ...item,
      user_digged: nextLiked ? 1 : 0,
      digg_count: Math.max(0, Number(item.digg_count || 0) + delta),
    }));

    try {
      const result = await setCommentLiked(currentVideo.aweme_id, comment.cid, nextLiked, level);
      if (!result.success) {
        throw new Error(result.message || "评论点赞失败");
      }
    } catch (error) {
      updateCommentById(comment.cid, (item) => ({
        ...item,
        user_digged: wasLiked ? 1 : 0,
        digg_count: Math.max(0, Number(item.digg_count || 0) - delta),
      }));
      showNavigationNotice(error instanceof Error ? error.message : "评论点赞失败");
    } finally {
      setCommentDiggingIds((prev) => {
        const next = new Set(prev);
        next.delete(comment.cid);
        return next;
      });
    }
  }, [commentDiggingIds, currentVideo?.aweme_id, showNavigationNotice, updateCommentById]);

  const submitComment = useCallback(async () => {
    const text = commentDraft.trim();
    if (!currentVideo?.aweme_id || !text || commentSubmitting) return;
    const target = commentReplyTarget;
    setCommentSubmitting(true);
    try {
      const result = await publishComment(
        currentVideo.aweme_id,
        text,
        target?.replyId || "",
        target?.replyToReplyId || ""
      );
      if (!result.success) {
        throw new Error(result.message || "发表评论失败");
      }
      const created = result.comment;
      if (created?.cid) {
        if (target?.replyId) {
          setExpandedCommentReplyIds((prev) => new Set(prev).add(target.replyId));
          setCommentReplies((prev) => {
            const current = prev[target.replyId] || {
              items: [],
              cursor: 0,
              hasMore: false,
              loading: false,
              error: "",
              total: 0,
              loaded: true,
            };
            return {
              ...prev,
              [target.replyId]: {
                ...current,
                items: [created, ...current.items],
                total: current.total + 1,
                loaded: true,
              },
            };
          });
          updateCommentById(target.replyId, (item) => ({
            ...item,
            reply_comment_total: Number(item.reply_comment_total || 0) + 1,
          }));
        } else {
          setComments((prev) => [created, ...prev]);
          setCommentsTotal((prev) => prev + 1);
        }
      } else if (target?.replyId) {
        void loadCommentReplies({ cid: target.replyId } as CommentInfo, "initial");
      } else {
        void loadComments("initial");
      }
      setCommentDraft("");
      setCommentReplyTarget(null);
      showNavigationNotice("评论已发布");
    } catch (error) {
      showNavigationNotice(error instanceof Error ? error.message : "发表评论失败");
    } finally {
      setCommentSubmitting(false);
    }
  }, [
    commentDraft,
    commentReplyTarget,
    commentSubmitting,
    currentVideo?.aweme_id,
    loadCommentReplies,
    loadComments,
    showNavigationNotice,
    updateCommentById,
  ]);

  const handleCommentsScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceToBottom > 96 || commentsLoading || !commentsHasMore) return;
    void loadComments("more");
  }, [commentsHasMore, commentsLoading, loadComments]);

  const clearCommentsHoverCloseTimer = useCallback(() => {
    if (commentsHoverCloseTimerRef.current) {
      window.clearTimeout(commentsHoverCloseTimerRef.current);
      commentsHoverCloseTimerRef.current = null;
    }
  }, []);

  const openCommentsPanel = useCallback((event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>, options?: { sticky?: boolean }) => {
    event?.stopPropagation();
    clearPanelCloseTimer();
    clearCommentsHoverCloseTimer();
    if (options?.sticky) {
      commentsPanelStickyRef.current = true;
    } else if (!commentsOpen) {
      commentsPanelStickyRef.current = false;
    }
    setOpenPanel(null);
    setCommentsOpen(true);
  }, [clearCommentsHoverCloseTimer, clearPanelCloseTimer, commentsOpen]);

  const markCommentsPanelSticky = useCallback((event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>) => {
    event?.stopPropagation();
    clearCommentsHoverCloseTimer();
    commentsPanelStickyRef.current = true;
  }, [clearCommentsHoverCloseTimer]);

  const scheduleTransientCommentsClose = useCallback((event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>) => {
    event?.stopPropagation();
    clearCommentsHoverCloseTimer();
    commentsHoverCloseTimerRef.current = window.setTimeout(() => {
      if (!commentsPanelStickyRef.current) {
        setCommentsOpen(false);
      }
      commentsHoverCloseTimerRef.current = null;
    }, 180);
  }, [clearCommentsHoverCloseTimer]);

  const closeCommentsPanel = useCallback((event?: ReactMouseEvent) => {
    event?.stopPropagation();
    clearCommentsHoverCloseTimer();
    commentsPanelStickyRef.current = false;
    setCommentsOpen(false);
  }, [clearCommentsHoverCloseTimer]);

  const toggleMute = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    if (muted && volume === 0) {
      setVolume(50);
    }
    setMuted((value) => !value);
  }, [muted, volume]);

  const handleVolumeChange = useCallback((nextVolume: number) => {
    const safeVolume = Math.max(0, Math.min(100, nextVolume));
    setVolume(safeVolume);
    setMuted(safeVolume === 0);
  }, []);

  const syncPlaybackRate = useCallback((rate: number) => {
    playbackRateRef.current = rate;
    applyPlaybackRateToNode(videoRef.current || getDocumentVideoNode(playerRootRef.current), rate);
    applyPlaybackRateToNode(bgmRef.current, rate);
  }, []);

  const handlePlaybackRateChange = useCallback((rate: number, event: ReactMouseEvent) => {
    event.stopPropagation();
    setPlaybackRate(rate);
    syncPlaybackRate(rate);
    window.requestAnimationFrame(() => syncPlaybackRate(rate));
    window.setTimeout(() => syncPlaybackRate(rate), 120);
    setOpenPanel(null);
  }, [syncPlaybackRate]);

  const handleQualityChange = useCallback((qualityKey: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    if (qualityKey === selectedQualityKey) {
      setOpenPanel(null);
      return;
    }

    const nextQualityOption = qualityOptions.find((option) => option.key === qualityKey);
    const nextPlaybackUrl =
      currentMedia && currentMedia.type === "video" && nextQualityOption
        ? nextQualityOption.url
        : currentMedia?.url || "";
    const nextMediaSrc = currentMedia
      ? playerMediaProxyUrl(nextPlaybackUrl, getMediaProxyType(currentMedia), reloadKey)
      : "";
    const node = videoRef.current || getDocumentVideoNode(playerRootRef.current);
    const nextTime = node ? finiteMediaTime(node.currentTime) : currentTime;
    const shouldResume = playingRef.current || desiredPlayingRef.current;
    pendingQualitySeekRef.current = nextTime > 0 ? nextTime : null;
    desiredPlayingRef.current = shouldResume;
    mediaSwitchingRef.current = true;
    qualitySwitchingRef.current = true;
    if (qualitySwitchReleaseRef.current) {
      window.clearTimeout(qualitySwitchReleaseRef.current);
    }
    qualitySwitchReleaseRef.current = window.setTimeout(() => {
      qualitySwitchingRef.current = false;
      qualitySwitchReleaseRef.current = null;
    }, 8000);
    setSelectedQualityKey(qualityKey);
    setPlaying(shouldResume);
    setLoadState("loading");
    setShowLoadStatus(true);
    setDuration(0);
    setOpenPanel(null);

    if (node && nextMediaSrc) {
      node.src = nextMediaSrc;
      node.volume = effectiveVolume / 100;
      const targetMuted = shouldUseBgmForCurrentMedia || muted || volume === 0;
      node.muted = shouldResume && !targetMuted ? true : targetMuted;
      applyPlaybackRateToNode(node, playbackRateRef.current);
      node.load();
      if (shouldResume) {
        void node.play().then(() => {
          node.muted = targetMuted;
          playingRef.current = true;
          setPlaying(true);
          startVideoProgressLoop();
        }).catch(() => {
          node.muted = targetMuted;
          setPlaying(false);
        });
      }
    }
  }, [
    currentMedia,
    currentTime,
    effectiveVolume,
    muted,
    playbackRate,
    qualityOptions,
    reloadKey,
    selectedQualityKey,
    shouldUseBgmForCurrentMedia,
    startVideoProgressLoop,
    volume,
  ]);

  const restorePendingQualitySeek = useCallback((node: HTMLVideoElement) => {
    const pendingTime = pendingQualitySeekRef.current;
    if (!pendingTime || pendingTime <= 0) return;

    const nodeDuration = readMediaDuration(node);
    const safeTime = nodeDuration > 0 ? Math.min(pendingTime, Math.max(0, nodeDuration - 0.15)) : pendingTime;
    try {
      node.currentTime = safeTime;
      setCurrentTime(safeTime);
      pendingQualitySeekRef.current = null;
    } catch {
      // Some streams reject early seeking until canplay; the next metadata event will keep playback usable.
    }
  }, []);

  const resumeVideoIfDesired = useCallback((node: HTMLVideoElement) => {
    if (!desiredPlayingRef.current || !currentMedia || !isVideoLikeMedia(currentMedia)) return;
    const targetMuted = shouldUseBgmForCurrentMedia || muted || volume === 0;
    const shouldTemporarilyMute = qualitySwitchingRef.current && !targetMuted;
    if (!node.paused) {
      node.muted = targetMuted;
      setPlaying(true);
      startVideoProgressLoop();
      return;
    }

    if (shouldTemporarilyMute) {
      node.muted = true;
    }
    void node.play().then(() => {
      node.muted = targetMuted;
      playingRef.current = true;
      setPlaying(true);
      startVideoProgressLoop();
    }).catch(() => {
      node.muted = targetMuted;
      setPlaying(false);
    });
  }, [currentMedia, muted, shouldUseBgmForCurrentMedia, startVideoProgressLoop, volume]);

  const ensureBgmSource = useCallback(() => {
    const audio = bgmRef.current;
    if (!audio || !bgmProxyUrl) return null;
    if (bgmSourceKeyRef.current !== bgmProxyUrl) {
      bgmPlayRequestSeqRef.current += 1;
      bgmPlayPendingRef.current = false;
      bgmSourceKeyRef.current = bgmProxyUrl;
      audio.src = bgmProxyUrl;
      audio.loop = true;
      audio.preload = "auto";
      audio.load();
    }
    audio.volume = effectiveVolume / 100;
    audio.muted = muted || volume === 0;
    applyPlaybackRateToNode(audio, playbackRateRef.current);
    return audio;
  }, [bgmProxyUrl, effectiveVolume, muted, volume]);

  const playBgm = useCallback(() => {
    if (bgmManuallyPausedRef.current) {
      bgmDesiredPlayingRef.current = false;
      return;
    }
    bgmDesiredPlayingRef.current = true;
    const audio = ensureBgmSource();
    if (!audio) return;
    if (!audio.paused && !audio.ended) {
      bgmPlayPendingRef.current = false;
      setBgmPlaying(true);
      return;
    }
    if (bgmPlayPendingRef.current) return;

    const requestSeq = ++bgmPlayRequestSeqRef.current;
    bgmPlayPendingRef.current = true;
    void audio.play().then(() => {
      if (requestSeq !== bgmPlayRequestSeqRef.current) return;
      bgmPlayPendingRef.current = false;
      if (!bgmDesiredPlayingRef.current || bgmManuallyPausedRef.current) {
        audio.pause();
        setBgmPlaying(false);
        return;
      }
      setBgmPlaying(true);
    }).catch(() => {
      if (requestSeq !== bgmPlayRequestSeqRef.current) return;
      bgmPlayPendingRef.current = false;
      setBgmPlaying(false);
    });
  }, [ensureBgmSource]);

  const pauseBgm = useCallback(() => {
    bgmDesiredPlayingRef.current = false;
    bgmPlayRequestSeqRef.current += 1;
    bgmPlayPendingRef.current = false;
    const audio = bgmRef.current;
    if (!audio) return;
    audio.pause();
    setBgmPlaying(false);
  }, []);

  const releaseBgm = useCallback(() => {
    bgmDesiredPlayingRef.current = false;
    bgmPlayRequestSeqRef.current += 1;
    bgmPlayPendingRef.current = false;
    const audio = bgmRef.current;
    bgmSourceKeyRef.current = "";
    releaseMediaElement(audio);
    setBgmPlaying(false);
  }, []);

  const toggleBgm = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    const audio = ensureBgmSource();
    if (!audio) return;
    if (audio.paused) {
      bgmManuallyPausedRef.current = false;
      playBgm();
    } else {
      bgmManuallyPausedRef.current = true;
      pauseBgm();
    }
  }, [ensureBgmSource, pauseBgm, playBgm]);

  const handleSeek = useCallback((nextTime: number) => {
    if (!duration) return;
    const safeTime = Math.max(0, Math.min(duration, nextTime));
    setCurrentTime(safeTime);
    progressSampleRef.current = performance.now();

    const node = videoRef.current || getDocumentVideoNode(playerRootRef.current);
    if (currentMedia && isVideoLikeMedia(currentMedia) && node) {
      try {
        if (typeof node.fastSeek === "function") {
          node.fastSeek(safeTime);
        } else {
          node.currentTime = safeTime;
        }
      } catch {
        try {
          node.currentTime = safeTime;
        } catch {
          return;
        }
      }

      window.requestAnimationFrame(() => {
        if (videoRef.current !== node) return;
        const actualTime = finiteMediaTime(node.currentTime);
        setCurrentTime(actualTime || safeTime);
      });
    }
  }, [currentMedia, duration]);

  const refreshCurrentVideoDetail = useCallback(async () => {
    const awemeId = currentVideo?.aweme_id;
    if (!awemeId || refreshingDetailRef.current || refreshedDetailIdsRef.current.has(awemeId)) {
      return false;
    }

    refreshingDetailRef.current = true;
    refreshedDetailIdsRef.current.add(awemeId);
    setLoadState("loading");
    setShowLoadStatus(true);

    try {
      const result = await getVideoDetail(awemeId);
      if (!result.success || !result.video) {
        return false;
      }

      setVideoOverrides((current) => ({
        ...current,
        [awemeId]: result.video as VideoInfo,
      }));
      setMediaIndex(0);
      setCurrentTime(0);
      setDuration(0);
      setReloadKey((value) => value + 1);
      return true;
    } catch {
      return false;
    } finally {
      refreshingDetailRef.current = false;
    }
  }, [currentVideo?.aweme_id]);

  const retryCurrentMedia = useCallback((event?: ReactMouseEvent, auto = false) => {
    event?.stopPropagation();
    if (!auto && currentVideo?.aweme_id) {
      refreshedDetailIdsRef.current.delete(currentVideo.aweme_id);
    }
    clearLoadTimers();
    autoRetryCountRef.current = auto ? autoRetryCountRef.current : 0;
    setLoadState("loading");
    setShowLoadStatus(true);
    setCurrentTime(0);
    setDuration(0);
    setReloadKey((value) => value + 1);
  }, [clearLoadTimers, currentVideo?.aweme_id]);

  const markMediaReady = useCallback(() => {
    clearLoadTimers();
    setLoadState("ready");
    setShowLoadStatus(false);
    mediaSwitchingRef.current = false;
  }, [clearLoadTimers]);

  const handleMediaFailure = useCallback(async () => {
    clearLoadTimers();
    stopVideoProgressLoop();
    mediaSwitchingRef.current = false;

    const mediaErrorCode = videoRef.current?.error?.code || 0;
    const canAutoRetry =
      (typeof navigator === "undefined" || navigator.onLine !== false) &&
      (mediaErrorCode === 0 || mediaErrorCode === 2 || mediaErrorCode === 4) &&
      autoRetryCountRef.current < PLAYER_VIDEO_MAX_AUTO_RETRIES;

    if (canAutoRetry) {
      autoRetryCountRef.current += 1;
      retryCurrentMedia(undefined, true);
      return;
    }

    const refreshed = await refreshCurrentVideoDetail();
    if (refreshed) return;

    setLoadState("error");
    setPlaying(false);
    setShowLoadStatus(true);
  }, [clearLoadTimers, refreshCurrentVideoDetail, retryCurrentMedia, stopVideoProgressLoop]);

  const handleImageLoad = useCallback(() => {
    markMediaReady();
    releaseMediaSwitchSoon();
    if (desiredPlayingRef.current) {
      setPlaying(true);
    }
  }, [markMediaReady, releaseMediaSwitchSoon]);

  const handleImageError = useCallback(() => {
    void handleMediaFailure();
  }, [handleMediaFailure]);

  const scheduleLoadTimeout = useCallback(() => {
    if (loadTimeoutTimerRef.current) {
      window.clearTimeout(loadTimeoutTimerRef.current);
    }

    loadTimeoutTimerRef.current = window.setTimeout(() => {
      const node = videoRef.current;
      if (!currentMedia || !isVideoLikeMedia(currentMedia)) return;
      if (!desiredPlayingRef.current || node?.paused) return;
      if (node && node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
      void handleMediaFailure();
    }, PLAYER_VIDEO_LOAD_TIMEOUT_MS);
  }, [currentMedia, handleMediaFailure]);

  const showBufferingSoon = useCallback(() => {
    if (bufferingTimerRef.current) {
      window.clearTimeout(bufferingTimerRef.current);
    }
    bufferingTimerRef.current = window.setTimeout(() => {
      const node = videoRef.current;
      if (!desiredPlayingRef.current || node?.paused) return;
      if (node && node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
      setLoadState("loading");
      setShowLoadStatus(true);
    }, PLAYER_VIDEO_REBUFFER_STATUS_DELAY_MS);
  }, []);

  const preloadMediaItem = useCallback((media: VideoMediaItem | null | undefined, full = false) => {
    const target = resolvePreloadTarget(media);
    if (!target || !media) return;

    const existingFullPreload = preloadedMediaRef.current.get(target.key);
    if (existingFullPreload || (!full && preloadedMediaRef.current.has(target.key))) return;
    preloadedMediaRef.current.set(target.key, full);

    if (media.type === "image") {
      const image = new Image();
      image.decoding = "async";
      image.loading = "eager";
      image.onload = () => {
        if (image.naturalWidth > 0) {
          preloadedReadyRef.current.add(target.key);
        }
      };
      image.src = target.url;
      if (image.complete && image.naturalWidth > 0) {
        preloadedReadyRef.current.add(target.key);
      }
      rememberPreloadedNode(image);
    } else {
      const video = document.createElement("video");
      video.preload = full ? "auto" : "metadata";
      video.muted = true;
      video.playsInline = true;
      const markReady = () => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          preloadedReadyRef.current.add(target.key);
        }
      };
      video.addEventListener("loadeddata", markReady, { once: true });
      video.addEventListener("canplay", markReady, { once: true });
      video.src = target.url;
      video.load();
      markReady();
      rememberPreloadedNode(video);
    }
  }, [rememberPreloadedNode, resolvePreloadTarget]);

  const releasePreloadedMedia = useCallback(() => {
    preloadedMediaRef.current.clear();
    preloadedReadyRef.current.clear();
    for (const node of preloadedNodesRef.current) {
      if (node instanceof HTMLVideoElement) {
        releaseMediaElement(node);
      } else {
        node.removeAttribute("src");
      }
    }
    preloadedNodesRef.current = [];
  }, []);

  const preloadVideoAtIndex = useCallback((index: number, full = false) => {
    const video = videos[index];
    if (!video) return;
    const firstMedia = collectVideoMedia(video)[0];
    preloadMediaItem(firstMedia, full);
  }, [preloadMediaItem, videos]);

  const releasePlayerMediaResources = useCallback(() => {
    mediaAdvanceSeqRef.current += 1;
    desiredPlayingRef.current = false;
    playingRef.current = false;
    mediaSwitchingRef.current = false;
    qualitySwitchingRef.current = false;
    clearLoadTimers();
    stopVideoProgressLoop();
    releaseMediaElement(videoRef.current);
    releaseScopedMediaElements(playerRootRef.current);
    releaseBgm();
    releasePreloadedMedia();
  }, [clearLoadTimers, releaseBgm, releasePreloadedMedia, stopVideoProgressLoop]);

  const closePlayer = useCallback(() => {
    wasOpenRef.current = false;
    releasePlayerMediaResources();
    setPlaying(false);
    setShowLoadStatus(false);
    onClose();
  }, [onClose, releasePlayerMediaResources]);

  useEffect(() => {
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      playerRootRef.current?.focus({ preventScroll: true });
    }, 0);

    const safeIndex = Math.min(Math.max(initialIndex, 0), Math.max(videos.length - 1, 0));
    const initialMediaCount = collectVideoMedia(videos[safeIndex]).length;
    const safeMediaIndex = Math.min(
      Math.max(initialMediaIndex, 0),
      Math.max(initialMediaCount - 1, 0)
    );
    desiredPlayingRef.current = true;
    mediaSwitchingRef.current = false;
    setMediaTransitionDirection(0);
    setCurrentIndex(safeIndex);
    setMediaIndex(safeMediaIndex);
    setCurrentTime(0);
    setDuration(0);
    progressSampleRef.current = 0;
    setPlaying(false);
    return () => window.clearTimeout(focusTimer);
  }, [initialIndex, initialMediaIndex, initialVideoKey, open]);

  useEffect(() => {
    setOpenPanel(null);
    setComments([]);
    setCommentsError("");
    setCommentsCursor(0);
    setCommentsHasMore(false);
    setCommentsTotal(0);
    setCommentsLoadedAwemeId("");
    setCommentReplies({});
    setExpandedCommentReplyIds(new Set());
  }, [currentVideo?.aweme_id]);

  useEffect(() => {
    if (openPanel !== "share") return;
    void loadShareFriends();
  }, [loadShareFriends, openPanel]);

  useEffect(() => {
    if (!commentsOpen || !currentVideo?.aweme_id || commentsLoadedAwemeId === currentVideo.aweme_id) return;
    void loadComments("initial");
  }, [commentsLoadedAwemeId, commentsOpen, currentVideo?.aweme_id, loadComments]);

  useEffect(() => {
    return () => {
      if (mediaSwitchReleaseRef.current) {
        window.clearTimeout(mediaSwitchReleaseRef.current);
      }
      if (qualitySwitchReleaseRef.current) {
        window.clearTimeout(qualitySwitchReleaseRef.current);
      }
      if (panelCloseTimerRef.current) {
        window.clearTimeout(panelCloseTimerRef.current);
      }
      if (commentsHoverCloseTimerRef.current) {
        window.clearTimeout(commentsHoverCloseTimerRef.current);
      }
      if (wheelResetTimerRef.current) {
        window.clearTimeout(wheelResetTimerRef.current);
      }
      if (navigationNoticeTimerRef.current) {
        window.clearTimeout(navigationNoticeTimerRef.current);
      }
      clearLoadTimers();
      stopVideoProgressLoop();
      releaseBgm();
      releasePreloadedMedia();
      releaseMediaElement(videoRef.current);
      releaseScopedMediaElements(playerRootRef.current);
    };
  }, [clearLoadTimers, releaseBgm, releasePreloadedMedia, stopVideoProgressLoop]);

  useEffect(() => {
    if (open) return;
    clearCommentsHoverCloseTimer();
    commentsPanelStickyRef.current = false;
    setCommentsOpen(false);
    setPlaying(false);
    setShowLoadStatus(false);
    releasePlayerMediaResources();
  }, [clearCommentsHoverCloseTimer, open, releasePlayerMediaResources]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || videos.length === 0) return;
    if (currentIndex >= videos.length) {
      goToVideo(videos.length - 1);
    }
  }, [currentIndex, goToVideo, open, videos.length]);

  useEffect(() => {
    if (mediaIndex < mediaItems.length) return;
    setMediaIndex(0);
  }, [mediaIndex, mediaItems.length]);

  useEffect(() => {
    pendingQualitySeekRef.current = null;
    setSelectedQualityKey("auto");
  }, [currentMedia?.url, currentVideo?.aweme_id, mediaIndex]);

  useEffect(() => {
    if (qualityOptions.length === 0) {
      if (selectedQualityKey !== "auto") setSelectedQualityKey("auto");
      return;
    }
    if (qualityOptions.some((option) => option.key === selectedQualityKey)) return;
    setSelectedQualityKey("auto");
  }, [qualityOptions, selectedQualityKey]);

  useEffect(() => {
    autoRetryCountRef.current = 0;
  }, [currentMedia?.url, currentVideo?.aweme_id, mediaIndex, selectedQualityKey]);

  useEffect(() => {
    bgmManuallyPausedRef.current = false;
  }, [currentVideo?.aweme_id, musicUrl]);

  useEffect(() => {
    imageAdvanceQueued.current = false;
    setShowLoadStatus(false);
    clearLoadTimers();

    if (!currentMedia || currentMedia.type === "image") {
      setCurrentTime(0);
      setDuration(currentMedia?.type === "image" ? IMAGE_DURATION_SECONDS : 0);
    }
    progressSampleRef.current = 0;
    setLoadState(currentMedia ? "loading" : "error");
    setPlaying(Boolean(currentMedia && desiredPlayingRef.current));

    if (currentMedia && isVideoLikeMedia(currentMedia)) {
      loadStatusTimerRef.current = window.setTimeout(() => {
        const node = videoRef.current;
        if (node && node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
        setShowLoadStatus(true);
      }, PLAYER_VIDEO_INITIAL_STATUS_DELAY_MS);
      scheduleLoadTimeout();
      if (mediaItems.length > 1) {
        const nextIndex = (mediaIndex + 1) % mediaItems.length;
        preloadMediaItem(mediaItems[nextIndex], true);
      }
    }
  }, [clearLoadTimers, currentMedia, mediaIndex, mediaItems, mediaKey, preloadMediaItem, scheduleLoadTimeout]);

  useEffect(() => {
    if (!open || !currentVideo || mediaItems.length > 0) return;
    void refreshCurrentVideoDetail().then((refreshed) => {
      if (refreshed) return;
      setLoadState("error");
      setShowLoadStatus(true);
    });
  }, [currentVideo, mediaItems.length, open, refreshCurrentVideoDetail]);

  useEffect(() => {
    if (!open || !onLoadMore || videos.length === 0) return;
    const remaining = videos.length - currentIndex - 1;
    if (remaining > LOAD_MORE_THRESHOLD) return;
    if (loadMoreRequestedForLength.current === videos.length) return;
    loadMoreRequestedForLength.current = videos.length;
    onLoadMore();
  }, [currentIndex, onLoadMore, open, videos.length]);

  useEffect(() => {
    if (!open || !currentMedia || !isVideoLikeMedia(currentMedia)) return;
    if (duration <= 0 || currentTime <= 0) return;
    if (duration - currentTime > PLAYER_NEXT_VIDEO_PRELOAD_AHEAD_SECONDS) return;
    preloadVideoAtIndex(currentIndex + 1, false);
  }, [currentIndex, currentMedia, currentTime, duration, open, preloadVideoAtIndex]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      prewarmVideoForPlayback(videos[currentIndex + 1]);
      prewarmVideoForPlayback(videos[currentIndex - 1]);
    }, loadState === "ready" ? 160 : 700);
    return () => window.clearTimeout(timer);
  }, [currentIndex, loadState, open, videos]);

  useEffect(() => {
    releasePreloadedMedia();
  }, [currentVideo?.aweme_id, releasePreloadedMedia]);

  useEffect(() => {
    if (!open || mediaItems.length <= 1 || loadState !== "ready") return;

    const orderedIndexes = Array.from(
      new Set([
        (mediaIndex + 1) % mediaItems.length,
        (mediaIndex - 1 + mediaItems.length) % mediaItems.length,
      ])
    ).filter((index) => index !== mediaIndex);
    let cancelled = false;
    const timers: number[] = [];

    orderedIndexes.forEach((index, order) => {
      const timer = window.setTimeout(() => {
        if (cancelled) return;
        preloadMediaItem(mediaItems[index], true);
      }, order * 140);
      timers.push(timer);
    });

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [loadState, mediaIndex, mediaItems, open, preloadMediaItem]);

  useEffect(() => {
    if (!open || !currentMedia || !isVideoLikeMedia(currentMedia)) return;
    const frame = window.requestAnimationFrame(() => {
      const node = videoRef.current;
      if (!node || !desiredPlayingRef.current) return;
      resumeVideoIfDesired(node);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentMedia, mediaKey, open, resumeVideoIfDesired]);

  useEffect(() => {
    const shouldKeepBgmPlaying = Boolean(
      open &&
        currentMedia &&
        shouldUseBgmForCurrentMedia &&
        desiredPlayingRef.current &&
        loadState !== "error"
    );

    if (shouldKeepBgmPlaying) {
      playBgm();
      return;
    }

    if (
      mediaSwitchingRef.current &&
      bgmDesiredPlayingRef.current &&
      open &&
      currentMedia &&
      musicUrl &&
      loadState !== "error"
    ) {
      return;
    }

    pauseBgm();
  }, [currentMedia, loadState, musicUrl, open, pauseBgm, playBgm, playing, shouldUseBgmForCurrentMedia]);

  useEffect(() => {
    const audio = bgmRef.current;
    if (!audio) return;

    const handlePlay = () => setBgmPlaying(true);
    const handlePause = () => setBgmPlaying(false);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handlePause);
    audio.addEventListener("emptied", handlePause);
    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handlePause);
      audio.removeEventListener("emptied", handlePause);
    };
  }, []);

  useEffect(() => {
    const nextVolume = effectiveVolume / 100;
    const video = videoRef.current;
    if (video) {
      video.volume = nextVolume;
      video.muted = shouldUseBgmForCurrentMedia || muted || volume === 0;
      applyPlaybackRateToNode(video, playbackRateRef.current);
    }

    const audio = bgmRef.current;
    if (audio) {
      audio.volume = nextVolume;
      audio.muted = muted || volume === 0;
      applyPlaybackRateToNode(audio, playbackRateRef.current);
    }
  }, [effectiveVolume, mediaKey, muted, shouldUseBgmForCurrentMedia, volume]);

  useEffect(() => {
    syncPlaybackRate(playbackRate);
    const frame = window.requestAnimationFrame(() => syncPlaybackRate(playbackRate));
    const timer = window.setTimeout(() => syncPlaybackRate(playbackRate), 160);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [mediaKey, playbackRate, syncPlaybackRate]);

  useEffect(() => {
    stopVideoProgressLoop();
    return stopVideoProgressLoop;
  }, [mediaKey, stopVideoProgressLoop]);

  useEffect(() => {
    if (!open || currentMedia?.type !== "image" || !playing) return;

    let frame = 0;
    let last = performance.now();
    const tick = (timestamp: number) => {
      const delta = Math.max(0, timestamp - last) / 1000;
      last = timestamp;

      setCurrentTime((value) => {
        const next = Math.min(IMAGE_DURATION_SECONDS, value + delta * playbackRateRef.current);
        if (next >= IMAGE_DURATION_SECONDS && !imageAdvanceQueued.current) {
          imageAdvanceQueued.current = true;
          requestAdvanceMediaSequence();
        }
        return next;
      });

      if (!imageAdvanceQueued.current) {
        frame = window.requestAnimationFrame(tick);
      }
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [currentMedia?.type, mediaKey, open, playing, requestAdvanceMediaSequence]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      const key = event.key;
      const lowerKey = key.toLowerCase();
      const isEditableTarget = isKeyboardInputTarget(event.target);
      let handled = true;

      if (key === "Escape") {
        closePlayer();
      } else if (isEditableTarget) {
        handled = false;
      } else if (key === "ArrowUp" || lowerKey === "k") {
        playPrevVideo();
      } else if (key === "ArrowDown" || lowerKey === "j") {
        playNextVideo();
      } else if (key === "ArrowLeft") {
        playPrevMedia();
      } else if (key === "ArrowRight") {
        playNextMedia();
      } else if (key === " ") {
        togglePlay();
      } else {
        handled = false;
      }

      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [closePlayer, open, playNextMedia, playNextVideo, playPrevMedia, playPrevVideo, togglePlay]);

  const handleWheel = useCallback((event: ReactWheelEvent) => {
    event.preventDefault();
    if (wheelLocked.current) return;

    const normalizedDeltaY = normalizeWheelDelta(event);
    if (normalizedDeltaY === 0) return;

    const previousDelta = wheelAccumulatedDeltaRef.current;
    if (previousDelta !== 0 && Math.sign(previousDelta) !== Math.sign(normalizedDeltaY)) {
      wheelAccumulatedDeltaRef.current = 0;
    }
    wheelAccumulatedDeltaRef.current += normalizedDeltaY;

    if (wheelResetTimerRef.current) {
      window.clearTimeout(wheelResetTimerRef.current);
    }
    wheelResetTimerRef.current = window.setTimeout(() => {
      wheelAccumulatedDeltaRef.current = 0;
      wheelResetTimerRef.current = null;
    }, WHEEL_IDLE_RESET_MS);

    if (Math.abs(wheelAccumulatedDeltaRef.current) < WHEEL_VIDEO_SWITCH_THRESHOLD) return;

    const shouldPlayNext = wheelAccumulatedDeltaRef.current > 0;
    wheelAccumulatedDeltaRef.current = 0;
    wheelLocked.current = true;
    window.setTimeout(() => {
      wheelLocked.current = false;
    }, WHEEL_VIDEO_SWITCH_LOCK_MS);

    if (shouldPlayNext) playNextVideo();
    else playPrevVideo();
  }, [playNextVideo, playPrevVideo]);

  const handleTouchStart = (event: ReactTouchEvent) => {
    touchStart.current = {
      x: event.touches[0]?.clientX || 0,
      y: event.touches[0]?.clientY || 0,
    };
  };

  const handleTouchEnd = (event: ReactTouchEvent) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touchStart.current.x - touch.clientX;
    const deltaY = touchStart.current.y - touch.clientY;

    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 54) {
      if (deltaX > 0) playNextMedia();
      else playPrevMedia();
      return;
    }

    if (Math.abs(deltaY) > 64) {
      if (deltaY > 0) playNextVideo();
      else playPrevVideo();
    }
  };

  return (
    <AnimatePresence>
      {open && currentVideo && (
        <motion.div
          ref={playerRootRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex flex-col overflow-hidden bg-black text-white"
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <TopCloseOverlay onClose={closePlayer} />

          <PlayerMediaStage
            mediaKey={mediaKey}
            mediaTransitionDirection={mediaTransitionDirection}
            currentMedia={currentMedia}
            currentMediaSrc={currentMediaSrc}
            currentVideo={currentVideo}
            shouldAutoPlayCurrentMedia={shouldAutoPlayCurrentMedia}
            hasMultipleMedia={hasMultipleMedia}
            shouldUseBgmForCurrentMedia={shouldUseBgmForCurrentMedia}
            muted={muted}
            volume={volume}
            playing={playing}
            loadState={loadState}
            showLoadStatus={showLoadStatus}
            navigationNotice={navigationNotice}
            setVideoElementRef={setVideoElementRef}
            surfaceHitRef={surfaceHitRef}
            handleSurfacePointerDown={handleSurfacePointerDown}
            handleSurfacePointerUp={handleSurfacePointerUp}
            handleSurfacePointerCancel={handleSurfacePointerCancel}
            handleSurfaceMouseDown={handleSurfaceMouseDown}
            handleSurfaceMouseUp={handleSurfaceMouseUp}
            handleSurfaceTouchStart={handleSurfaceTouchStart}
            handleSurfaceTouchEnd={handleSurfaceTouchEnd}
            handleSurfaceClick={handleSurfaceClick}
            scheduleLoadTimeout={scheduleLoadTimeout}
            showBufferingSoon={showBufferingSoon}
            onLoadedMetadata={(event) => {
              applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
              restorePendingQualitySeek(event.currentTarget);
              syncVideoProgress(event.currentTarget);
              event.currentTarget.volume = effectiveVolume / 100;
              event.currentTarget.muted = shouldUseBgmForCurrentMedia || muted || volume === 0;
              if (event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                markMediaReady();
              }
              resumeVideoIfDesired(event.currentTarget);
            }}
            onLoadedData={(event) => {
              applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
              syncVideoProgress(event.currentTarget);
              markMediaReady();
              resumeVideoIfDesired(event.currentTarget);
            }}
            onDurationChange={(event) => {
              syncVideoProgress(event.currentTarget);
            }}
            onCanPlay={(event) => {
              applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
              restorePendingQualitySeek(event.currentTarget);
              syncVideoProgress(event.currentTarget);
              markMediaReady();
              releaseMediaSwitchSoon();
              resumeVideoIfDesired(event.currentTarget);
            }}
            onTimeUpdate={(event) => {
              syncVideoProgress(event.currentTarget);
              if (loadState !== "ready" && event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                markMediaReady();
              }
            }}
            onSeeking={(event) => syncVideoProgress(event.currentTarget)}
            onSeeked={(event) => syncVideoProgress(event.currentTarget)}
            onPlay={(event) => {
              applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
              desiredPlayingRef.current = true;
              playingRef.current = true;
              syncVideoProgress(event.currentTarget);
              setPlaying(true);
              startVideoProgressLoop();
            }}
            onPlaying={(event) => {
              applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
              qualitySwitchingRef.current = false;
              if (qualitySwitchReleaseRef.current) {
                window.clearTimeout(qualitySwitchReleaseRef.current);
                qualitySwitchReleaseRef.current = null;
              }
              playingRef.current = true;
              syncVideoProgress(event.currentTarget);
              if (loadState !== "ready") {
                markMediaReady();
              }
              setPlaying(true);
              startVideoProgressLoop();
            }}
            onPause={(event) => {
              stopVideoProgressLoop();
              if (qualitySwitchingRef.current && desiredPlayingRef.current) {
                window.setTimeout(() => resumeVideoIfDesired(event.currentTarget), 80);
                return;
              }
              if ((mediaSwitchingRef.current || event.currentTarget.ended) && desiredPlayingRef.current) {
                return;
              }
              if (!mediaSwitchingRef.current) {
                clearLoadTimers();
                playingRef.current = false;
                setPlaying(false);
                desiredPlayingRef.current = false;
                setShowLoadStatus(false);
                setLoadState("ready");
              }
            }}
            onRateChange={(event) => {
              applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
            }}
            onEnded={() => {
              desiredPlayingRef.current = true;
              mediaSwitchingRef.current = true;
              setPlaying(true);
              stopVideoProgressLoop();
              advanceMediaSequence();
            }}
            onError={() => {
              void handleMediaFailure();
            }}
            onImageLoad={handleImageLoad}
            onImageError={handleImageError}
            retryCurrentMedia={retryCurrentMedia}
          />

          <div
            className="absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2 pt-20 text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <AuthorInfo
                authorAvatar={authorAvatar}
                authorName={authorName}
                canOpenAuthor={canOpenAuthor}
                onAuthorClick={() => {
                  if (!currentVideo || !canOpenAuthor) return;
                  releasePlayerMediaResources();
                  onAuthor?.(currentVideo);
                }}
              />

              <PlayerActionButtons
                liked={liked}
                favorited={favorited}
                likeCount={likeCount}
                favoriteCount={favoriteCount}
                relationSubmitting={relationSubmitting}
                openPanel={openPanel}
                muted={muted}
                volume={volume}
                effectiveVolume={effectiveVolume}
                playbackRate={playbackRate}
                qualityOptions={qualityOptions}
                activeQualityOption={activeQualityOption}
                showQualityControl={showQualityControl}
                shareFriends={shareFriends}
                shareFriendsLoading={shareFriendsLoading}
                shareFriendsError={shareFriendsError}
                shareSendingFriendKey={shareSendingFriendKey}
                shareSentFriendKeys={shareSentFriendKeys}
                downloadSubmitting={downloadSubmitting}
                musicUrl={musicUrl}
                bgmPlaying={bgmPlaying}
                bgmProxyUrl={bgmProxyUrl}
                hasDownloadHandler={Boolean(onDownload)}
                commentsOpen={commentsOpen}
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
                currentVideoCommentCount={currentVideo?.statistics?.comment_count || 0}
                onToggleLike={(event) => {
                  event.stopPropagation();
                  void toggleLike();
                }}
                onToggleCollect={(event) => {
                  event.stopPropagation();
                  void toggleCollect();
                }}
                onToggleMute={toggleMute}
                onVolumeChange={handleVolumeChange}
                onPlaybackRateChange={handlePlaybackRateChange}
                onQualityChange={handleQualityChange}
                onShareFriendClick={handleShareFriendClick}
                onDownloadCurrent={handleDownloadCurrent}
                onCopyCurrentMediaUrl={copyCurrentMediaUrl}
                onToggleBgm={toggleBgm}
                onShowDetail={() => {
                  releasePlayerMediaResources();
                  onShowDetail?.(currentVideo);
                }}
                onTogglePanel={togglePanel}
                onOpenPanelOnPointerEnter={openPanelOnPointerEnter}
                onClosePanelOnPointerLeave={closePanelOnPointerLeave}
                onOpenToolPanel={openToolPanel}
                onSchedulePanelClose={schedulePanelClose}
                onOpenPanelOnPointerDown={openPanelOnPointerDown}
                onCommentsScroll={handleCommentsScroll}
                onToggleCommentReplies={toggleCommentReplies}
                onToggleCommentLike={toggleCommentLike}
                onSetCommentReplyTarget={setCommentReplyTarget}
                onCommentDraftChange={setCommentDraft}
                onSubmitComment={submitComment}
                onLoadCommentReplies={loadCommentReplies}
                onLoadMoreComments={() => void loadComments("more")}
                onCloseCommentsPanel={closeCommentsPanel}
                onOpenCommentsPanel={openCommentsPanel}
                onMarkCommentsPanelSticky={markCommentsPanelSticky}
                onScheduleTransientCommentsClose={scheduleTransientCommentsClose}
                onClearPanelCloseTimer={clearPanelCloseTimer}
              />
            </div>

            <div className="mt-0.5">
              <PlayerPlaybackBar
                duration={duration}
                currentTime={currentTime}
                progressPct={progressPct}
                mediaItems={mediaItems}
                activeMediaIndex={activeMediaIndex}
                previewSrc={currentMedia && isVideoLikeMedia(currentMedia) ? currentMediaSrc : ""}
                onSeek={handleSeek}
                onSelectMedia={switchToMedia}
              />

              <PlayerDescription currentVideo={currentVideo} />
            </div>
          </div>

          <audio
            ref={bgmRef}
            className="hidden"
            onLoadedMetadata={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
            onCanPlay={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
            onPlay={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
            onRateChange={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

