import { MinimaxApiError } from '@core/llm/minimax-client';
import {
  LanguageModelStreamUnsupportedError,
  type LanguageModelChatResult,
  type LanguageModelClient,
  type LanguageModelStreamChunk,
} from '@core/llm/language-model-client';
import { saveCachedAnalysis, getCachedAnalysis } from '@core/storage/analysis-cache';
import { readTextProviderSettings } from '@extension/settings/text-provider-settings';
import { parseVideoAnalysisJson } from '@core/analysis/video-analysis-schema';
import { alignAnalysisToPlatformChapters } from '@core/analysis/platform-chapter-alignment';
import { createModelAnalysisTimingLabel } from '@core/analysis/timing-labels';
import { buildVideoTimelineJsonlPrompt } from '@core/prompts/video-timeline-jsonl';
import {
  buildTimelineStreamDraft,
  canParseAsCompleteJson,
  createTimelineLineBuffer,
  draftToJsonlAnalysisContent,
  extractTimelineEventsFromLooseText,
  TimelineStreamEventParseError,
  type TimelineStreamEventBody,
} from '@core/analysis/timeline-stream-events';
import {
  deriveContentKey,
  fetchSubtitlesForTimeline,
  isSupportedTimelinePlatform,
  resolveContentContextForTimeline,
  type YouTubePrefetchOutcomeLite,
} from '@core/analysis/timeline-request-context';
import {
  saveContentContext,
  type ContentContextCacheValue,
} from '@core/storage/content-context-cache';
import { createNoSubtitleMessageForContext } from './bilibili-subtitle-errors';
import { createSubtitlePreferenceKey } from '@core/subtitles/language-preference';
import type { VideoTimelinePortMessage } from '@shared/messages';
import type { PageContext } from '@shared/page-context';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import {
  createTextProviderMissingMessage,
  getActiveTextModel,
  getActiveTextProviderId,
  getLanguageModelProviderPreset,
  hasConfiguredTextProvider,
  type TextProviderSettings,
} from '@shared/settings';
import type {
  AnalysisTiming,
  SubtitleCue,
  TimelineNode,
  TranscriptSource,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
  VideoPlatform,
} from '@core/types';

/**
 * Round 24 必修 A2：时间线流式 controller。
 *
 * Round 24 QA2 必修 B 升级：从"原始 JSON 文本流"改为"JSONL 事件流"——
 * - LLM 输出 JSON Lines（每行一个完整 JSON object）
 * - controller 行 buffer 解析 → 推 `VIDEO_TIMELINE_PARTIAL` 结构化事件
 * - side panel 渲染可读进度 + overview 草稿 + chapter 卡片
 * - 永远不展示原始 JSON（按 handoff §3 必修 A）
 *
 * Round 29A 必修 E：复用 `contentContext` 字幕。
 * - 步骤 3.5 读 `getCachedContentContext` → 命中就跳过 `prefetchYouTubeTranscript`
 *   和 `fetchSubtitlesForTimeline`（不再重复抓字幕）
 * - 命中时合成 `{ kind: 'ok', transcript: { metadata, cues } }` 复用给后续
 *   `fetchSubtitlesForTimeline` 短路 + 喂 LLM 的 metadata
 * - 未命中 / `forceRefresh=true` → 走旧路径抓字幕，LLM 成功后调
 *   `saveContentContext` 写入底座，让后续时间线 / 追问复用
 * - **不**改 time prompt / JSONL 事件协议 / TimelineDisplay UI
 *
 * 关键设计：
 * - 跟 `VideoFollowupController` 完全对称（单实例 inFlight + AbortController +
 *   requestId 隔离 + fallback to chat()）
 * - 公开版只对 subtitle 模式开启。
 * - 主动停止 / 刷新生成 / 组件卸载 → 调用方发 CANCEL_VIDEO_TIMELINE，
 *   abort 旧 inFlight，**不**推 done / error（让旧 chunk 自然过期）
 *
 * Fallback 策略（按 handoff §6 必修 D）：
 * - JSONL 流式成功（eventCount > 0）→ 草稿转 VideoAnalysis + 存缓存
 * - JSONL 流式失败（`TimelineStreamEventParseError`）→ 收集 `fullContent`
 *   尝试 `parseVideoAnalysisJson` 旧路径；成功就**静默**走 fallback（UI
 *   仍只显示 partial events，不再推原始 JSON 文本给 UI），失败推错误
 * - `LanguageModelStreamUnsupportedError` → fallback to `chat()`（不变）
 */

export interface VideoTimelineControllerDeps {
  /** 解析当前 tab 的 PageContext。返回 null 表示没有可分析的页面。 */
  resolveActiveVideoContext: () => Promise<PageContext | null>;
  /** 解析 metadata（cookie 注入 + adapter.fetchMetadata）。 */
  fetchMetadataForContext: (context: PageContext) => Promise<VideoMetadata | null>;
  /** 抓 YouTube 字幕主路（service-worker 注入了完整实现）。 */
  prefetchYouTubeTranscript: (input: {
    readonly context: PageContext;
    readonly analysisMode: 'subtitle';
    readonly subtitleLanguages?: readonly string[];
  }) => Promise<YouTubePrefetchOutcomeLite>;
  /** 扩展层读取浏览器字幕语言偏好。 */
  getSubtitleLanguages?: () => Promise<readonly string[]>;
  /**
   * Round 29A QA 必修 A #5：注入 adapter Cookie 头的 provider，让
   * `fetchSubtitlesForTimeline` 内部 fallback 路径能带登录态抓 B 站 AI 字幕。
   * service-worker 传 `getCookieHeaderForPlatform`；单元测试可传 `vi.fn()` 验证。
   * **不**传时行为不变（旧 caller 兼容）。
   */
  cookieProvider?: (platform: VideoPlatform) => Promise<string | null>;
  /** 构造当前文本 Provider client。 */
  createTextProviderClient: (settings: TextProviderSettings) => LanguageModelClient;
  /** Port message 派发。 */
  postMessage: (message: VideoTimelinePortMessage) => void;
  /** 时间戳；测试可注入。 */
  now?: () => number;
  /** streamChat() 抛 LanguageModelStreamUnsupportedError 时是否自动 fallback 到 chat()。默认 true。 */
  fallbackToNonStream?: boolean;
}

export interface VideoTimelineController {
  handleRequest(input: {
    readonly requestId: string;
    readonly analysisMode: 'subtitle';
    readonly forceRefresh?: boolean;
    readonly outputLocale?: UiLocale;
  }): Promise<void>;
  handleCancel(input: { readonly requestId: string }): void;
  handleDisconnect(): void;
}

interface InFlightRequest {
  abort: AbortController;
  requestId: string;
}

function createPhasePrefixes(locale: UiLocale): {
  readonly context: string;
  readonly settings: string;
  readonly cacheCheck: string;
  readonly cacheHit: string;
  readonly contentContextReuse: string;
  readonly subtitleFetch: string;
  readonly llmStream: string;
  readonly llmFallback: string;
} {
  if (locale === 'en-US') {
    return {
      context: 'Reading current page',
      settings: 'Loading settings',
      cacheCheck: 'Checking cache',
      cacheHit: 'Restored previous navigation',
      contentContextReuse: 'Reused prepared subtitles',
      subtitleFetch: 'Reading subtitles',
      llmStream: 'Generating navigation',
      llmFallback: 'Streaming output unavailable. Switched to normal generation',
    };
  }
  return {
    context: '正在读取当前页面',
    settings: '正在加载设置',
    cacheCheck: '正在查询缓存',
    cacheHit: '已恢复上次导航结果',
    contentContextReuse: '已复用内容底座字幕',
    subtitleFetch: '正在读取字幕',
    llmStream: '正在识别导航',
    llmFallback: '流式结果不可用，已切换为普通生成',
  };
}

const TIMELINE_COVERAGE_MIN_DURATION_SECONDS = 30 * 60;
const TIMELINE_COVERAGE_ALLOWED_GAP_SECONDS = 90;
const TIMELINE_COVERAGE_MIN_RATIO = 0.9;

export function createVideoTimelineController(
  deps: VideoTimelineControllerDeps,
): VideoTimelineController {
  const now = deps.now ?? Date.now;
  const fallbackToNonStream = deps.fallbackToNonStream ?? true;
  let inFlight: InFlightRequest | null = null;

  function abortInFlight(): void {
    if (!inFlight) return;
    inFlight.abort.abort();
    inFlight = null;
  }

  function isCurrentOrphanRequest(requestId: string): boolean {
    if (!inFlight) return false;
    return inFlight.requestId === requestId;
  }

  function postStatus(requestId: string, text: string): void {
    deps.postMessage({ type: 'VIDEO_TIMELINE_STATUS', requestId, text });
  }

  function postError(requestId: string, code: string, message: string): void {
    deps.postMessage({ type: 'VIDEO_TIMELINE_ERROR', requestId, code, message });
  }

  function postDone(requestId: string): void {
    deps.postMessage({ type: 'VIDEO_TIMELINE_DONE', requestId });
  }

  /**
   * Round 24 QA2 必修 B：推 JSONL partial 事件给 side panel。
   *
   * `rawLine` 是完整 JSONL 行（**不**含换行），传给 side panel
   * 用于"调试"折叠项（按 handoff §3 必修 A：默认 UI 不渲染）。
   *
   * `done` 事件也走这里（让 side panel 知道流结束），但实际上 `done` 行
   * 主要让 controller 自己 flush buffer；side panel 看到 `done` 后会
   * 准备调用 `GET_CACHED_ANALYSIS` 拿最终结构化结果。
   */
  function postPartial(
    requestId: string,
    event:
      | { readonly type: 'overview'; readonly text: string }
      | {
          readonly type: 'chapter';
          readonly id: string;
          readonly startCueId: number;
          readonly endCueId: number;
          readonly title: string;
          readonly summary: string;
        }
      | {
          readonly type: 'segment';
          readonly chapterId: string;
          readonly startCueId: number;
          readonly endCueId: number;
          readonly title: string;
          readonly summary: string;
        }
      | { readonly type: 'done' },
    rawLine: string,
  ): void {
    deps.postMessage({ type: 'VIDEO_TIMELINE_PARTIAL', requestId, event, rawLine });
  }

  async function handleRequest(input: {
    readonly requestId: string;
    readonly analysisMode: 'subtitle';
    readonly forceRefresh?: boolean;
    readonly outputLocale?: UiLocale;
  }): Promise<void> {
    // 单实例策略：新 requestId 进来时 abort 旧请求
    if (inFlight && inFlight.requestId !== input.requestId) {
      abortInFlight();
    }
    if (inFlight && inFlight.requestId === input.requestId) {
      return;
    }
    const abort = new AbortController();
    inFlight = { abort, requestId: input.requestId };

    // Round 24 必修 D 返修：用注入的 now()（不是 Date.now()）作为所有阶段
    // 起点。注入的时钟便于测试（按阶段推进时间）；之前用 Date.now() 会让
    // timings 不可单测、阶段值不准。
    const totalStartedAt = now();
    const timingsAccumulator: AnalysisTiming[] = [];

    // Round 24 QA2 必修 D：JSONL 解析失败后，**不**再让后续 chunk 进入 line buffer
    // 解析（避免重复抛错淹没日志），但 fullContent 仍累计以走旧路径 fallback。
    let jsonlParseFailed = false;
    const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
    const phasePrefixes = createPhasePrefixes(outputLocale);

    try {
      // 1. 解析当前 tab
      postStatus(input.requestId, phasePrefixes.context);
      const context = await deps.resolveActiveVideoContext();
      if (!context || !context.videoId) {
        postError(input.requestId, 'NO_ACTIVE_TAB', '当前没有可分析的视频页面。');
        return;
      }
      if (!isSupportedTimelinePlatform(context.platform)) {
        postError(input.requestId, 'UNSUPPORTED_PLATFORM', '当前页面平台暂不支持。');
        return;
      }

      // 2. 读 settings
      postStatus(input.requestId, phasePrefixes.settings);
      const settings = await readTextProviderSettings();

      const analysisSettings = { ...settings, analysisMode: input.analysisMode };
      const contentKey = deriveContentKey(context);
      const sourceMode = 'subtitle';
      // isSupportedTimelinePlatform 已守好此处 platform ∈ 'bilibili' | 'youtube'
      const supportedPlatform = context.platform as 'bilibili' | 'youtube';
      const subtitleLanguages = (await deps.getSubtitleLanguages?.()) ?? [];
      const subtitlePreferenceKey = createSubtitlePreferenceKey(subtitleLanguages);

      // 3. 查缓存（命中 → 直接 DONE，**不**走 LLM；按 handoff A2）
      if (!input.forceRefresh) {
        postStatus(input.requestId, phasePrefixes.cacheCheck);
        const cached = await getCachedAnalysis({
          platform: supportedPlatform,
          videoId: context.videoId,
          contentKey,
          sourceMode,
          outputLocale,
          subtitlePreferenceKey,
        });
        if (cached) {
          postStatus(input.requestId, phasePrefixes.cacheHit);
          postDone(input.requestId);
          return;
        }
      }

      if (!hasConfiguredTextProvider(analysisSettings)) {
        postError(
          input.requestId,
          'MINIMAX_API_KEY_MISSING',
          `${createTextProviderMissingMessage(analysisSettings)}。`,
        );
        return;
      }

      // 3.5 Round 29A 必修 E：时间线生成复用内容底座字幕。
      // 命中 contentContext → 直接用 cached cues + metadata，**不**走
      //   prefetchYouTubeTranscript / fetchSubtitlesForTimeline（避免重复抓字幕）。
      // 未命中 / forceRefresh → 走旧路径抓字幕，并在 LLM 成功后 saveContentContext
      //   写入底座，让后续时间线 / 追问能复用。
      let contentContext: ContentContextCacheValue | null = null;
      const contentContextLookup = await resolveContentContextForTimeline({
        platform: supportedPlatform,
        contentKey,
        subtitlePreferenceKey,
        ...(input.forceRefresh === true ? { forceRefresh: true } : {}),
      });
      if (contentContextLookup.kind === 'hit') {
        contentContext = contentContextLookup.cached;
        postStatus(input.requestId, phasePrefixes.contentContextReuse);
      }

      // 4. 抓 YouTube 字幕（仅 subtitle 模式）—— 命中 contentContext 时跳过。
      let prefetchedYouTube: YouTubePrefetchOutcomeLite;
      if (contentContext) {
        // 复用底座时**不**再调 YouTube prefetch；构造一个 `kind: 'ok'` 的合成
        // outcome，让 `fetchSubtitlesForTimeline` 短路，并把 metadata 喂给后续
        // LLM prompt（避免再调 fetchMetadataForContext）。
        prefetchedYouTube = {
          kind: 'ok',
          transcript: {
            metadata: contentContext.metadata,
            cues: contentContext.transcriptCues,
          },
          attempts: [],
        };
      } else {
        prefetchedYouTube = await deps.prefetchYouTubeTranscript({
          context,
          analysisMode: 'subtitle',
          subtitleLanguages,
        });

        if (prefetchedYouTube.kind === 'business_error') {
          postError(input.requestId, prefetchedYouTube.error.code, prefetchedYouTube.error.message);
          return;
        }
      }

      // 5. 抓字幕（含本地 adapter fallback）—— 命中 contentContext 时**跳过**
      // fetchSubtitlesForTimeline，直接用 cached cues（**不**重复抓字幕，
      // 不调任何 adapter / network）。这是必修 E 的核心验收。
      let subtitles: readonly SubtitleCue[];
      let fetchedDurationMs: number;
      let transcriptSource: TranscriptSource;
      let transcriptLanguage: string | undefined;
      if (contentContext) {
        subtitles = contentContext.transcriptCues;
        // 命中时复用底座是"几乎 0 成本"，不写成伪 100ms，让 timings 真实反映。
        fetchedDurationMs = 0;
        transcriptSource = contentContext.transcriptSource;
        transcriptLanguage = contentContext.language;
      } else {
        postStatus(input.requestId, phasePrefixes.subtitleFetch);
        const subtitleStartedAt = now();
        const fetched = await fetchSubtitlesForTimeline({
          context,
          prefetchedYouTube,
          startedAt: subtitleStartedAt,
          // Round 29A QA 必修 A #5：把 service-worker 注入的 cookieProvider 透传
          // 给 `fetchSubtitlesForTimeline`，让 B 站 fallback 路径带登录态抓字幕。
          ...(deps.cookieProvider ? { cookieProvider: deps.cookieProvider } : {}),
          subtitleLanguages,
        });
        subtitles = fetched.subtitles;
        fetchedDurationMs = fetched.durationMs;
        transcriptSource = fetched.transcriptSource;
        transcriptLanguage = fetched.language;
      }
      if (subtitles.length === 0) {
        let bilibiliCookieHeader: string | null | undefined;
        if (context.platform === 'bilibili' && deps.cookieProvider) {
          try {
            bilibiliCookieHeader = await deps.cookieProvider('bilibili');
          } catch {
            bilibiliCookieHeader = undefined;
          }
        }
        postError(
          input.requestId,
          'NO_SUBTITLE',
          createNoSubtitleMessageForContext({
            context,
            bilibiliCookieHeader,
            fallback: '当前视频没有可用字幕。稳定导航需要字幕。',
          }),
        );
        return;
      }
      const totalSubtitleTextLength = subtitles.reduce(
        (total, cue) => total + cue.text.trim().length,
        0,
      );
      if (subtitles.length < 8 || totalSubtitleTextLength < 120) {
        postError(
          input.requestId,
          'NO_SUBTITLE',
          `当前字幕内容不足或不可信（${subtitles.length} 条，${totalSubtitleTextLength} 字）。稳定导航需要足够字幕。`,
        );
        return;
      }

      // Round 24 必修 D 返修：fetchedDurationMs 已是真实字幕阶段耗时（未命中
      // 路径下 `fetchSubtitlesForTimeline` 内部用 `Date.now() - input.startedAt`
      // 算的；命中底座路径下为 0ms，因为没调 fetchSubtitlesForTimeline）。
      // 把 YouTube prefetch attempts 也累计到 timings 数组（用
      // 「字幕预取 · 阶段」前缀让用户能区分主路 vs fallback）。命中底座时
      // prefetchedYouTube.attempts 是空数组，等于"没有 prefetch 阶段"。
      const prefetchedYouTubeAttempts =
        prefetchedYouTube.kind === 'ok' ? prefetchedYouTube.attempts : [];
      const prefetchedTimings: readonly AnalysisTiming[] = prefetchedYouTubeAttempts.map(
        (attempt) => ({
          label: `字幕预取 · ${attempt.stage}`,
          durationMs: attempt.durationMs,
        }),
      );
      timingsAccumulator.push(...prefetchedTimings, {
        label: contentContext ? '复用内容底座字幕' : '读取字幕',
        durationMs: fetchedDurationMs,
      });

      // 6. 解析 metadata
      let metadata: VideoMetadata | null = null;
      if (prefetchedYouTube.kind === 'ok') {
        metadata = prefetchedYouTube.transcript.metadata;
      } else {
        metadata = await deps.fetchMetadataForContext(context);
      }
      if (!metadata) {
        postError(input.requestId, 'INVALID_URL', '当前页面不是已支持的视频平台');
        return;
      }
      metadata = await ensurePlatformChapterMetadata({
        metadata,
        context,
        fetchMetadataForContext: deps.fetchMetadataForContext,
      });

      // 7. 流式调 LLM
      postStatus(input.requestId, phasePrefixes.llmStream);
      const timelineSettings = disableThinkingForTimeline(analysisSettings);
      const client = deps.createTextProviderClient(timelineSettings);
      const activeModel = getActiveTextModel(timelineSettings);
      const activeProviderId = getActiveTextProviderId(timelineSettings);
      const activeProviderName = getLanguageModelProviderPreset(activeProviderId).name;
      const allowReasoningFallback = activeProviderId === 'minimax';
      // Round 24 QA2 必修 B：用 JSONL prompt。JSONL 协议让 controller
      // 行 buffer 解析后推结构化 partial 事件，导航保持真实流式输出。
      const userPrompt = buildVideoTimelineJsonlPrompt({
        metadata,
        subtitles,
        outputLocale,
      });

      let usedFallback = false;
      // Round 24 QA2 必修 B：JSONL 流式 + 完整内容双轨记录。
      // - `lineBuffer` 累计切行 + 解析 JSONL 事件
      // - `fullContent` 仍是 LLM 流原始文本，仅用于：
      //   (a) `parseVideoAnalysisJson` 旧路径 fallback
      //   (b) 调试折叠项
      const lineBuffer = createTimelineLineBuffer();
      const jsonlEvents: TimelineStreamEventBody[] = [];
      let fullContent = '';
      let reasoningContent = '';
      let fallbackChatContent = '';
      // Round 24 必修 D 返修：LLM 阶段从 llmStartedAt 起算（之前从
      // subtitleStartedAt 起算，会把字幕耗时重复算进 LLM 耗时）。
      const llmStartedAt = now();
      try {
        for await (const chunk of streamTimelineWithAbort(
          client,
          userPrompt,
          abort.signal,
          activeModel,
        )) {
          if (!isCurrentOrphanRequest(input.requestId)) break;
          // reasoning 不计入 fullContent，也不走 partial events 路径。
          // fullContent 只允许保存模型最终输出正文；否则 thinking 里的自然语言
          // 或花括号会污染完整 JSON fallback，导致合法字幕也报解析失败。
          if (chunk.reasoning) {
            reasoningContent += chunk.reasoning;
            if (!chunk.text) continue;
          }
          if (!chunk.text) continue;
          fullContent += chunk.text;
          // 把 chunk 推给 line buffer；line buffer 切到完整行时解析并推 partial event。
          // 一旦 JSONL 行解析失败，本轮流式输出整体改走完整内容 fallback，避免
          // 后续合法行被当成“部分成功”而掩盖前面丢失的内容。
          let newEvents: readonly TimelineStreamEventBody[] = [];
          if (!jsonlParseFailed) {
            try {
              newEvents = lineBuffer.pushChunk(chunk.text);
            } catch (parseError) {
              if (parseError instanceof TimelineStreamEventParseError) {
                if (import.meta.env.DEV) {
                  console.warn(
                    '[bAI] timeline JSONL 解析失败，将尝试完整内容 fallback：',
                    parseError.message,
                  );
                }
                jsonlParseFailed = true;
                continue;
              } else {
                throw parseError;
              }
            }
          }
          for (const event of newEvents) {
            jsonlEvents.push(event);
            // 推 raw line 给 side panel（调试折叠项用，不在默认 UI 渲染）
            // rawLine = event 拼成 JSON 单行字符串
            const rawLine = JSON.stringify(event);
            postPartial(input.requestId, event, rawLine);
          }
        }
      } catch (streamError) {
        if (abort.signal.aborted) return;
        if (
          streamError instanceof LanguageModelStreamUnsupportedError &&
          fallbackToNonStream &&
          isCurrentOrphanRequest(input.requestId)
        ) {
          if (import.meta.env.DEV) {
            console.warn(
              '[bAI] timeline streamChat unsupported, fallback to chat():',
              streamError.message,
            );
          }
          usedFallback = true;
          postStatus(input.requestId, phasePrefixes.llmFallback);
          const fallbackResult = await runFallbackChat(
            client,
            userPrompt,
            abort.signal,
            activeModel,
          );
          if (!isCurrentOrphanRequest(input.requestId)) return;
          const fallbackSelection = selectTimelineChatResultContent(
            fallbackResult,
            allowReasoningFallback,
          );
          const fallbackText = fallbackSelection.content;
          if (fallbackSelection.reasoning) {
            reasoningContent += fallbackSelection.reasoning;
          }
          if (fallbackText && fallbackText.length > 0) {
            fullContent += fallbackText;
            // fallback 文本也走 line buffer 解析（如果还能解析），
            // 但 JSONL 解析失败时已 jsonlParseFailed=true，跳过。
            if (!jsonlParseFailed) {
              try {
                const newEvents = lineBuffer.pushChunk(fallbackText);
                for (const event of newEvents) {
                  jsonlEvents.push(event);
                  postPartial(input.requestId, event, JSON.stringify(event));
                }
              } catch (parseError) {
                if (parseError instanceof TimelineStreamEventParseError) {
                  if (import.meta.env.DEV) {
                    console.warn('[bAI] timeline JSONL fallback 解析也失败：', parseError.message);
                  }
                  jsonlParseFailed = true;
                } else {
                  throw parseError;
                }
              }
            }
          }
        } else {
          throw streamError;
        }
      }

      if (!isCurrentOrphanRequest(input.requestId)) return;
      const llmMs = now() - llmStartedAt;
      timingsAccumulator.push({
        label: createModelAnalysisTimingLabel(activeModel),
        durationMs: llmMs,
      });

      // 8. 解析分析结果
      // Round 24 QA2 必修 B + 必修 D：
      // - JSONL 流式成功（jsonlEvents.length > 0）→ 草稿转 VideoAnalysis
      // - JSONL 流式失败（jsonlParseFailed = true 或 eventCount === 0） →
      //   用 `parseVideoAnalysisJson` 旧路径解析 `fullContent`；旧路径
      //   失败推 `TIMELINE_PARSE_FAILED` 错误（不再 fallback 推原始 JSON）
      const parseStartedAt = now();
      let analysis: VideoAnalysis;
      let analysisParseMode: AnalysisParseMode = 'jsonl';
      if (!jsonlParseFailed && jsonlEvents.length > 0) {
        // JSONL 路径：草稿转视频分析输入字符串 → 复用 parseVideoAnalysisJson
        //   （含 mapCueIdsToTimestamps + normalizeChapterTimelineStructure）
        const draft = buildTimelineStreamDraft(jsonlEvents);
        const draftContent = draftToJsonlAnalysisContent(draft);
        analysis = parseVideoAnalysisJson({
          content: draftContent,
          modelUsed: activeModel,
          sourceMode: 'subtitle',
          subtitles,
        });
      } else {
        let fallback = parseTimelineFallbackCandidate({
          content: fullContent,
          modelUsed: activeModel,
          subtitles,
          source: 'content',
        });
        if (!fallback && allowReasoningFallback) {
          fallback = parseTimelineFallbackCandidate({
            content: reasoningContent,
            modelUsed: activeModel,
            subtitles,
            source: 'reasoning',
          });
        }
        if (
          !fallback &&
          // 非 MiniMax 的 reasoning-only 流通常说明模型没有产出最终 JSONL；
          // 立即非流式重试容易再耗一轮长请求，且仍只得到 reasoning。
          (allowReasoningFallback ||
            fullContent.trim().length > 0 ||
            reasoningContent.trim().length === 0) &&
          !usedFallback &&
          fallbackToNonStream &&
          isCurrentOrphanRequest(input.requestId)
        ) {
          // 有些 MiniMax SSE 响应 content/reasoning 字段形态会漂移，导致
          // 流式层拿不到可解析正文。此时不要直接失败，退回到非流式 chat()
          // 再拿一次完整响应；chat() 对 reasoning_content 已有合并兜底。
          usedFallback = true;
          postStatus(input.requestId, phasePrefixes.llmFallback);
          const retryStartedAt = now();
          const fallbackResult = await runFallbackChat(
            client,
            userPrompt,
            abort.signal,
            activeModel,
          );
          if (!isCurrentOrphanRequest(input.requestId)) return;
          const fallbackSelection = selectTimelineChatResultContent(
            fallbackResult,
            allowReasoningFallback,
          );
          fallbackChatContent = fallbackSelection.content;
          if (fallbackSelection.reasoning) {
            reasoningContent += fallbackSelection.reasoning;
          }
          timingsAccumulator.push({
            label: `${createModelAnalysisTimingLabel(activeModel)} · 非流式重试`,
            durationMs: now() - retryStartedAt,
          });
          fallback = parseTimelineFallbackCandidate({
            content: fallbackChatContent,
            modelUsed: activeModel,
            subtitles,
            source: 'content',
          });
        }
        if (fallback) {
          analysis = fallback.analysis;
          analysisParseMode = fallback.mode;
          if (import.meta.env.DEV) {
            console.warn(`[bAI] timeline 走 ${analysisParseMode} fallback`);
          }
        } else {
          postError(
            input.requestId,
            'TIMELINE_PARSE_FAILED',
            createTimelineParseFailureMessage({
              fullContent: fallbackChatContent || fullContent,
              reasoningContent,
              providerName: activeProviderName,
            }),
          );
          return;
        }
      }
      let constrained = { ...alignAndConstrainAnalysis(analysis, metadata), outputLocale };
      let coverageProblem = getTimelineCoverageProblem({
        analysis: constrained,
        metadata,
        subtitles,
      });
      if (
        coverageProblem &&
        !usedFallback &&
        fallbackToNonStream &&
        isCurrentOrphanRequest(input.requestId)
      ) {
        usedFallback = true;
        postStatus(input.requestId, phasePrefixes.llmFallback);
        const retryStartedAt = now();
        const fallbackResult = await runFallbackChat(client, userPrompt, abort.signal, activeModel);
        if (!isCurrentOrphanRequest(input.requestId)) return;
        const fallbackSelection = selectTimelineChatResultContent(
          fallbackResult,
          allowReasoningFallback,
        );
        fallbackChatContent = fallbackSelection.content;
        if (fallbackSelection.reasoning) {
          reasoningContent += fallbackSelection.reasoning;
        }
        timingsAccumulator.push({
          label: `${createModelAnalysisTimingLabel(activeModel)} · 覆盖不完整后非流式重试`,
          durationMs: now() - retryStartedAt,
        });
        const fallback = parseTimelineFallbackCandidate({
          content: fallbackChatContent,
          modelUsed: activeModel,
          subtitles,
          source: 'content',
        });
        if (fallback) {
          analysis = fallback.analysis;
          analysisParseMode = fallback.mode;
          constrained = { ...alignAndConstrainAnalysis(analysis, metadata), outputLocale };
          coverageProblem = getTimelineCoverageProblem({
            analysis: constrained,
            metadata,
            subtitles,
          });
          if (import.meta.env.DEV) {
            console.warn(`[bAI] timeline 覆盖不完整，走 ${analysisParseMode} fallback`);
          }
        }
      }
      if (coverageProblem) {
        postError(
          input.requestId,
          'TIMELINE_INCOMPLETE',
          createTimelineCoverageFailureMessage(coverageProblem),
        );
        return;
      }
      const parseMs = now() - parseStartedAt;
      timingsAccumulator.push({
        label: createAnalysisParseTimingLabel(analysisParseMode),
        durationMs: parseMs,
      });

      // 推 done partial 事件，让 side panel 知道流结束（即使没收到 done 行）
      postPartial(input.requestId, { type: 'done' }, '{"type":"done"}');

      // 9. 存缓存
      // Round 24 必修 D 返修：timings 包含「总耗时」（之前没写，导致
      // `getTotalTiming(timings)` 永远返回 0ms，UI 摘要显示 0ms）。
      const totalMs = now() - totalStartedAt;
      timingsAccumulator.push({ label: '总耗时', durationMs: totalMs });

      await saveCachedAnalysis({
        metadata,
        analysis: constrained,
        subtitleCueCount: subtitles.length,
        transcriptCues: subtitles,
        subtitlePreferenceKey,
        timings: timingsAccumulator,
      });

      // Round 29A 必修 E：未命中 contentContext 走完时间线后写一份到底座，
      // 让后续时间线 / 追问复用。命中时 contentContext 已有，跳过避免覆盖
      // updatedAt 噪声。
      if (!contentContext) {
        await saveContentContext(
          {
            metadata,
            transcriptCues: subtitles,
            transcriptSource,
            subtitlePreferenceKey,
            ...(transcriptLanguage ? { language: transcriptLanguage } : {}),
          },
          { contentKey },
        );
      }

      // 10. DONE
      postDone(input.requestId);
      if (import.meta.env.DEV) {
        console.debug(
          `[video-timeline] requestId=${input.requestId} 耗时 ${totalMs}ms` +
            (usedFallback ? ' (fallback chat)' : ' (stream)') +
            ` (${analysisParseMode})`,
        );
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      if (!isCurrentOrphanRequest(input.requestId)) return;
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof MinimaxApiError
          ? `MINIMAX_HTTP_${error.status ?? 'ERROR'}`
          : 'TIMELINE_FAILED';
      postError(input.requestId, code, message);
    } finally {
      if (inFlight && inFlight.requestId === input.requestId) {
        inFlight = null;
      }
    }
  }

  function handleCancel(input: { readonly requestId: string }): void {
    if (inFlight && inFlight.requestId === input.requestId) {
      abortInFlight();
    }
  }

  function handleDisconnect(): void {
    abortInFlight();
  }

  return {
    handleRequest,
    handleCancel,
    handleDisconnect,
  };
}

/**
 * 包装 LanguageModelClient.streamChat + 注入 abort signal + 模型覆盖。
 * 与 followup 的 `streamWithAbort` 同模式；用 explicit 名字区分用途。
 */
async function* streamTimelineWithAbort(
  client: LanguageModelClient,
  userPrompt: string,
  signal: AbortSignal,
  model: string,
): AsyncGenerator<LanguageModelStreamChunk, void, void> {
  if (signal.aborted) {
    throw new MinimaxApiError('导航请求已取消', null, '');
  }
  const iterator = client.streamChat([{ role: 'user', content: userPrompt }], {
    signal,
    model,
    usageFeature: 'navigation',
  });
  for await (const chunk of iterator) {
    if (signal.aborted) return;
    yield chunk;
  }
}

async function runFallbackChat(
  client: LanguageModelClient,
  userPrompt: string,
  signal: AbortSignal,
  model: string,
  options: { readonly maxTokens?: number } = {},
): Promise<LanguageModelChatResult> {
  return client.chat([{ role: 'user', content: userPrompt }], {
    model,
    signal,
    usageFeature: 'navigation',
    ...options,
  });
}

type AnalysisParseMode =
  | 'jsonl'
  | 'complete-json'
  | 'loose-jsonl'
  | 'reasoning-complete-json'
  | 'reasoning-loose-jsonl';

function parseTimelineFallbackCandidate(input: {
  readonly content: string;
  readonly modelUsed: string;
  readonly subtitles: readonly SubtitleCue[];
  readonly source: 'content' | 'reasoning';
}): { readonly analysis: VideoAnalysis; readonly mode: AnalysisParseMode } | null {
  if (!input.content.trim()) {
    return null;
  }

  if (
    canParseAsCompleteJson(input.content, parseVideoAnalysisJson, input.modelUsed, input.subtitles)
  ) {
    return {
      analysis: parseVideoAnalysisJson({
        content: input.content,
        modelUsed: input.modelUsed,
        sourceMode: 'subtitle',
        subtitles: input.subtitles,
      }),
      mode: input.source === 'reasoning' ? 'reasoning-complete-json' : 'complete-json',
    };
  }

  const looseEvents = extractTimelineEventsFromLooseText(input.content);
  if (!hasTimelineChapterEvents(looseEvents)) {
    return null;
  }
  const draft = buildTimelineStreamDraft(looseEvents);
  const draftContent = draftToJsonlAnalysisContent(draft);
  return {
    analysis: parseVideoAnalysisJson({
      content: draftContent,
      modelUsed: input.modelUsed,
      sourceMode: 'subtitle',
      subtitles: input.subtitles,
    }),
    mode: input.source === 'reasoning' ? 'reasoning-loose-jsonl' : 'loose-jsonl',
  };
}

function createAnalysisParseTimingLabel(mode: AnalysisParseMode): string {
  switch (mode) {
    case 'complete-json':
      return '解析完整 JSON';
    case 'loose-jsonl':
      return '解析松散 JSONL';
    case 'reasoning-complete-json':
      return '解析 reasoning 完整 JSON';
    case 'reasoning-loose-jsonl':
      return '解析 reasoning 松散 JSONL';
    case 'jsonl':
      return '解析 JSONL 事件';
  }
}

function selectTimelineChatResultContent(
  result: LanguageModelChatResult,
  allowReasoningFallback: boolean,
): { readonly content: string; readonly reasoning: string } {
  const raw = readAssistantMessageFromRawResponse(result.rawResponse);
  if (!raw) {
    return { content: result.content, reasoning: '' };
  }
  if (raw.content.trim().length > 0) {
    return { content: raw.content, reasoning: raw.reasoning };
  }
  if (raw.reasoning.trim().length > 0) {
    return {
      content: allowReasoningFallback ? raw.reasoning : '',
      reasoning: raw.reasoning,
    };
  }
  return { content: result.content, reasoning: '' };
}

function readAssistantMessageFromRawResponse(
  rawResponse: unknown,
): { readonly content: string; readonly reasoning: string } | null {
  if (!isRecord(rawResponse)) {
    return null;
  }
  const choices = rawResponse.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) && isRecord(first.message) ? first.message : null;
  if (!message) {
    return null;
  }
  return {
    content: readMessageContent(message),
    reasoning: readStringField(message, REASONING_FIELD_KEYS) ?? '',
  };
}

const REASONING_FIELD_KEYS = [
  'reasoning_content',
  'reasoning',
  'thinking',
  'thought',
  'thoughts',
] as const;

function readMessageContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === 'string'
          ? part.text
          : isRecord(part) && typeof part.content === 'string'
            ? part.content
            : '',
      )
      .join('');
  }
  return '';
}

function readStringField(
  target: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = target[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasTimelineChapterEvents(events: readonly TimelineStreamEventBody[]): boolean {
  return events.some((event) => event.type === 'chapter');
}

function disableThinkingForTimeline(settings: TextProviderSettings): TextProviderSettings {
  if (settings.thinkingMode === 'disabled') {
    return settings;
  }
  return { ...settings, thinkingMode: 'disabled' };
}

interface TimelineCoverageProblem {
  readonly timelineEnd: number;
  readonly expectedEnd: number;
  readonly gap: number;
}

function getTimelineCoverageProblem(input: {
  readonly analysis: VideoAnalysis;
  readonly metadata: VideoMetadata;
  readonly subtitles: readonly SubtitleCue[];
}): TimelineCoverageProblem | null {
  const subtitleEnd = getSubtitleCoverageEnd(input.subtitles);
  const duration = input.metadata.duration;
  const expectedEnd =
    typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? Math.min(duration, subtitleEnd)
      : subtitleEnd;
  if (!Number.isFinite(expectedEnd) || expectedEnd < TIMELINE_COVERAGE_MIN_DURATION_SECONDS) {
    return null;
  }

  const timelineEnd = getAnalysisCoverageEnd(input.analysis);
  const gap = expectedEnd - timelineEnd;
  const coverageRatio = expectedEnd > 0 ? timelineEnd / expectedEnd : 1;
  if (
    gap <= TIMELINE_COVERAGE_ALLOWED_GAP_SECONDS ||
    coverageRatio >= TIMELINE_COVERAGE_MIN_RATIO
  ) {
    return null;
  }
  return { timelineEnd, expectedEnd, gap };
}

function getSubtitleCoverageEnd(subtitles: readonly SubtitleCue[]): number {
  return subtitles.reduce((max, cue) => {
    const cueEnd =
      typeof cue.end === 'number' && Number.isFinite(cue.end) && cue.end > cue.start
        ? cue.end
        : cue.start;
    return Math.max(max, cueEnd);
  }, 0);
}

function getAnalysisCoverageEnd(analysis: VideoAnalysis): number {
  let max = 0;
  for (const chapter of analysis.chapters) {
    max = Math.max(max, getChapterCoverageEnd(chapter));
  }
  for (const node of analysis.timeline) {
    max = Math.max(max, getTimelineNodeCoverageEnd(node));
  }
  return max;
}

function getChapterCoverageEnd(chapter: VideoChapter): number {
  let max =
    typeof chapter.endTimestamp === 'number' && Number.isFinite(chapter.endTimestamp)
      ? chapter.endTimestamp
      : chapter.timestamp;
  for (const segment of chapter.segments) {
    max = Math.max(max, getTimelineNodeCoverageEnd(segment));
  }
  return max;
}

function getTimelineNodeCoverageEnd(node: TimelineNode): number {
  return typeof node.endTimestamp === 'number' && Number.isFinite(node.endTimestamp)
    ? node.endTimestamp
    : node.timestamp;
}

function createTimelineCoverageFailureMessage(problem: TimelineCoverageProblem): string {
  return (
    `生成的导航只覆盖到 ${formatClock(problem.timelineEnd)}，` +
    `但当前字幕覆盖到 ${formatClock(problem.expectedEnd)}，中间缺少约 ${formatClock(problem.gap)}。` +
    '已停止保存这次不完整结果；如果页面仍显示旧导航，那是上次缓存，本次结果没有替换它。请重新生成。'
  );
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function createTimelineParseFailureMessage(input: {
  readonly fullContent: string;
  readonly reasoningContent: string;
  readonly providerName: string;
}): string {
  const { fullContent, reasoningContent, providerName } = input;
  const contentPreview = createPreview(fullContent);
  const reasoningPreview = createPreview(reasoningContent);
  const diagnostics =
    contentPreview.length > 0
      ? `返回片段：${contentPreview}`
      : reasoningPreview.length > 0
        ? `模型只返回了 thinking/reasoning，没有返回可解析的最终 JSONL，片段：${reasoningPreview}`
        : `${providerName} 没有返回可解析正文。`;
  return (
    `${providerName} 返回的内容既不是合法的 JSONL 事件流，也无法解析为完整 JSON。` +
    `${diagnostics} 请重试；如果仍失败，建议稍后再试。`
  );
}

function createPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 220) return normalized;
  return `${normalized.slice(0, 220)}…`;
}

/**
 * 拷贝自 `@core/analysis/analyze-video.ts` 的 `constrainAnalysisToDuration`
 * （该函数未 export）。这里只做"裁剪到视频时长"——和流式时间线的"非严格
 * 实时性"匹配，不需要做 cue id 锚点精修。
 *
 * 之所以 inline 而不是 export：让 core 层的导出列表保持小（用户面只暴露
 * analyzeVideo / analyzeTimelineFromSubtitles 顶层函数）。
 */
function constrainAnalysisToDurationLocal(
  analysis: VideoAnalysis,
  duration: number | undefined,
): VideoAnalysis {
  if (typeof duration !== 'number' || duration <= 0) {
    return analysis;
  }
  const timeline = analysis.timeline
    .filter((node) => node.timestamp <= duration)
    .map((node) => constrainTimelineNodeLocal(node, duration));
  const chapters = analysis.chapters
    .filter((chapter) => chapter.timestamp <= duration)
    .map((chapter) => constrainChapterLocal(chapter, duration));
  return {
    ...analysis,
    chapters,
    timeline,
    quotes: analysis.quotes.filter((quote) => quote.timestamp <= duration),
  };
}

function alignAndConstrainAnalysis(
  analysis: VideoAnalysis,
  metadata: VideoMetadata,
): VideoAnalysis {
  return constrainAnalysisToDurationLocal(
    alignAnalysisToPlatformChapters({
      analysis,
      platformChapters: metadata.platformChapters,
      duration: metadata.duration,
    }),
    metadata.duration,
  );
}

async function ensurePlatformChapterMetadata(input: {
  readonly metadata: VideoMetadata;
  readonly context: PageContext;
  readonly fetchMetadataForContext: VideoTimelineControllerDeps['fetchMetadataForContext'];
}): Promise<VideoMetadata> {
  if (input.context.platform !== 'bilibili' || input.metadata.platformChapters?.length) {
    return input.metadata;
  }
  const fresh = await input.fetchMetadataForContext(input.context);
  return fresh?.platformChapters?.length ? fresh : input.metadata;
}

function constrainTimelineNodeLocal(node: TimelineNode, duration: number): TimelineNode {
  const timestamp = Math.min(node.timestamp, duration);
  const endTimestamp =
    typeof node.endTimestamp === 'number'
      ? Math.min(Math.max(node.endTimestamp, timestamp), duration)
      : undefined;
  const base: TimelineNode = {
    timestamp,
    title: node.title,
    summary: node.summary,
    importance: node.importance,
  };
  return {
    ...base,
    ...(node.contentTag ? { contentTag: node.contentTag } : {}),
    ...(typeof endTimestamp === 'number' ? { endTimestamp } : {}),
    ...(node.reasoning ? { reasoning: node.reasoning } : {}),
    ...(node.watchPrompt ? { watchPrompt: node.watchPrompt } : {}),
  };
}

function constrainChapterLocal(chapter: VideoChapter, duration: number): VideoChapter {
  const timestamp = Math.min(chapter.timestamp, duration);
  const endTimestamp =
    typeof chapter.endTimestamp === 'number'
      ? Math.min(Math.max(chapter.endTimestamp, timestamp), duration)
      : undefined;
  const constrained: VideoChapter = {
    timestamp,
    title: chapter.title,
    summary: chapter.summary,
    importance: chapter.importance,
    ...(chapter.contentTag ? { contentTag: chapter.contentTag } : {}),
    watchGuide: chapter.watchGuide,
    segments: chapter.segments
      .filter((seg) => seg.timestamp <= duration)
      .map((seg) => constrainTimelineNodeLocal(seg, duration)),
  };
  return {
    ...constrained,
    ...(typeof endTimestamp === 'number' ? { endTimestamp } : {}),
    ...(chapter.reflectionPrompt ? { reflectionPrompt: chapter.reflectionPrompt } : {}),
  };
}
