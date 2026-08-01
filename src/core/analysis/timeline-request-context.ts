import { BilibiliAdapter, YouTubeAdapter, type VideoAdapter } from '@core/adapters';
import { getPageContextContentKey } from '@shared/content-key';
import type { PageContext, SupportedPlatform } from '@shared/page-context';
import type { SubtitleCue, TranscriptSource, VideoMetadata, VideoPlatform } from '@core/types';
import type { YouTubePrefetchedTranscript } from './analyze-video';
import {
  getCachedContentContext,
  type ContentContextCacheValue,
} from '@core/storage/content-context-cache';
import {
  createSubtitlePreferenceKey,
  DEFAULT_SUBTITLE_LANGUAGES,
} from '@core/subtitles/language-preference';

/**
 * Round 24 必修 A2：时间线生成前的"上下文准备"抽成纯函数。
 *
 * 之前 `REQUEST_TIMELINE` (sendMessage 单次) 和新 `VideoTimelineController` (port 流式)
 * 两条路径都会走：
 *   1. 解析当前 tab context
 *   2. 读 settings
 *   3. 查缓存（命中 → 直接返回）
 *   4. 抓 YouTube 字幕主路（subtitles prefetch）
 *   5. 抓本地字幕（fallback）
 *
 * 抽成纯函数后：
 * - 旧 `REQUEST_TIMELINE` handler 调用它拿"已解析的 metadata + subtitles"
 * - 新 `VideoTimelineController` 调用它拿同样的数据 + 走 MinimaxClient.streamChat
 * - 业务规则只有一份（"subtitle 模式才抓字幕 / cache sourceMode 跟随 / contentKey 隔离"）
 */

export type YouTubePrefetchOutcomeLite =
  | {
      readonly kind: 'ok';
      readonly transcript: YouTubePrefetchedTranscript;
      readonly attempts: readonly { readonly stage: string; readonly durationMs: number }[];
    }
  | {
      readonly kind: 'business_error';
      readonly error: { readonly code: string; readonly message: string };
    }
  | {
      readonly kind: 'transport_error';
      readonly error: { readonly code: string; readonly message: string };
    }
  | { readonly kind: 'skipped' };

export interface ResolveTimelineContextInput {
  readonly context: PageContext;
  readonly analysisMode: 'subtitle';
  readonly prefetchedYouTube?: YouTubePrefetchOutcomeLite;
  readonly forceRefresh?: boolean;
}

export interface ResolvedTimelineContext {
  readonly metadata: VideoMetadata;
  readonly subtitles: readonly SubtitleCue[];
  /** prefetchedYouTube 是 'ok' 时才存在；其他情况都是空数组。 */
  readonly prefetchedTimings: readonly { readonly stage: string; readonly durationMs: number }[];
  /** 抓字幕阶段累计耗时（side panel 阶段反馈用） */
  readonly subtitleFetchMs: number;
}

export interface FetchedTimelineSubtitles {
  readonly subtitles: readonly SubtitleCue[];
  readonly durationMs: number;
  readonly transcriptSource: TranscriptSource;
  readonly language?: string;
}

/**
 * 从 prefetch outcome + 必要时调 adapter 抓字幕，统一返回"已就绪的字幕列表"。
 *
 * - prefetchedYouTube.kind === 'ok' → 直接用它（不重复抓）
 * - prefetchedYouTube.kind === 'business_error' / 'transport_error' → 返回空字幕，
 *   让调用方报错；当前不再回旧 YouTube 字幕链路
 * - prefetchedYouTube.kind === 'skipped' → 走平台 adapter 本地字幕路径
 *
 * Round 29A QA 必修 A：可选 `cookieProvider` 让 service-worker 把
 * chrome.cookies 拿到的 B 站登录态注入 adapter。**不**传时行为不变。
 *
 * 关键不变量（必修 A #3）：
 * - adapter 有 `setCookieHeader`：
 *   - 有 provider：先 `await provider(adapter.platform)`，**再** `setCookieHeader`
 *   - 没 provider 或 provider 返回 `null`：**也**要 `setCookieHeader(null)` 显式
 *     清除，避免模块级 adapter 复用导致上一次 Cookie 残留
 * - adapter 没 `setCookieHeader`（如 YouTubeAdapter）：**不**调，**不**抛错
 */
export async function fetchSubtitlesForTimeline(input: {
  readonly context: PageContext;
  readonly prefetchedYouTube: YouTubePrefetchOutcomeLite;
  readonly startedAt: number;
  /**
   * Round 29A QA 必修 A：注入 adapter Cookie 头的 provider。service-worker 传
   * `getCookieHeaderForPlatform`；core 单元测试不传（行为不变）。
   */
  readonly cookieProvider?: (platform: VideoPlatform) => Promise<string | null>;
  readonly subtitleLanguages?: readonly string[];
}): Promise<FetchedTimelineSubtitles> {
  if (input.prefetchedYouTube.kind === 'ok') {
    return {
      subtitles: input.prefetchedYouTube.transcript.cues,
      durationMs: Date.now() - input.startedAt,
      transcriptSource: input.prefetchedYouTube.transcript.source ?? 'official',
      ...(input.prefetchedYouTube.transcript.language
        ? { language: input.prefetchedYouTube.transcript.language }
        : {}),
    };
  }

  if (
    input.prefetchedYouTube.kind === 'business_error' ||
    input.prefetchedYouTube.kind === 'transport_error'
  ) {
    return {
      subtitles: [],
      durationMs: Date.now() - input.startedAt,
      transcriptSource: 'unknown',
    };
  }

  // skipped → 走本地 adapter 抓字幕
  const adapter = findAdapter(input.context.url);
  if (!adapter) {
    return {
      subtitles: [],
      durationMs: Date.now() - input.startedAt,
      transcriptSource: 'unknown',
    };
  }

  // 必修 A：注入 Cookie（仅当 adapter 支持 setCookieHeader）。
  // - 有 provider → 取出来注入
  // - 没 provider → 显式清空（避免模块级 adapter 复用残留）
  if (typeof adapter.setCookieHeader === 'function') {
    const header = input.cookieProvider ? await input.cookieProvider(adapter.platform) : null;
    adapter.setCookieHeader(header);
  }

  const tracks = await adapter.fetchSubtitleTracks(input.context.url, input.subtitleLanguages);
  if (!tracks.ok) {
    return {
      subtitles: [],
      durationMs: Date.now() - input.startedAt,
      transcriptSource: 'unknown',
    };
  }
  for (const track of tracks.value) {
    const cues = await adapter.fetchSubtitleCues(track);
    if (cues.ok && cues.value.length > 0) {
      return {
        subtitles: cues.value,
        durationMs: Date.now() - input.startedAt,
        transcriptSource: track.source,
        language: track.language,
      };
    }
  }
  return {
    subtitles: [],
    durationMs: Date.now() - input.startedAt,
    transcriptSource: 'unknown',
  };
}

const adapters: readonly VideoAdapter[] = [new BilibiliAdapter(), new YouTubeAdapter()];

function findAdapter(url: string): VideoAdapter | null {
  return adapters.find((adapter) => adapter.match(url)) ?? null;
}

/**
 * 解析当前 tab URL 到 metadata。和 `analyzeVideo.findAdapter` 等价但这里只读
 * metadata，不注入 cookie / 不抓字幕。controller 后续若需要 metadata 可以调
 * `adapter.fetchMetadata(context.url)`。
 *
 * 单独导出是因为 service-worker 的 `REQUEST_TIMELINE` 旧 handler 仍要用
 * `analyzeVideo` 整体跑（不流式），但要复用 metadata 解析逻辑。
 */
export function findAdapterForContext(context: PageContext): VideoAdapter | null {
  return findAdapter(context.url);
}

/**
 * 是否支持该 platform（用于 service-worker 旧 handler 判断是否走完整业务）。
 * 纯函数：bilibili / youtube 为 true，其它（含 unknown）false。
 *
 * 接受 `SupportedPlatform`（更宽，含 unknown）—— PageContext.platform 是
 * SupportedPlatform，比 VideoPlatform 宽。语义：先支持视频 + 已知平台才走。
 */
export function isSupportedTimelinePlatform(platform: SupportedPlatform): boolean {
  return platform === 'bilibili' || platform === 'youtube';
}

/**
 * 从 PageContext 派生 storage / cache 用的 contentKey。复用 Round 22 必修 A2
 * 的 `getPageContextContentKey` 单一来源。
 */
export function deriveContentKey(context: PageContext): string {
  return getPageContextContentKey(context) ?? `${context.platform}:${context.videoId}`;
}

/**
 * Round 29A 必修 E：时间线生成复用内容底座 helper。
 *
 * 行为：
 * - `forceRefresh === false`（默认）→ 先按 `(platform, contentKey)` 读
 *   `contentContext` 缓存。命中返回 `{ kind: 'hit', cached }`（含 metadata +
 *   transcriptCues），调用方应跳过 `prefetchYouTubeTranscript` 和
 *   `fetchSubtitlesForTimeline`，**不**重复抓字幕。
 * - 缓存未命中 / `forceRefresh === true` → 返回 `{ kind: 'miss' }`，调用方走
 *   旧路径（预取 + 抓字幕 + 准备并保存 contentContext）。
 *
 * 设计意图：让 `VideoTimelineController.handleRequest` 在不破坏 JSONL /
 * prompt / TimelineDisplay UI 的前提下，把"已有字幕则不抓"这条业务规则集中
 * 到一个独立纯函数里——便于单测、便于 followup controller（必修 D）复用。
 */
export type ResolveContentContextForTimelineInput = {
  readonly platform: 'bilibili' | 'youtube';
  readonly contentKey: string;
  readonly forceRefresh?: boolean;
  readonly subtitlePreferenceKey?: string;
};

export type ResolveContentContextForTimelineResult =
  | { readonly kind: 'hit'; readonly cached: ContentContextCacheValue }
  | { readonly kind: 'miss'; readonly reason: 'force_refresh' | 'cache_empty' };

export async function resolveContentContextForTimeline(
  input: ResolveContentContextForTimelineInput,
): Promise<ResolveContentContextForTimelineResult> {
  if (input.forceRefresh) {
    return { kind: 'miss', reason: 'force_refresh' };
  }
  const cached = await getCachedContentContext({
    platform: input.platform,
    contentKey: input.contentKey,
    subtitlePreferenceKey:
      input.subtitlePreferenceKey ?? createSubtitlePreferenceKey(DEFAULT_SUBTITLE_LANGUAGES),
  });
  if (!cached) {
    return { kind: 'miss', reason: 'cache_empty' };
  }
  return { kind: 'hit', cached };
}
