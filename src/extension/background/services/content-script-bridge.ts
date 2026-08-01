/**
 * Content script 通信与恢复 bridge。
 *
 * 统一负责 `chrome.tabs.sendMessage` 单次发送、`chrome.scripting.executeScript`
 * 主动注入、注入后 listener 就绪等待，以及 YouTube 字幕 / 播放状态 / 视频 seek
 * 三类消息的恢复链路。
 *
 * 这三类消息的恢复模式相同（content script 不可用 → 注入重试；video 元素短暂
 * 不可用 → 短间隔重试），属于同一 Chrome 通信与恢复生命周期，所以放在同一模块。
 * 不再拆成 sender / injector / retry 等多个小文件。
 *
 * 不变量：
 * - 只对 `CONTENT_SCRIPT_UNAVAILABLE` 做主动注入恢复；其它错误（NETWORK_ERROR、
 *   callback 同步抛错）立即返回，不重试避免掩盖真实问题
 * - 真实业务错误立即返回，不误重试
 * - 错误码、中文错误文案和响应结构保持向后兼容
 *
 * 纯行为版 `createContentScriptBridge(deps)` 供单测用；生产版
 * `createChromeContentScriptBridge({ createErrorResponse, logWarn })` 内部组装
 * `chrome.tabs.sendMessage` / `chrome.scripting.executeScript` / 真实 sleep / now
 * 等，service-worker 不再直接调 chrome.* API。
 *
 * 不得使用 `as unknown as` 绕类型。
 */
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { PlaybackState } from '@shared/playback-state';
import type {
  YouTubePageCaptionTrack,
  YouTubePageCaptionTrackName,
  YouTubeTranscriptError,
  YouTubeTranscriptResult,
  YouTubeTranscriptAttempt,
} from '@shared/youtube-transcript';

/** 注入：单次 sendMessage，解析 `chrome.runtime.lastError` 为结构化错误。 */
export type SendMessageFn = (
  tabId: number,
  request: ExtensionRequest,
) => Promise<
  | { ok: true; response: unknown }
  | { ok: false; code: 'CONTENT_SCRIPT_UNAVAILABLE' | 'NETWORK_ERROR'; message: string }
>;

/** 注入：主动注入 content.js；返回 true 表示成功，false 表示失败。 */
export type InjectContentScriptFn = (tabId: number) => Promise<boolean>;

/** 注入：可暂停指定毫秒；测试可换 fake sleep 避免真实墙钟时间。 */
export type SleepFn = (ms: number) => Promise<void>;

/** 注入：当前时间戳；测试可换 fake now 验证累计超时。 */
export type NowFn = () => number;

/** 注入：构造普通错误响应。 */
export type CreateErrorResponseFn = (
  code: string,
  message: string,
) => ExtensionResponse;

/** 注入：可观测的 warn 日志（注入失败等场景）。 */
export type LogWarnFn = (message: string, ...rest: unknown[]) => void;

/** 注入：在 YouTube MAIN world 读取当前播放器暴露的字幕轨。 */
export type ReadYouTubePlayerCaptionTracksFn = (
  tabId: number,
  videoId: string,
) => Promise<readonly YouTubePageCaptionTrack[]>;

/** sendMessageWithRecovery 内部使用的注入后固定等待。 */
const DEFAULT_INJECT_BACKOFF_MS = 200;

/** 字幕 listener 路由等待总超时。 */
const TRANSCRIPT_LISTENER_TIMEOUT_MS = 3_000;

/** 字幕 listener 等待 backoff（按 attempt 顺序，不是 elapsed 毫秒数）。 */
const TRANSCRIPT_LISTENER_BACKOFFS: readonly number[] = [200, 300, 500, 800, 1200];

/** 播放状态 video 元素短暂不可用重试间隔（task §3 #4 累计 ~1.85s）。 */
const PLAYBACK_VIDEO_RETRIES: readonly number[] = [100, 250, 500, 1000];

/** seek video 元素短暂不可用重试间隔（累计 ~3.2s）。 */
const SEEK_VIDEO_RETRIES: readonly number[] = [200, 500, 1000, 1500];

export interface ContentScriptBridgeDeps {
  readonly sendMessage: SendMessageFn;
  readonly injectContentScript: InjectContentScriptFn;
  readonly readYouTubePlayerCaptionTracks?: ReadYouTubePlayerCaptionTracksFn;
  readonly sleep: SleepFn;
  readonly now: NowFn;
  readonly createErrorResponse: CreateErrorResponseFn;
}

export interface ContentScriptBridge {
  /** 抓取 YouTube 字幕：单次 → 注入 → 轮询 listener 路由。 */
  readonly fetchYouTubeTranscript: (
    tabId: number,
    payload: { videoId: string; languages?: readonly string[] },
  ) => Promise<
    | { ok: true; result: YouTubeTranscriptResult; attempts: readonly YouTubeTranscriptAttempt[] }
    | { ok: false; error: YouTubeTranscriptError }
  >;
  /** 读取播放状态：注入 + video 元素短暂不可用短间隔重试。 */
  readonly readPlaybackState: (tabId: number) => Promise<PlaybackState | null>;
  /**
   * seek 当前视频：注入 + video 元素短暂不可用短间隔重试。
   * 返回 `DONE` 或错误响应（含 VIDEO_ELEMENT_NOT_FOUND / CONTENT_SCRIPT_UNAVAILABLE）。
   */
  readonly seekVideo: (
    tabId: number,
    request: Extract<ExtensionRequest, { type: 'SEEK_ACTIVE_VIDEO' }>,
  ) => Promise<ExtensionResponse>;
}

export function createContentScriptBridge(
  deps: ContentScriptBridgeDeps,
): ContentScriptBridge {
  /**
   * 通用 sendMessage + 主动注入恢复。
   * 只对 `CONTENT_SCRIPT_UNAVAILABLE` 注入；其它错误立即返回。
   */
  async function sendMessageWithRecovery(
    tabId: number,
    request: ExtensionRequest,
    injectBackoffMs: number = DEFAULT_INJECT_BACKOFF_MS,
  ): Promise<
    | { ok: true; response: unknown }
    | { ok: false; code: 'CONTENT_SCRIPT_UNAVAILABLE' | 'NETWORK_ERROR'; message: string }
  > {
    const first = await deps.sendMessage(tabId, request);
    if (first.ok) {
      return { ok: true, response: first.response };
    }
    if (first.code !== 'CONTENT_SCRIPT_UNAVAILABLE') {
      return { ok: false, code: first.code, message: first.message };
    }

    const injected = await deps.injectContentScript(tabId);
    if (!injected) {
      return {
        ok: false,
        code: 'CONTENT_SCRIPT_UNAVAILABLE',
        message: '主动注入 content script 失败，请刷新视频页后再试。',
      };
    }

    // 给 listener 注册留时间
    await deps.sleep(injectBackoffMs);

    const retry = await deps.sendMessage(tabId, request);
    if (retry.ok) {
      return { ok: true, response: retry.response };
    }
    return { ok: false, code: retry.code, message: retry.message };
  }


  async function fetchYouTubeTranscript(
    tabId: number,
    payload: { videoId: string; languages?: readonly string[] },
  ): Promise<
    | { ok: true; result: YouTubeTranscriptResult; attempts: readonly YouTubeTranscriptAttempt[] }
    | { ok: false; error: YouTubeTranscriptError }
  > {
    const pageCaptionTracks = await readTranscriptCaptionTracks(tabId, payload.videoId);
    const requestPayload =
      pageCaptionTracks.length > 0 ? { ...payload, pageCaptionTracks } : payload;
    const request: ExtensionRequest = {
      type: 'FETCH_YOUTUBE_TRANSCRIPT',
      payload: requestPayload,
    };

    // 第一次尝试：直接发消息（**不**走 sendMessageWithRecovery；polling 阶段需要
    // 重新发消息，如果先走 sendMessageWithRecovery 就会把 polling 的语义吞掉）
    const first = await deps.sendMessage(tabId, request);
    if (first.ok) {
      const response = first.response as
        | { type?: 'YOUTUBE_TRANSCRIPT' | 'YOUTUBE_TRANSCRIPT_FAILED'; payload?: { result: YouTubeTranscriptResult; attempts: readonly YouTubeTranscriptAttempt[] }; error?: YouTubeTranscriptError }
        | undefined;
      if (response?.type === 'YOUTUBE_TRANSCRIPT' && response.payload) {
        return {
          ok: true,
          result: response.payload.result,
          attempts: response.payload.attempts,
        };
      }
      if (response?.type === 'YOUTUBE_TRANSCRIPT_FAILED') {
        return {
          ok: false,
          error:
            response.error ?? {
              code: 'NETWORK_ERROR',
              message: 'content script 返回了未知错误',
              stage: 'dom_panel',
            },
        };
      }
      // 成功 callback 但 type 不识别 → 当作网络错误
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: 'content script 返回了未识别的响应',
          stage: 'dom_panel',
        },
      };
    }
    // first.ok is false
    if (first.code !== 'CONTENT_SCRIPT_UNAVAILABLE') {
      // 真实业务错误（非注入类） → 立即返回，不注入不轮询
      return {
        ok: false,
        error: {
          code: first.code,
          message: first.message,
          stage: 'dom_panel',
        },
      };
    }

    // C_S_U 路径：主动注入一次
    const injected = await deps.injectContentScript(tabId);
    if (!injected) {
      return {
        ok: false,
        error: {
          code: 'CONTENT_SCRIPT_UNAVAILABLE',
          message: 'YouTube content script 不可用，且主动注入失败。请刷新视频页面后再试。',
          stage: 'dom_panel',
        },
      };
    }

    // 注入后 listener 不一定立刻可路由 → 轮询等待
    return pollTranscriptListener(tabId, request);
  }

  async function readTranscriptCaptionTracks(
    tabId: number,
    videoId: string,
  ): Promise<readonly YouTubePageCaptionTrack[]> {
    if (!deps.readYouTubePlayerCaptionTracks) {
      return [];
    }

    try {
      return await deps.readYouTubePlayerCaptionTracks(tabId, videoId);
    } catch {
      return [];
    }
  }

  /**
   * 字幕 listener 路由轮询：直接 sendMessage，listener 拿到 YOUTUBE_TRANSCRIPT /
   * YOUTUBE_TRANSCRIPT_FAILED 即返回；累计到 timeoutMs 返回 CONTENT_SCRIPT_UNAVAILABLE。
   * **不**用 sendMessageWithRecovery（避免重复注入）。
   */
  async function pollTranscriptListener(
    tabId: number,
    request: ExtensionRequest,
  ): Promise<
    | { ok: true; result: YouTubeTranscriptResult; attempts: readonly YouTubeTranscriptAttempt[] }
    | { ok: false; error: YouTubeTranscriptError }
  > {
    const startedAt = deps.now();
    let attemptIndex = 0;

    while (deps.now() - startedAt < TRANSCRIPT_LISTENER_TIMEOUT_MS) {
      const wait =
        TRANSCRIPT_LISTENER_BACKOFFS[
          Math.min(attemptIndex, TRANSCRIPT_LISTENER_BACKOFFS.length - 1)
        ] ?? 1200;
      attemptIndex += 1;
      await deps.sleep(wait);
      if (deps.now() - startedAt >= TRANSCRIPT_LISTENER_TIMEOUT_MS) {
        break;
      }

      const send = await deps.sendMessage(tabId, request);
      if (!send.ok) {
        // C_S_U 继续轮询；其它错误立即返回
        if (send.code !== 'CONTENT_SCRIPT_UNAVAILABLE') {
          return {
            ok: false,
            error: {
              code: send.code,
              message: send.message,
              stage: 'dom_panel',
            },
          };
        }
        // 继续轮询
        continue;
      }
      const response = send.response as
        | { type?: 'YOUTUBE_TRANSCRIPT' | 'YOUTUBE_TRANSCRIPT_FAILED'; payload?: { result: YouTubeTranscriptResult; attempts: readonly YouTubeTranscriptAttempt[] }; error?: YouTubeTranscriptError }
        | undefined;
      if (response?.type === 'YOUTUBE_TRANSCRIPT' && response.payload) {
        return {
          ok: true,
          result: response.payload.result,
          attempts: response.payload.attempts,
        };
      }
      if (response?.type === 'YOUTUBE_TRANSCRIPT_FAILED') {
        // 业务错误：listener 已可路由，撞上真实错误 → 立即返回
        // 缺失 error 时沿用旧文案 `content script 返回了未知错误`（不要用新文案）
        return {
          ok: false,
          error:
            response.error ?? {
              code: 'NETWORK_ERROR',
              message: 'content script 返回了未知错误',
              stage: 'dom_panel',
            },
        };
      }
      // 成功 callback 但 type 不识别 → 立即返回 NETWORK_ERROR
      // （旧实现：listener 已可路由但返回未知响应时立即返回，**不**继续轮询，
      // **不**改写成 CONTENT_SCRIPT_UNAVAILABLE）
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: 'content script 返回了未识别的响应',
          stage: 'dom_panel',
        },
      };
    }

    return {
      ok: false,
      error: {
        code: 'CONTENT_SCRIPT_UNAVAILABLE',
        message: `YouTube content script 注入后 ${TRANSCRIPT_LISTENER_TIMEOUT_MS}ms 内 listener 仍不可路由，请刷新视频页面后再试。`,
        stage: 'dom_panel',
      },
    };
  }

  async function readPlaybackState(tabId: number): Promise<PlaybackState | null> {
    // 第一步：注入 + 重试
    const first = await sendMessageWithRecovery(tabId, {
      type: 'READ_ACTIVE_VIDEO_PLAYBACK',
    } satisfies ExtensionRequest);
    if (!first.ok) {
      return null;
    }
    const response = first.response as ExtensionResponse | undefined;
    if (response && response.ok && response.type === 'PLAYBACK_STATE' && response.payload) {
      return response.payload;
    }

    // 第二步：payload=null 短间隔重试（覆盖 video 元素重建窗口）
    for (const wait of PLAYBACK_VIDEO_RETRIES) {
      await deps.sleep(wait);
      const retry = await sendMessageWithRecovery(tabId, {
        type: 'READ_ACTIVE_VIDEO_PLAYBACK',
      } satisfies ExtensionRequest);
      if (!retry.ok) {
        return null;
      }
      const retryResponse = retry.response as ExtensionResponse | undefined;
      if (
        retryResponse &&
        retryResponse.ok &&
        retryResponse.type === 'PLAYBACK_STATE' &&
        retryResponse.payload
      ) {
        return retryResponse.payload;
      }
    }
    return null;
  }

  async function seekVideo(
    tabId: number,
    request: Extract<ExtensionRequest, { type: 'SEEK_ACTIVE_VIDEO' }>,
  ): Promise<ExtensionResponse> {
    // 第一步：注入 + 重试
    const sendResult = await sendMessageWithRecovery(tabId, request);
    if (!sendResult.ok) {
      return deps.createErrorResponse(sendResult.code, sendResult.message);
    }
    const lastResponse = sendResult.response as { readonly found?: boolean } | undefined;
    if (lastResponse?.found) {
      return { ok: true, type: 'DONE' };
    }

    // 第二步：video 元素短暂不可用时短间隔重试（覆盖 SPA 切视频后 video 元素重建窗口）
    for (const wait of SEEK_VIDEO_RETRIES) {
      await deps.sleep(wait);
      const retry = await sendMessageWithRecovery(tabId, request);
      if (!retry.ok) {
        return deps.createErrorResponse(retry.code, retry.message);
      }
      const retryLast = retry.response as { readonly found?: boolean } | undefined;
      if (retryLast?.found) {
        return { ok: true, type: 'DONE' };
      }
    }

    return deps.createErrorResponse(
      'VIDEO_ELEMENT_NOT_FOUND',
      '当前页面没有找到可控制的视频元素。可能不是视频页、视频被替换或还没加载完，请稍后再试或刷新页面。',
    );
  }

  return { fetchYouTubeTranscript, readPlaybackState, seekVideo };
}

/**
 * 生产版 bridge：内部组装 `chrome.tabs.sendMessage` / `chrome.scripting.executeScript`
 * / 真实 `setTimeout` sleep / `Date.now()` now。
 *
 * 与纯 `createContentScriptBridge(deps)` 的关系：
 * - 纯版：测试用，sendMessage / injectContentScript / sleep / now / createErrorResponse
 *   全由调用方注入，便于用 fake sleep / fake now 验证 backoff 序列。
 * - 生产版：service-worker 用，**不**再需要 `chrome.*` / 真实 sleep 注入。
 *
 * `sendMessage` 的同步 throw 错误码按 request 类型分流（QA1 必修 A2）：
 * - `FETCH_YOUTUBE_TRANSCRIPT` → `CONTENT_SCRIPT_UNAVAILABLE`（旧 `sendFetchYouTubeTranscript` 行为）
 * - 其它（READ_ACTIVE_VIDEO_PLAYBACK / SEEK_ACTIVE_VIDEO）→ `NETWORK_ERROR`（旧 `sendMessageOnce` 行为）
 * `chrome.runtime.lastError` 分类保持不变（接收端不存在 → C_S_U，其它 → NETWORK_ERROR）。
 */
export function createChromeContentScriptBridge(deps: {
  readonly createErrorResponse: CreateErrorResponseFn;
  readonly logWarn: LogWarnFn;
}): ContentScriptBridge {
  return createContentScriptBridge({
    sendMessage: (tabId, request) =>
      new Promise((resolve) => {
        try {
          chrome.tabs.sendMessage(tabId, request, (response) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              const message = runtimeError.message ?? '';
              if (
                /Receiving end does not exist|Could not establish connection/i.test(message)
              ) {
                resolve({ ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', message });
                return;
              }
              resolve({ ok: false, code: 'NETWORK_ERROR', message });
              return;
            }
            if (response === undefined) {
              resolve({
                ok: false,
                code: 'NETWORK_ERROR',
                message: 'content script 没有响应消息',
              });
              return;
            }
            resolve({ ok: true, response });
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code =
            request.type === 'FETCH_YOUTUBE_TRANSCRIPT'
              ? 'CONTENT_SCRIPT_UNAVAILABLE'
              : 'NETWORK_ERROR';
          resolve({ ok: false, code, message });
        }
      }),
    injectContentScript: (tabId) =>
      new Promise((resolve) => {
        try {
          chrome.scripting.executeScript(
            {
              target: { tabId },
              // vite.config.ts 输出 content.js（IIFE，与 manifest.content_scripts 兼容）
              files: ['content.js'],
            },
            () => {
              if (chrome.runtime.lastError) {
                deps.logWarn(
                  '[bAI] 主动注入 content.js 失败：',
                  chrome.runtime.lastError.message,
                );
                resolve(false);
                return;
              }
              resolve(true);
            },
          );
        } catch (error) {
          deps.logWarn('[bAI] 主动注入 content.js 失败：', error);
          resolve(false);
        }
      }),
    readYouTubePlayerCaptionTracks: (tabId, videoId) =>
      readYouTubePlayerCaptionTracksViaScripting(tabId, videoId, deps.logWarn),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    createErrorResponse: deps.createErrorResponse,
  });
}

function readYouTubePlayerCaptionTracksViaScripting(
  tabId: number,
  videoId: string,
  logWarn: LogWarnFn,
): Promise<readonly YouTubePageCaptionTrack[]> {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: 'MAIN',
          func: readYouTubePlayerCaptionTracksInMainWorld,
          args: [videoId],
        },
        (results) => {
          if (chrome.runtime.lastError) {
            logWarn(
              '[bAI] 读取 YouTube 播放器字幕轨失败：',
              chrome.runtime.lastError.message,
            );
            resolve([]);
            return;
          }

          resolve(normalizeExecutedCaptionTracks(results?.[0]?.result, videoId));
        },
      );
    } catch (error) {
      logWarn('[bAI] 读取 YouTube 播放器字幕轨失败：', error);
      resolve([]);
    }
  });
}

export async function readYouTubePlayerCaptionTracksInMainWorld(
  expectedVideoId: string,
): Promise<readonly YouTubePageCaptionTrack[]> {
  const readString = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  const readTrackName = (name: unknown): YouTubePageCaptionTrackName | null => {
    if (!name || typeof name !== 'object') {
      return null;
    }
    const record = name as Record<string, unknown>;
    if (Array.isArray(record.runs)) {
      return {
        runs: record.runs
          .map((run) => {
            const text =
              run && typeof run === 'object'
                ? readString((run as Record<string, unknown>).text)
                : null;
            return text ? { text } : null;
          })
          .filter((run): run is { readonly text: string } => run !== null),
      };
    }
    const simpleText = readString(record.simpleText);
    return simpleText ? { simpleText } : null;
  };

  const captionTrackMatchesVideoId = (baseUrl: string): boolean => {
    try {
      return new URL(baseUrl).searchParams.get('v') === expectedVideoId;
    } catch {
      return false;
    }
  };

  const normalizeTrack = (track: unknown): YouTubePageCaptionTrack | null => {
    if (!track || typeof track !== 'object') {
      return null;
    }
    const record = track as Record<string, unknown>;
    const baseUrl = readString(record.baseUrl);
    if (!baseUrl || !captionTrackMatchesVideoId(baseUrl)) {
      return null;
    }

    const kind = readString(record.kind);
    const normalized: YouTubePageCaptionTrack = {
      baseUrl,
      languageCode: readString(record.languageCode) ?? 'unknown',
      name: readTrackName(record.name),
      vssId: readString(record.vssId),
      ...(kind ? { kind } : {}),
    };
    return normalized;
  };

  const readTimedtextTracksFromPerformance = (
    baseTracks: readonly YouTubePageCaptionTrack[],
  ): readonly YouTubePageCaptionTrack[] => {
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const baseTrackByLanguage = new Map<string, YouTubePageCaptionTrack>();
      for (const track of baseTracks) {
        if (track.languageCode) {
          baseTrackByLanguage.set(track.languageCode, track);
        }
      }

      const seen = new Set<string>();
      const result: YouTubePageCaptionTrack[] = [];
      for (const urlText of entries.map((entry) => entry.name).reverse()) {
        if (!urlText.includes('/api/timedtext') || !urlText.includes('pot=')) {
          continue;
        }

        let url: URL;
        try {
          url = new URL(urlText);
        } catch {
          continue;
        }

        if (url.searchParams.get('v') !== expectedVideoId) {
          continue;
        }

        const languageCode = url.searchParams.get('lang') ?? 'unknown';
        const kind = url.searchParams.get('kind') === 'asr' ? 'asr' : 'official';
        const dedupeKey = `${languageCode}:${kind}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);

        const baseTrack = baseTrackByLanguage.get(languageCode);
        result.push({
          baseUrl: url.toString(),
          languageCode,
          kind,
          name: baseTrack?.name ?? null,
          vssId: baseTrack?.vssId ?? null,
        });
      }
      return result;
    } catch {
      return [];
    }
  };

  const shouldGeneratePoTokenTrack = (
    baseTracks: readonly YouTubePageCaptionTrack[],
  ): boolean =>
    baseTracks.some((track) => {
      try {
        const url = new URL(track.baseUrl);
        return url.searchParams.get('exp') === 'xpe' && !url.searchParams.has('pot');
      } catch {
        return false;
      }
    });

  const waitForTimedtextTrack = async (
    baseTracks: readonly YouTubePageCaptionTrack[],
  ): Promise<readonly YouTubePageCaptionTrack[]> => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const tracks = readTimedtextTracksFromPerformance(baseTracks);
      if (tracks.length > 0) {
        return tracks;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return [];
  };

  const triggerPlayerTimedtextFetch = async (
    player: Element & {
      readonly isSubtitlesOn?: () => boolean;
      readonly toggleSubtitles?: () => void;
      readonly toggleSubtitlesOn?: () => void;
    },
  ): Promise<void> => {
    const wasOn =
      typeof player.isSubtitlesOn === 'function' ? player.isSubtitlesOn() : null;

    if (typeof player.toggleSubtitlesOn === 'function') {
      player.toggleSubtitlesOn();
    } else if (wasOn === false && typeof player.toggleSubtitles === 'function') {
      player.toggleSubtitles();
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    if (
      wasOn === false &&
      typeof player.isSubtitlesOn === 'function' &&
      player.isSubtitlesOn() &&
      typeof player.toggleSubtitles === 'function'
    ) {
      player.toggleSubtitles();
    }
  };

  try {
    const player = document.querySelector('#movie_player') as
      | (Element & {
          readonly getPlayerResponse?: () => unknown;
          readonly getVideoData?: () => { readonly video_id?: unknown };
          readonly isSubtitlesOn?: () => boolean;
          readonly toggleSubtitles?: () => void;
          readonly toggleSubtitlesOn?: () => void;
        })
      | null;
    const watchFlexy = document.querySelector('ytd-watch-flexy') as
      | (Element & { readonly playerResponse?: unknown })
      | null;
    const windowWithYouTube = window as Window & {
      readonly ytInitialPlayerResponse?: unknown;
    };

    const playerResponse =
      (typeof player?.getPlayerResponse === 'function' ? player.getPlayerResponse() : null) ??
      watchFlexy?.playerResponse ??
      windowWithYouTube.ytInitialPlayerResponse ??
      null;
    if (!playerResponse || typeof playerResponse !== 'object') {
      return [];
    }

    const response = playerResponse as Record<string, unknown>;
    const videoDetails = response.videoDetails as Record<string, unknown> | undefined;
    const responseVideoId =
      readString(videoDetails?.videoId) ??
      (typeof player?.getVideoData === 'function'
        ? readString(player.getVideoData()?.video_id)
        : null);
    if (responseVideoId !== expectedVideoId) {
      return [];
    }

    const captions = response.captions as Record<string, unknown> | undefined;
    const captionList = captions?.playerCaptionsTracklistRenderer as
      | Record<string, unknown>
      | undefined;
    const tracks = captionList?.captionTracks;
    if (!Array.isArray(tracks)) {
      return [];
    }

    const normalizedTracks = tracks
      .map(normalizeTrack)
      .filter((track): track is YouTubePageCaptionTrack => track !== null);

    const timedtextTracks = readTimedtextTracksFromPerformance(normalizedTracks);
    if (timedtextTracks.length > 0) {
      return timedtextTracks;
    }

    if (player && shouldGeneratePoTokenTrack(normalizedTracks)) {
      await triggerPlayerTimedtextFetch(player);
      const generatedTracks = await waitForTimedtextTrack(normalizedTracks);
      if (generatedTracks.length > 0) {
        return generatedTracks;
      }
    }

    return normalizedTracks;
  } catch {
    return [];
  }
}

function normalizeExecutedCaptionTracks(
  rawTracks: unknown,
  expectedVideoId: string,
): readonly YouTubePageCaptionTrack[] {
  if (!Array.isArray(rawTracks)) {
    return [];
  }

  return rawTracks
    .map((track) => normalizeExecutedCaptionTrack(track, expectedVideoId))
    .filter((track): track is YouTubePageCaptionTrack => track !== null);
}

function normalizeExecutedCaptionTrack(
  track: unknown,
  expectedVideoId: string,
): YouTubePageCaptionTrack | null {
  if (!track || typeof track !== 'object') {
    return null;
  }
  const record = track as Record<string, unknown>;
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : null;
  if (!baseUrl) {
    return null;
  }

  try {
    if (new URL(baseUrl).searchParams.get('v') !== expectedVideoId) {
      return null;
    }
  } catch {
    return null;
  }

  const name: YouTubePageCaptionTrackName | null =
    record.name && typeof record.name === 'object'
      ? (record.name as YouTubePageCaptionTrackName)
      : null;

  const kind = typeof record.kind === 'string' ? record.kind : null;
  return {
    baseUrl,
    languageCode: typeof record.languageCode === 'string' ? record.languageCode : 'unknown',
    name,
    vssId: typeof record.vssId === 'string' ? record.vssId : null,
    ...(kind ? { kind } : {}),
  };
}
