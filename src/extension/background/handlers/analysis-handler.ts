/**
 * Analysis 领域消息 handler。
 *
 * 处理 `REQUEST_ANALYSIS` / `REQUEST_TIMELINE` / `GET_CACHED_ANALYSIS`。
 * 业务逻辑从 service-worker.ts 迁出；handler 不调用 chrome.*、不持有全局状态、
 * 不引入 default throw。
 *
 * 三个消息的共享流程（page 解析 → settings 读取 → API Key 校验 → 缓存命中 →
 * 字幕预取 → analyzeVideo → 保存并返回），在 `runAnalysisPipeline` 内通过
 * `kind: 'analysis' | 'timeline'` 参数分支处理**真实差异**：
 * - 默认 analysisMode 选择：公开版只接受 subtitle；旧 transcript / multimodal
 *   请求会被明确拒绝。
 * - 缓存 sourceMode：analysis 跟随 payload?.mode（没传时不含 sourceMode），
 *   timeline 永远含 sourceMode。
 * - 字幕预取：analysis / timeline 都只在公开版 subtitle 模式下执行。
 *
 * **不**为了去重把 timeline 强行套用 analysis 路径。
 *
 * `GET_CACHED_ANALYSIS` 独立 case，**不**走 runAnalysisPipeline（无 API Key /
 * 无 forceRefresh / 无视频上下文时的纯缓存读取）。
 *
 * 流式 `video-timeline-controller.ts` 继续独立存在；它复用相同的底层能力但
 * 不是消息路由 —— 本轮**不**合并 controller。
 */
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { PageContext } from '@shared/page-context';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import {
  createTextProviderMissingMessage,
  hasConfiguredTextProvider,
  type AnalysisMode,
  type LegacyAnalysisMode,
  type TextProviderSettings,
} from '@shared/settings';
import type { Result, VideoPlatform, VideoAnalysis } from '@core/types';
import type { AnalyzeVideoInput, AnalyzeVideoResult } from '@core/analysis/analyze-video';
import type { CachedAnalysisValue } from '@core/storage/analysis-cache';
import type { YouTubePrefetchOutcome } from '@extension/background/handlers/content-context-handler';
import { createSubtitlePreferenceKey } from '@core/subtitles/language-preference';
import { createNoSubtitleMessageForContext } from '../bilibili-subtitle-errors';

export type AnalysisRequest = Extract<
  ExtensionRequest,
  { type: 'REQUEST_ANALYSIS' | 'REQUEST_TIMELINE' | 'GET_CACHED_ANALYSIS' }
>;

/** runAnalysisPipeline 的 case 区分。 */
type AnalysisKind = 'analysis' | 'timeline';

export interface AnalysisHandlerDeps {
  /** REQUEST_ANALYSIS / REQUEST_TIMELINE 解析当前 active tab 的 (tabId, PageContext)。 */
  readonly resolveCurrentPage: () => Promise<{
    readonly tabId: number;
    readonly context: PageContext | null;
  } | null>;
  /** GET_CACHED_ANALYSIS 解析当前 active video context（已做平台 / videoId 过滤）。 */
  readonly getActiveVideoContext: () => Promise<{
    readonly platform: VideoPlatform;
    readonly videoId: string;
    readonly contentKey: string;
  } | null>;
  /** 读取文本 Provider 设置（含 API Key + 默认 analysisMode）。 */
  readonly readTextProviderSettings: () => Promise<TextProviderSettings>;
  /** 从 PageContext 派生 contentKey（缺 contentKey 时回退 `platform:videoId`）。 */
  readonly deriveContentKey: (context: PageContext) => string;
  /** 将 AnalysisMode 映射为缓存 sourceMode。 */
  readonly analysisModeToSourceMode: (
    mode: AnalysisMode,
  ) => VideoAnalysis['sourceMode'] | undefined;
  /** 读取 analysis cache。 */
  readonly getCachedAnalysis: (input: {
    readonly platform: VideoPlatform;
    readonly videoId: string;
    readonly contentKey: string;
    readonly sourceMode?: VideoAnalysis['sourceMode'];
    readonly outputLocale?: UiLocale;
    readonly subtitlePreferenceKey?: string;
  }) => Promise<CachedAnalysisValue | null>;
  /** YouTube 字幕预取（带 content script 注入 + 恢复链路）。 */
  readonly maybeFetchYouTubeTranscript: (input: {
    readonly context: PageContext;
    readonly tabId: number;
    readonly analysisMode: AnalysisMode;
    readonly subtitleLanguages?: readonly string[];
  }) => Promise<YouTubePrefetchOutcome>;
  /** 分析执行（analyzeVideo 核心）。 */
  readonly analyzeVideo: (input: AnalyzeVideoInput) => Promise<Result<AnalyzeVideoResult>>;
  /** 抓登录态 cookie（用于 B 站 fallback）。 */
  readonly cookieProvider: (platform: VideoPlatform) => Promise<string | null>;
  /** 保存 analysis cache。 */
  readonly saveCachedAnalysis: (value: CachedAnalysisValue) => Promise<void>;
  /** 扩展层读取浏览器字幕语言偏好。 */
  readonly getSubtitleLanguages?: () => Promise<readonly string[]>;
  readonly createErrorResponse: (code: string, message: string) => ExtensionResponse;
}

export type AnalysisHandler = (request: AnalysisRequest) => Promise<ExtensionResponse>;

export function createAnalysisHandler(deps: AnalysisHandlerDeps): AnalysisHandler {
  return async (request) => {
    switch (request.type) {
      case 'REQUEST_ANALYSIS':
        return runAnalysisPipeline('analysis', request.payload, deps);
      case 'REQUEST_TIMELINE':
        return runAnalysisPipeline('timeline', request.payload, deps);
      case 'GET_CACHED_ANALYSIS':
        return handleGetCachedAnalysis(request.payload, deps);
    }
  };
}

/**
 * REQUEST_ANALYSIS / REQUEST_TIMELINE 共享主流程。
 * kind 决定 cache key 的兼容行为。
 */
async function runAnalysisPipeline(
  kind: AnalysisKind,
  payload:
    | {
        readonly forceRefresh?: boolean;
        readonly analysisMode?: LegacyAnalysisMode;
        readonly outputLocale?: UiLocale;
      }
    | undefined,
  deps: AnalysisHandlerDeps,
): Promise<ExtensionResponse> {
  // 1. 解析当前 active tab 的 (tabId, PageContext)，**单次**查询避免跨查询竞态。
  const page = await deps.resolveCurrentPage();
  if (page === null) {
    return deps.createErrorResponse('NO_ACTIVE_TAB', '没有找到当前标签页');
  }
  const { tabId } = page;
  const { context } = page;
  if (context === null) {
    return deps.createErrorResponse('NO_PAGE_CONTEXT', '还没有检测到当前视频页面');
  }

  // 2. 读取文本 Provider 设置。
  const settings = await deps.readTextProviderSettings();
  const requestedAnalysisMode = payload?.analysisMode;
  if (requestedAnalysisMode !== undefined && requestedAnalysisMode !== 'subtitle') {
    return deps.createErrorResponse(
      'UNSUPPORTED_ANALYSIS_MODE',
      '公开版只支持快速字幕分析；本地转写和视频理解实验已从公开版移除。',
    );
  }
  // settings 选取：如果传了 mode 就用 payload 的，否则用 settings.analysisMode。
  // 这跟原 REQUEST_ANALYSIS / REQUEST_TIMELINE 的写法等价（REQUEST_TIMELINE 内部
  // 用了 `?? settings.analysisMode` 兜底；REQUEST_ANALYSIS 用 `? {...} : settings`）。
  const analysisSettings: TextProviderSettings = requestedAnalysisMode
    ? { ...settings, analysisMode: 'subtitle' }
    : settings;

  if (!hasConfiguredTextProvider(analysisSettings)) {
    return deps.createErrorResponse(
      'MINIMAX_API_KEY_MISSING',
      createTextProviderMissingMessage(analysisSettings),
    );
  }

  const forceRefresh = payload?.forceRefresh === true;
  const outputLocale = payload?.outputLocale ?? DEFAULT_UI_LOCALE;
  const subtitleLanguages = (await deps.getSubtitleLanguages?.()) ?? [];
  const subtitlePreferenceKey = createSubtitlePreferenceKey(subtitleLanguages);

  // 3. 缓存读取（contentKey + sourceMode 隔离）。
  if (
    !forceRefresh &&
    (context.platform === 'bilibili' || context.platform === 'youtube') &&
    context.videoId
  ) {
    // sourceMode 选取按 kind 分支：
    // - analysis：payload?.analysisMode 有值时取 map，否则 undefined（**不**回退 settings）
    // - timeline：永远取 effective mode（payload?. ?? settings.analysisMode）map
    const sourceMode =
      kind === 'analysis'
        ? requestedAnalysisMode
          ? deps.analysisModeToSourceMode('subtitle')
          : undefined
        : deps.analysisModeToSourceMode('subtitle');
    const contentKey = deps.deriveContentKey(context);
    const cacheQuery = sourceMode
      ? {
          platform: context.platform,
          videoId: context.videoId,
          contentKey,
          sourceMode,
          outputLocale,
          subtitlePreferenceKey,
        }
      : {
          platform: context.platform,
          videoId: context.videoId,
          contentKey,
          outputLocale,
          subtitlePreferenceKey,
        };
    const cached = await deps.getCachedAnalysis(cacheQuery);
    if (cached) {
      return { ok: true, type: 'ANALYSIS_RESULT', payload: cached };
    }
  }

  // 4. YouTube 字幕预取。
  const prefetchedYouTube: YouTubePrefetchOutcome = await deps.maybeFetchYouTubeTranscript({
    context,
    tabId,
    analysisMode: 'subtitle',
    subtitleLanguages,
  });
  if (prefetchedYouTube.kind === 'business_error') {
    return deps.createErrorResponse(prefetchedYouTube.error.code, prefetchedYouTube.error.message);
  }

  // 5. analyzeVideo + 保存 + 返回。
  const result = await deps.analyzeVideo({
    context,
    settings: analysisSettings,
    outputLocale,
    usageFeature: kind === 'analysis' ? 'analysis' : 'navigation',
    cookieProvider: deps.cookieProvider,
    subtitleLanguages,
    ...(prefetchedYouTube.kind === 'ok'
      ? {
          prefetchedTranscript: {
            ...prefetchedYouTube.transcript,
            timings: prefetchedYouTube.attempts,
          },
        }
      : {}),
  });
  if (!result.ok) {
    let message = result.error.message;
    if (result.error.code === 'NO_SUBTITLE') {
      let bilibiliCookieHeader: string | null | undefined;
      if (context.platform === 'bilibili') {
        try {
          bilibiliCookieHeader = await deps.cookieProvider('bilibili');
        } catch {
          bilibiliCookieHeader = undefined;
        }
      }
      message = createNoSubtitleMessageForContext({
        context,
        bilibiliCookieHeader,
        fallback: result.error.message,
      });
    }
    return deps.createErrorResponse(result.error.code, message);
  }
  const localizedValue: AnalyzeVideoResult = {
    ...result.value,
    analysis: { ...result.value.analysis, outputLocale },
  };
  const cachedValue: CachedAnalysisValue = {
    ...localizedValue,
    subtitlePreferenceKey,
  };
  await deps.saveCachedAnalysis(cachedValue);
  return { ok: true, type: 'ANALYSIS_RESULT', payload: localizedValue };
}

/** GET_CACHED_ANALYSIS：纯缓存读取，无 API Key / 无 forceRefresh / 无 video 上下文时返回 null。 */
async function handleGetCachedAnalysis(
  payload:
    | {
        readonly analysisMode?: LegacyAnalysisMode;
        readonly outputLocale?: UiLocale;
      }
    | undefined,
  deps: AnalysisHandlerDeps,
): Promise<ExtensionResponse> {
  const context = await deps.getActiveVideoContext();
  if (!context || !context.videoId) {
    return { ok: true, type: 'CACHED_ANALYSIS', payload: null };
  }
  const requestedAnalysisMode = payload?.analysisMode;
  if (requestedAnalysisMode !== undefined && requestedAnalysisMode !== 'subtitle') {
    return { ok: true, type: 'CACHED_ANALYSIS', payload: null };
  }
  const sourceMode = requestedAnalysisMode ? deps.analysisModeToSourceMode('subtitle') : undefined;
  const outputLocale = payload?.outputLocale ?? DEFAULT_UI_LOCALE;
  const subtitlePreferenceKey = createSubtitlePreferenceKey(
    (await deps.getSubtitleLanguages?.()) ?? [],
  );
  const cached = await deps.getCachedAnalysis(
    sourceMode
      ? {
          platform: context.platform,
          videoId: context.videoId,
          contentKey: context.contentKey,
          sourceMode,
          outputLocale,
          subtitlePreferenceKey,
        }
      : {
          platform: context.platform,
          videoId: context.videoId,
          contentKey: context.contentKey,
          outputLocale,
          subtitlePreferenceKey,
        },
  );
  return {
    ok: true,
    type: 'CACHED_ANALYSIS',
    // 原样透传缓存结果（null 是合法 payload）。
    payload: cached,
  };
}
