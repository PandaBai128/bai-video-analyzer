import { type ExtensionRequest, type ExtensionResponse } from '@shared/messages';
import type { PlaybackState } from '@shared/playback-state';
import { isExtensionRuntimeAvailable, sendRuntimeMessage } from '@shared/extension-runtime';
import { detectPageContext } from '@shared/page-context';
import {
  fetchYouTubeTranscriptInPageContext,
  getCurrentYouTubeVideoId,
  type YouTubeTranscriptError,
} from '@extension/content/youtube-transcript-fetcher';
import type { YouTubePageCaptionTrack } from '@shared/youtube-transcript';

function sendPageDetected(): void {
  const context = detectPageContext(location.href, document.title);
  void sendRuntimeMessage({
    type: 'PAGE_DETECTED',
    payload: context,
  } satisfies ExtensionRequest);
}

function seekActiveVideo(seconds: number): boolean {
  const video = getPrimaryVideo();

  if (!video) {
    return false;
  }

  const targetTime = Math.max(0, seconds);
  if (typeof video.fastSeek === 'function') {
    video.fastSeek(targetTime);
  } else {
    video.currentTime = targetTime;
  }
  void video.play().catch(() => undefined);
  return true;
}

function sendPlaybackProgress(): void {
  const video = getPrimaryVideo();

  if (!video) {
    return;
  }

  const payload = {
    currentTime: video.currentTime,
    paused: video.paused,
    updatedAt: Date.now(),
  };

  void sendRuntimeMessage({
    type: 'PLAYBACK_PROGRESS',
    payload: Number.isFinite(video.duration) ? { ...payload, duration: video.duration } : payload,
  } satisfies ExtensionRequest);
}

/**
 * Round 27 QA2 必修 C #2：处理 `READ_ACTIVE_VIDEO_PLAYBACK`。
 * - 调 `getPrimaryVideo()`，找不到 video → 返回 `payload: null`
 * - 找到 video → 立即返回 `{ currentTime, duration?, paused, updatedAt: Date.now() }`
 * - 同时调一次 `sendPlaybackProgress()` 写回 background 缓存，让后续 GET_PLAYBACK_STATE
 *   走缓存快速路径。
 * - 关键：响应必须**立即**给到（side panel 等着填 currentTime）。sync sendResponse。
 */
function readActiveVideoPlayback(): ExtensionResponse {
  const video = getPrimaryVideo();
  if (!video) {
    return { ok: true, type: 'PLAYBACK_STATE', payload: null };
  }
  const base = {
    currentTime: video.currentTime,
    paused: video.paused,
    updatedAt: Date.now(),
  };
  const state: PlaybackState = Number.isFinite(video.duration)
    ? { ...base, duration: video.duration }
    : base;
  // 同步写回 background 缓存；不 await，让响应立即返回。
  void sendRuntimeMessage({
    type: 'PLAYBACK_PROGRESS',
    payload: state,
  } satisfies ExtensionRequest);
  return { ok: true, type: 'PLAYBACK_STATE', payload: state };
}

function getPrimaryVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video')).filter(
    (element): element is HTMLVideoElement => element instanceof HTMLVideoElement,
  );

  if (videos.length === 0) {
    return null;
  }

  return videos
    .map((video) => ({
      video,
      area: video.getBoundingClientRect().width * video.getBoundingClientRect().height,
    }))
    .sort((a, b) => b.area - a.area)[0]?.video ?? null;
}

const runtimeState = window as Window & {
  __baiContentScriptInitialized?: boolean;
  __baiMessageListenerRegistered?: boolean;
};

if (isExtensionRuntimeAvailable() && !runtimeState.__baiMessageListenerRegistered) {
  runtimeState.__baiMessageListenerRegistered = true;

  chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
    if (request.type === 'SEEK_ACTIVE_VIDEO') {
      sendResponse({
        ok: true,
        type: 'DONE',
        found: seekActiveVideo(request.payload.seconds),
      });
      return;
    }

    if (request.type === 'READ_ACTIVE_VIDEO_PLAYBACK') {
      // Round 27 QA2 必修 C #2：同步响应 currentTime / paused / duration
      sendResponse(readActiveVideoPlayback());
      return;
    }

    if (request.type === 'FETCH_YOUTUBE_TRANSCRIPT') {
      handleFetchYouTubeTranscript(request.payload)
        .then(sendResponse)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          sendResponse({
            ok: false,
            type: 'YOUTUBE_TRANSCRIPT_FAILED',
            error: {
              code: 'NETWORK_ERROR',
              message,
              stage: 'dom_panel',
            },
          } satisfies ExtensionResponse);
        });
      return true;
    }

    sendResponse({ ok: false, error: 'UNSUPPORTED_MESSAGE' });
  });
}

async function handleFetchYouTubeTranscript(
  payload: {
    videoId: string;
    languages?: readonly string[];
    pageCaptionTracks?: readonly YouTubePageCaptionTrack[];
  },
): Promise<ExtensionResponse> {
  const currentVideoId = getCurrentYouTubeVideoId();
  if (!currentVideoId) {
    return transcriptFailedResponse({
      code: 'NO_VIDEO_ID',
      message: '当前页面不是 YouTube 视频页。请打开 https://www.youtube.com/watch?v=... 再试。',
      stage: 'extract_video_id',
    });
  }

  if (currentVideoId !== payload.videoId) {
    return transcriptFailedResponse({
      code: 'NO_VIDEO_ID',
      message: `当前页 videoId(${currentVideoId}) 与请求 videoId(${payload.videoId}) 不一致，拒绝使用`,
      stage: 'extract_video_id',
    });
  }

  try {
    const result = await fetchYouTubeTranscriptInPageContext({
      videoId: currentVideoId,
      ...(payload.languages ? { languages: payload.languages } : {}),
      ...(payload.pageCaptionTracks ? { pageCaptionTracks: payload.pageCaptionTracks } : {}),
    });
    return {
      ok: true,
      type: 'YOUTUBE_TRANSCRIPT',
      payload: {
        result,
        attempts: result.timings,
      },
    };
  } catch (error) {
    if (isYouTubeTranscriptError(error)) {
      return transcriptFailedResponse(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return transcriptFailedResponse({
      code: 'NETWORK_ERROR',
      message,
      stage: 'dom_panel',
    });
  }
}

function transcriptFailedResponse(error: YouTubeTranscriptError): ExtensionResponse {
  return {
    ok: false,
    type: 'YOUTUBE_TRANSCRIPT_FAILED',
    error,
  };
}

function isYouTubeTranscriptError(error: unknown): error is YouTubeTranscriptError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'stage' in error &&
    typeof (error as Record<string, unknown>).code === 'string' &&
    typeof (error as Record<string, unknown>).stage === 'string'
  );
}

function notifyPageMayHaveChanged(): void {
  sendPageDetected();
  // SPA 站点通常先改 URL，再异步更新 title；延迟补发一次避免标题/分 P 信息滞后。
  window.setTimeout(sendPageDetected, 300);
  window.setTimeout(sendPageDetected, 1200);
}

function patchHistoryNavigation(): void {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  window.history.pushState = function pushState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalPushState.call(this, data, unused, url);
    notifyPageMayHaveChanged();
  };

  window.history.replaceState = function replaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalReplaceState.call(this, data, unused, url);
    notifyPageMayHaveChanged();
  };
}

/**
 * Round 27 QA2 必修 C #3：事件驱动上报。
 * - 绑当前 primary video 的 `timeupdate` / `playing` / `pause` / `seeked` /
 *   `loadedmetadata` / `durationchange` 事件 → 触发 `sendPlaybackProgress()`。
 * - SPA 换 video 元素（B 站切 P / 切换分 P / YouTube 切下一个视频）：
 *   在现有 1 秒 timer 里检测 `getPrimaryVideo()` 是否变了。
 *   变了：解绑旧 listener → 绑新 listener → 立即 `sendPlaybackProgress()`。
 * - 保留 1 秒轮询作为兜底（譬如事件被吞 / 静音 / 暂停中时 `timeupdate` 可能不触发）。
 */
const PLAYBACK_EVENT_NAMES: readonly (keyof HTMLMediaElementEventMap)[] = [
  'timeupdate',
  'playing',
  'pause',
  'seeked',
  'loadedmetadata',
  'durationchange',
];

let boundVideo: HTMLVideoElement | null = null;
const boundListeners: {
  readonly name: keyof HTMLMediaElementEventMap;
  readonly handler: () => void;
}[] = [];

function rebindPlaybackListeners(): void {
  const current = getPrimaryVideo();
  if (current === boundVideo) {
    return;
  }
  // 解绑旧 video
  if (boundVideo) {
    for (const { name, handler } of boundListeners) {
      boundVideo.removeEventListener(name, handler);
    }
    boundListeners.length = 0;
  }
  boundVideo = current;
  if (current) {
    for (const name of PLAYBACK_EVENT_NAMES) {
      const handler = (): void => {
        sendPlaybackProgress();
      };
      current.addEventListener(name, handler);
      boundListeners.push({ name, handler });
    }
    // 换 video 时**立即**发一次（新 video 状态不应等到下一次轮询）
    sendPlaybackProgress();
  }
}

if (!runtimeState.__baiContentScriptInitialized) {
  runtimeState.__baiContentScriptInitialized = true;

  patchHistoryNavigation();
  window.addEventListener('popstate', notifyPageMayHaveChanged);
  window.addEventListener('hashchange', notifyPageMayHaveChanged);
  window.addEventListener('yt-navigate-finish', notifyPageMayHaveChanged);
  window.addEventListener('yt-page-data-updated', notifyPageMayHaveChanged);

  sendPageDetected();
  sendPlaybackProgress();
  // Round 27 QA2 必修 C #3：初始化时立即绑当前 primary video 的事件
  rebindPlaybackListeners();

  let lastHref = location.href;
  let lastTitle = document.title;
  const playbackTimer = window.setInterval(() => {
    if (!isExtensionRuntimeAvailable()) {
      window.clearInterval(playbackTimer);
      return;
    }

    if (location.href !== lastHref || document.title !== lastTitle) {
      lastHref = location.href;
      lastTitle = document.title;
      sendPageDetected();
    }

    // 检测 SPA 换 video 元素
    rebindPlaybackListeners();

    // 1 秒轮询兜底
    sendPlaybackProgress();
  }, 1000);
} else {
  notifyPageMayHaveChanged();
  sendPlaybackProgress();
  rebindPlaybackListeners();
}
