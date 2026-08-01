/**
 * 视频分析外部能力 service。
 *
 * 集中承载 service-worker 之前散落的 3 类视频分析能力：
 * - adapter metadata 读取（cookie 注入后 fetchMetadata）
 * - YouTube 字幕预取 + transport/business_error 分流
 * - 时间线用的轻量预取结果（去掉 controller 不需要的时间字段）
 *
 * **不**拆成 metadata-service / transcript-service 等多个小文件 —— 这些调用都
 * 同属"视频分析能力"，共享 cookie / log / 注入的同一组依赖。
 *
 * 设计原则：
 * - factory `createVideoAnalysisService(deps)`：所有 chrome.* 都经 deps 注入，
 *   handler / controller 测试可换 mock；service-worker 注入 chrome.* 包装。
 * - 不持有全局状态。
 * - 不引入通用 service framework / class hierarchy / 事件总线。
 * - YouTube 预取失败统一按 business_error 返回；当前不再自动 fallback 到旧
 *   YouTubeAdapter 字幕链路，避免真实问题被旧路径掩盖。
 *
 * `getCookieHeaderForPlatform` 的具体实现（B 站 → cookie-service / 其它 → null）
 * 移到了 `cookie-service.ts` —— 这是平台鉴权读取，与本模块的"分析能力"边界不同。
 * service-worker 注入 `cookieProvider` 时引用 cookie-service 的实现。
 */
import {
  findAdapter,
  type CookieProvider,
  type YouTubePrefetchedTranscript,
} from '@core/analysis/analyze-video';
import type { VideoMetadata } from '@core/types';
import type { PageContext } from '@shared/page-context';
import type { AnalysisMode } from '@shared/settings';
import type { YouTubeTranscriptResult } from '@shared/youtube-transcript';
import { normalizeSubtitleLanguages } from '@core/subtitles/language-preference';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * `maybeFetchYouTubeTranscript` 的结果 shape。
 *
 * 与 content-context-handler 之前暴露的类型一致；现在归到这里作为 video-analysis
 * service 公共契约。content-context-handler / analysis-handler / 测试都改读这里。
 */
export type YouTubePrefetchOutcome =
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

export interface MaybeFetchYouTubeTranscriptInput {
  readonly context: PageContext;
  readonly tabId: number;
  /** 最终生效的分析模式。公开版只支持 subtitle。 */
  readonly analysisMode: AnalysisMode;
  readonly subtitleLanguages?: readonly string[];
}

/** content-script bridge 抓字幕的返回 shape。 */
export type FetchYouTubeTranscriptFn = (
  tabId: number,
  options: { videoId: string; languages?: readonly string[] },
) => Promise<
  | {
      ok: true;
      result: YouTubeTranscriptResult;
      attempts: readonly { stage: string; durationMs: number }[];
    }
  | { ok: false; error: { code: string; message: string } }
>;

export interface VideoAnalysisServiceDeps {
  /** YouTube 字幕主路（content-script bridge 暴露）。 */
  readonly fetchYouTubeTranscript: FetchYouTubeTranscriptFn;
  /** 平台 cookie 头 provider（B 站 → 拼好的登录态；其它 → null）。 */
  readonly cookieProvider: CookieProvider;
  /** 日志（生产 → console.warn；测试 → vi.fn()）。 */
  readonly logWarn: (message: string, ...rest: unknown[]) => void;
  /** 扩展层读取浏览器字幕语言偏好；core/service 不直接依赖 chrome.*。 */
  readonly getSubtitleLanguages?: () => Promise<readonly string[]>;
}

export interface VideoAnalysisService {
  /** controller / content-context 用的"metadata 读取 + cookie 注入"。 */
  readonly fetchMetadataForContext: (context: PageContext) => Promise<VideoMetadata | null>;
  /** 纯函数：是否该预取 YouTube 字幕（platform + videoId + mode 三联检查）。 */
  readonly shouldPrefetchYouTubeTranscript: (input: {
    readonly context: PageContext;
    readonly analysisMode: AnalysisMode;
  }) => boolean;
  /** 完整预取：执行 bridge 调用 + 错误分类 + 转换。 */
  readonly maybeFetchYouTubeTranscript: (
    input: MaybeFetchYouTubeTranscriptInput,
  ) => Promise<YouTubePrefetchOutcome>;
  /** 时间线 controller 用的轻量预取（去掉 attempts 字段外的 timing 细节）。 */
  readonly maybeFetchYouTubeTranscriptLite: (
    input: MaybeFetchYouTubeTranscriptInput,
  ) => Promise<YouTubePrefetchOutcome>;
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createVideoAnalysisService(deps: VideoAnalysisServiceDeps): VideoAnalysisService {
  return {
    fetchMetadataForContext: (context) => fetchMetadataForContextImpl(context, deps),
    shouldPrefetchYouTubeTranscript,
    maybeFetchYouTubeTranscript: (input) => maybeFetchYouTubeTranscriptImpl(input, deps),
    maybeFetchYouTubeTranscriptLite: (input) => maybeFetchYouTubeTranscriptLiteImpl(input, deps),
  };
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/**
 * controller 用这个 helper 替代 `analyzeVideo` 整段（避免在 controller 内部
 * 拼大段 adapter 逻辑）。
 */
async function fetchMetadataForContextImpl(
  context: PageContext,
  deps: VideoAnalysisServiceDeps,
): Promise<VideoMetadata | null> {
  const adapter = findAdapter(context.url);
  if (!adapter) return null;
  const cookie = await deps.cookieProvider(adapter.platform);
  if (cookie && adapter.setCookieHeader) {
    adapter.setCookieHeader(cookie);
  }
  const result = await adapter.fetchMetadata(context.url);
  return result.ok ? result.value : null;
}

/**
 * 决定当前场景下**是否应该**先抓 YouTube 页面转录文本。
 *
 * 抽成纯函数方便单测。返回 true 的条件：
 * - 当前 platform === 'youtube'
 * - 当前有可识别的 videoId
 * - 最终生效的分析模式是快速字幕分析
 */
function shouldPrefetchYouTubeTranscript(input: {
  readonly context: PageContext;
  readonly analysisMode: AnalysisMode;
}): boolean {
  if (input.context.platform !== 'youtube') {
    return false;
  }
  if (!input.context.videoId) {
    return false;
  }
  if (input.analysisMode !== 'subtitle') {
    return false;
  }
  return true;
}

/**
 * YouTube 快速分析主路：先到 content script 读取当前页面的转录文本 DOM。
 *
 * 只在 `shouldPrefetchYouTubeTranscript()` 返回 true 时触发。
 *
 * 返回值分类：
 * - `ok`：抓到字幕，调用方应直接喂给 analyzeVideo
 * - `business_error`：主路未拿到字幕，直接给用户业务错误，不再回旧链路
 * - `skipped`：当前不是 YouTube 快速分析，不需要预取 —— 调用方直接让 analyzeVideo
 *   走 YouTubeAdapter 的正常路径（这是 B 站或不传分析模式时的默认）
 */
async function maybeFetchYouTubeTranscriptImpl(
  input: MaybeFetchYouTubeTranscriptInput,
  deps: VideoAnalysisServiceDeps,
): Promise<YouTubePrefetchOutcome> {
  if (!shouldPrefetchYouTubeTranscript(input)) {
    return { kind: 'skipped' };
  }

  const fetched = await deps.fetchYouTubeTranscript(input.tabId, {
    videoId: input.context.videoId!,
    languages: normalizeSubtitleLanguages(
      input.subtitleLanguages ?? (await deps.getSubtitleLanguages?.()) ?? undefined,
    ),
  });

  if (fetched.ok) {
    return {
      kind: 'ok',
      transcript: convertToPrefetchedTranscript(input.context, fetched.result),
      attempts: fetched.attempts,
    };
  }

  return {
    kind: 'business_error',
    error: { code: fetched.error.code, message: fetched.error.message },
  };
}

/**
 * 复用 `maybeFetchYouTubeTranscript`，但去掉 controller 不需要的时间字段
 * （attempts 给 timeline-request-context 的 lite shape 用）。
 *
 * 当前 `maybeFetchYouTubeTranscript` 的 ok 分支已经带 attempts 字段；lite
 * 实际只是对 error 分支做精确化（保留原 error shape，不引入额外转换）。为
 * 保持与原 service-worker 行为一致，lite 把 ok 的 transcript / attempts 也
 * 原样透传。
 */
async function maybeFetchYouTubeTranscriptLiteImpl(
  input: MaybeFetchYouTubeTranscriptInput,
  deps: VideoAnalysisServiceDeps,
): Promise<YouTubePrefetchOutcome> {
  const outcome = await maybeFetchYouTubeTranscriptImpl(input, deps);
  switch (outcome.kind) {
    case 'ok':
      return {
        kind: 'ok',
        transcript: outcome.transcript,
        attempts: outcome.attempts,
      };
    case 'business_error':
    case 'transport_error':
      return outcome;
    case 'skipped':
      return { kind: 'skipped' };
  }
}

function convertToPrefetchedTranscript(
  context: PageContext,
  transcript: YouTubeTranscriptResult,
): YouTubePrefetchedTranscript {
  const fallbackTitle = context.title?.trim() || transcript.metadata.title || 'YouTube 视频';
  const fallbackAuthor = transcript.metadata.author ?? '';
  const fallbackDuration = transcript.metadata.lengthSeconds ?? undefined;

  return {
    metadata: {
      platform: 'youtube',
      videoId: transcript.videoId,
      url: context.url,
      title: fallbackTitle,
      author: fallbackAuthor,
      ...(typeof fallbackDuration === 'number' ? { duration: fallbackDuration } : {}),
    },
    cues: transcript.cues,
    source: transcript.track?.source ?? 'official',
    ...(transcript.track?.language ? { language: transcript.track.language } : {}),
  };
}
