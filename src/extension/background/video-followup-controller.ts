import { MinimaxApiError } from '@core/llm/minimax-client';
import {
  LanguageModelStreamUnsupportedError,
  type LanguageModelClient,
  type LanguageModelStreamChunk,
} from '@core/llm/language-model-client';
import { getCachedAnalysis } from '@core/storage/analysis-cache';
import { getCachedContentContext } from '@core/storage/content-context-cache';
import { createSubtitlePreferenceKey } from '@core/subtitles/language-preference';
import { readTextProviderSettings } from '@extension/settings/text-provider-settings';
import {
  buildVideoContextPackage,
  isContextPackageValidFor,
  type VideoContextPackage,
} from '@core/followup/video-context-package';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import { buildFollowupChatPrompt } from '@core/prompts/video-followup-chat';
import { buildContextualRetrievalQuestion } from '@core/followup/contextual-retrieval-question';
import { pickConversationHistory } from '@core/followup/conversation-history';
import {
  MinimaxSearchClient,
  type MinimaxWebSearchContext,
} from '@core/llm/minimax-search-client';
import type {
  FollowupAnswerBasis,
  FollowupConversationMessage,
  VideoFollowupPortMessage,
} from '@shared/messages';
import {
  createTextProviderMissingMessage,
  getActiveTextModel,
  getActiveTextProviderId,
  hasConfiguredTextProvider,
  type LegacyAnalysisMode,
  type TextProviderSettings,
} from '@shared/settings';
import { detectQuestionLocale, type UiLocale } from '@shared/locale-settings';
import type { PageContext } from '@shared/page-context';
import { getPageContextContentKey } from '@shared/content-key';
import {
  CONTENT_CONTEXT_REQUIRED_ERROR_CODE,
  type SubtitleCue,
  type VideoAnalysis,
  type VideoMetadata,
  type VideoPlatform,
} from '@core/types';

/**
 * Background端 video-followup控制器。
 *
 * Round12修复要点：
 *1. streamChat 默认走当前文本模型，MiniMax 时仍是 settings.fastModel
 *2. streamChat 抛 LanguageModelStreamUnsupportedError 时 controller 自动 fallback 到
 * chat() 把整段 content当一个 chunk推出去，side panel不会再永远卡 loading
 *3. catch 不再依赖 `inFlight && inFlight.requestId === requestId` —— service worker
 * 被 unload + reload 后 inFlight 被新 instance 重置，旧实现会跳过 error / done推送，
 * 导致 side panel永远停在 loading
 */

export interface VideoFollowupControllerDeps {
 /**
 *解析当前 tab 的视频上下文。返回 null 表示没有可追问的视频。
 */
 resolveActiveVideoContext: () => Promise<{
 readonly context: PageContext | null;
 readonly currentTime: number | null;
 }>;
 /** 构造当前文本 Provider client（settings 由 controller 从 storage 读）。 */
 createTextProviderClient: (input: TextProviderSettings) => LanguageModelClient;
 /** Port message派发。 */
 postMessage: (message: VideoFollowupPortMessage) => void;
 /** 时间戳；测试可注入 */
 now?: () => number;
 /** Round12: 是否在 SSE不可用时自动 fallback 到 chat()。默认 true。 */
 fallbackToNonStream?: boolean;
  /** 扩展层读取浏览器字幕语言偏好。 */
  getSubtitleLanguages?: () => Promise<readonly string[]>;
}

export interface VideoFollowupController {
  handleAsk(input: {
  readonly requestId: string;
  readonly question: string;
  readonly includeCurrentSegment: boolean;
  readonly currentTime?: number;
  readonly selectedTimestamp?: number;
  readonly forceCurrentSegment?: boolean;
  /**
   * 回答依据。side panel 缺省 / 字段缺失时 controller 归一化为 `'video_only'`，
   * 保证背景收紧到确定值。
   */
  readonly answerBasis?: FollowupAnswerBasis;
  /** 回答语言由当前问题决定：中文问中文答，英文问英文答。 */
  readonly answerLocale?: UiLocale;
  /**
   * 跨 Port 边界传输的对话历史。**仅**用于"它 / 我问的是 / 那缺点呢"等
   * 短追问的指代 / 纠正 / 延续；视频事实仍必须来自 `<video_context>`。
   * 缺失时按空历史处理。
   */
  readonly conversationHistory?: readonly FollowupConversationMessage[];
  readonly analysisMode?: LegacyAnalysisMode;
  }): Promise<void>;
  handleCancel(input: { readonly requestId: string }): void;
  handleDisconnect(): void;
}

interface InFlightRequest {
 abort: AbortController;
 requestId: string;
}

export function createVideoFollowupController(
 deps: VideoFollowupControllerDeps,
): VideoFollowupController {
 const now = deps.now ?? Date.now;
 const fallbackToNonStream = deps.fallbackToNonStream ?? true;
 let inFlight: InFlightRequest | null = null;

 function abortInFlight(): void {
 if (!inFlight) {
 return;
 }
 inFlight.abort.abort();
 inFlight = null;
 }

 /**
 * Round12: 当前 requestId 是否还是 controller 的"当前有效"请求。
 * cleanup race修复：旧实现用 `inFlight && inFlight.requestId === requestId`
 *决定要不要推 done / error。service worker 被 unload + reload 后 inFlight
 * 被新 instance 重置，会导致旧请求的 error/done 不推。
 */
 function isCurrentOrphanRequest(requestId: string): boolean {
 if (!inFlight) {
 return false;
 }
 return inFlight.requestId === requestId;
 }

async function handleAsk(input: {
  readonly requestId: string;
  readonly question: string;
  readonly includeCurrentSegment: boolean;
  readonly currentTime?: number;
  readonly selectedTimestamp?: number;
  readonly forceCurrentSegment?: boolean;
  readonly answerBasis?: FollowupAnswerBasis;
  readonly answerLocale?: UiLocale;
  readonly conversationHistory?: readonly FollowupConversationMessage[];
  readonly analysisMode?: LegacyAnalysisMode;
  }): Promise<void> {
  // Port 边界归一化：side panel 缺省 / 字段缺失 → video_only，保持历史严格行为。
  // 业务层和 prompt 都拿确定值，不再各自猜默认值。
  const rawAnswerBasis: FollowupAnswerBasis = input.answerBasis ?? 'video_only';
  const answerLocale = input.answerLocale ?? detectQuestionLocale(input.question);

  // Port 边界硬护栏（QA1 必修 1）：不能完全信任 side panel 传来的 history，
  // 在 background 端再次走 pickConversationHistory 的硬上限逻辑：
  // - 缺失 / 非数组 / 含非法 role → 空
  // - streaming / error / 空 content assistant 排除
  // - 超过 3 轮 / 6000 字符硬上限的丢弃
  // 与 side panel 共用同一份核心纯函数（`@core/followup/conversation-history`），
  // 保证 sidepanel 与 background 应用完全一致的限额算法。
  const rawHistory = Array.isArray(input.conversationHistory) ? input.conversationHistory : [];
  const validatedRaw = rawHistory
    .filter(
      (m): m is { role: 'user' | 'assistant'; content: string; streaming?: boolean; error?: { code: string; message: string } } =>
        !!m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string',
    )
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.streaming ? { streaming: true } : {}),
      ...(m.error ? { error: m.error } : {}),
    }));
  const conversationHistory = pickConversationHistory({ messages: validatedRaw });
 // 单实例策略：新的 requestId进来时 abort旧请求
 if (inFlight && inFlight.requestId !== input.requestId) {
 abortInFlight();
 }
 if (inFlight && inFlight.requestId === input.requestId) {
 return;
 }
 const abort = new AbortController();
 inFlight = { abort, requestId: input.requestId };

 try {
 const resolved = await deps.resolveActiveVideoContext();
 const { context, currentTime } = resolved;

 if (!context || !context.videoId) {
 postError(input.requestId, 'NO_ACTIVE_TAB', '当前没有可追问的视频页面。');
 return;
 }
 if (context.platform !== 'bilibili' && context.platform !== 'youtube') {
 postError(input.requestId, 'UNSUPPORTED_PLATFORM', '当前页面平台暂不支持追问。');
 return;
 }

 const settings = await readTextProviderSettings();
 const requestedAnalysisMode = input.analysisMode ?? settings.analysisMode;
 if (requestedAnalysisMode !== 'subtitle') {
   postError(
     input.requestId,
     'UNSUPPORTED_ANALYSIS_MODE',
     '公开版只支持基于字幕内容提问；本地转写和视频理解实验已从公开版移除。',
   );
   return;
 }
 const normalizedAnswerBasis: FollowupAnswerBasis = rawAnswerBasis;
 const activeTextProvider = getActiveTextProviderId(settings);
 if (normalizedAnswerBasis === 'video_plus_web') {
   if (activeTextProvider !== 'minimax') {
     postError(input.requestId, 'WEB_SEARCH_MINIMAX_ONLY', '联网搜索实验功能当前仅支持 MiniMax。');
     return;
   }
   if (settings.webSearchEnabled !== true) {
     postError(input.requestId, 'WEB_SEARCH_DISABLED', '请先在设置中开启联网搜索实验功能。');
     return;
   }
   if (!settings.apiKey.trim()) {
     postError(input.requestId, 'MINIMAX_API_KEY_MISSING', '请先在设置中配置 MiniMax API Key。');
     return;
   }
 }

  // Round 22 必修 A5：用 contentKey 读缓存，标签和反思也按 contentKey 隔离。
  const contentKey =
    getPageContextContentKey(context) ?? `${context.platform}:${context.videoId}`;
  const subtitlePreferenceKey = createSubtitlePreferenceKey(
    (await deps.getSubtitleLanguages?.()) ?? [],
  );

  if (!hasConfiguredTextProvider(settings)) {
    postError(input.requestId, 'MINIMAX_API_KEY_MISSING', `${createTextProviderMissingMessage(settings)}。`);
    return;
  }

  const contextSource = await resolveFollowupContextSource({
    platform: context.platform,
    videoId: context.videoId,
    contentKey,
    subtitlePreferenceKey,
  });
  if (!contextSource.ok) {
    postError(input.requestId, contextSource.code, contextSource.message);
    return;
  }

  const annotations: readonly never[] = [];
  // Round 24 必修 D：annotations 表已删除。复盘 / 提问 prompt 仍按 VideoContextPackage
  // 形状构造，annotations 字段为 []，prompt 渲染成"（无标注）"占位。
  // —— 后续若重新引入片段记录筛选，从这里加回。

  const pkg: VideoContextPackage = buildVideoContextPackage({
    metadata: contextSource.metadata,
    analysis: contextSource.analysis,
    transcriptCues: contextSource.transcriptCues,
    annotations,
  });

  // Round 22 必修 A5：上下文校验也要按 contentKey 比对，避免把 BV:p=8 的 pkg 误
  // 接受为当前 BV:p=10 的上下文。
  if (
    !isContextPackageValidFor(pkg, {
      platform: context.platform,
      videoId: context.videoId,
      contentKey,
    })
  ) {
    postError(input.requestId, 'CONTEXT_MISMATCH', '视频上下文与缓存不匹配，请重新分析。');
    return;
  }

  const effectiveCurrentTime = input.currentTime ?? currentTime ?? undefined;
  // 检索补全：仅用于 selectFollowupContext 的检索问题；用户可见的 input.question
  // 和 buildFollowupChatPrompt 的 question 保持原文。
  const retrievalQuestion = buildContextualRetrievalQuestion({
    question: input.question,
    conversationHistory,
  });
  const selectedContext = selectFollowupContext({
  question: retrievalQuestion,
  contextPackage: pkg,
  ...(typeof effectiveCurrentTime === 'number' ? { currentTime: effectiveCurrentTime } : {}),
  ...(input.selectedTimestamp !== undefined ? { selectedTimestamp: input.selectedTimestamp } : {}),
  includeCurrentSegment: input.includeCurrentSegment,
  ...(input.forceCurrentSegment === true ? { forceCurrentSegment: true } : {}),
  });

 const client = deps.createTextProviderClient(settings);
 const startedAt = now();

 // 追问走当前文本 Provider；MiniMax 时仍使用 fastModel，不读历史 model 字段。
 const streamModel = getActiveTextModel(settings);

 try {
 const webSearchContext =
 normalizedAnswerBasis === 'video_plus_web'
 ? await searchForFollowup({
 settings,
 question: input.question,
 title: contextSource.metadata.title,
 author: contextSource.metadata.author,
 signal: abort.signal,
 })
 : undefined;

  const prompt = buildFollowupChatPrompt({
  question: input.question,
  contextPackage: pkg,
  selectedContext,
  answerBasis: normalizedAnswerBasis,
  answerLocale,
  ...(webSearchContext ? { webSearchContext } : {}),
  ...(conversationHistory.length > 0 ? { conversationHistory } : {}),
  });

 let usedFallback = false;
 try {
 for await (const chunk of streamWithAbort(client, prompt, abort.signal, streamModel)) {
 if (!inFlight || inFlight.requestId !== input.requestId) {
 break;
 }
 pushChunk(input.requestId, chunk);
 }
 } catch (streamError) {
 if (abort.signal.aborted) {
 return;
 }
 if (
 streamError instanceof LanguageModelStreamUnsupportedError &&
 fallbackToNonStream &&
 isCurrentOrphanRequest(input.requestId)
 ) {
 if (import.meta.env.DEV) {
 console.warn('[bAI] streamChat unsupported, fallback to chat():', streamError.message);
 }
 usedFallback = true;
 const fallbackResult = await client.chat(
 [
 { role: 'system', content: prompt.system },
 { role: 'user', content: prompt.user },
 ],
 { model: streamModel, signal: abort.signal, usageFeature: 'followup' },
 );
 if (!isCurrentOrphanRequest(input.requestId)) {
 return;
 }
 const fallbackText = fallbackResult.content;
 if (fallbackText && fallbackText.length >0) {
 deps.postMessage({
 type: 'VIDEO_ANSWER_CHUNK',
 requestId: input.requestId,
 text: fallbackText,
 });
 }
 deps.postMessage({ type: 'VIDEO_ANSWER_DONE', requestId: input.requestId });
 return;
 }
 throw streamError;
 }
 if (!usedFallback && isCurrentOrphanRequest(input.requestId)) {
 deps.postMessage({ type: 'VIDEO_ANSWER_DONE', requestId: input.requestId });
 }
 } catch (error) {
 if (abort.signal.aborted) {
 return;
 }
 if (!isCurrentOrphanRequest(input.requestId)) {
 return;
 }
 const message = error instanceof Error ? error.message : String(error);
 const code =
 error instanceof MinimaxApiError
 ? error.status === null
 ? 'MINIMAX_ERROR'
 : `MINIMAX_HTTP_${error.status}`
 : 'STREAM_FAILED';
 postError(input.requestId, code, message);
 } finally {
 if (inFlight && inFlight.requestId === input.requestId) {
 inFlight = null;
 }
 if (import.meta.env.DEV) {
 console.debug(`[video-followup] requestId=${input.requestId}耗时 ${now() - startedAt}ms`);
 }
 }
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 if (isCurrentOrphanRequest(input.requestId)) {
 postError(input.requestId, 'UNEXPECTED_ERROR', message);
 }
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

 function pushChunk(requestId: string, chunk: LanguageModelStreamChunk): void {
 if (chunk.done) {
 return;
 }
 if (chunk.reasoning) {
 deps.postMessage({ type: 'VIDEO_ANSWER_REASONING_CHUNK', requestId, text: chunk.reasoning });
 return;
 }
 if (chunk.text) {
 deps.postMessage({ type: 'VIDEO_ANSWER_CHUNK', requestId, text: chunk.text });
 }
 }

 function postError(requestId: string, code: string, message: string): void {
 deps.postMessage({ type: 'VIDEO_ANSWER_ERROR', requestId, code, message });
 }

 return {
 handleAsk,
 handleCancel,
 handleDisconnect,
 };
}

type FollowupContextSource =
  | {
      readonly ok: true;
      readonly metadata: VideoMetadata;
      readonly analysis: VideoAnalysis;
      readonly transcriptCues: readonly SubtitleCue[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

async function resolveFollowupContextSource(input: {
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly contentKey: string;
  readonly subtitlePreferenceKey: string;
}): Promise<FollowupContextSource> {
  const contentContext = await getCachedContentContext({
    platform: input.platform,
    contentKey: input.contentKey,
    subtitlePreferenceKey: input.subtitlePreferenceKey,
  });
  if (!contentContext) {
    return {
      ok: false,
      code: CONTENT_CONTEXT_REQUIRED_ERROR_CODE,
      message: '请先开启当前视频内容，再来提问。',
    };
  }

  const analysisCache = await getCachedAnalysis({
    platform: input.platform,
    videoId: input.videoId,
    contentKey: input.contentKey,
    sourceMode: 'subtitle',
    subtitlePreferenceKey: input.subtitlePreferenceKey,
  });

  return {
    ok: true,
    metadata: contentContext.metadata,
    analysis: analysisCache?.analysis ?? buildEmptyAnalysis(),
    transcriptCues: contentContext.transcriptCues,
  };
}

/**
 *包装 LanguageModelClient.streamChat 加上 abort signal + model override。
 */
async function* streamWithAbort(
 client: LanguageModelClient,
 prompt: { readonly system: string; readonly user: string },
 signal: AbortSignal,
 model: string,
): AsyncGenerator<LanguageModelStreamChunk, void, void> {
 if (signal.aborted) {
 throw new MinimaxApiError('追问请求已取消', null, '');
 }
 const iterator = client.streamChat(
 [
 { role: 'system', content: prompt.system },
 { role: 'user', content: prompt.user },
 ],
 { signal, model, usageFeature: 'followup' },
 );

 for await (const chunk of iterator) {
 if (signal.aborted) {
 return;
 }
 yield chunk;
 }
}

async function searchForFollowup(input: {
 readonly settings: TextProviderSettings;
 readonly question: string;
 readonly title: string;
 readonly author?: string;
 readonly signal: AbortSignal;
}): Promise<MinimaxWebSearchContext> {
 const client = new MinimaxSearchClient(input.settings);
 return client.searchFollowup(
 {
 question: input.question,
 title: input.title,
 ...(input.author ? { author: input.author } : {}),
 },
 { signal: input.signal, limit: 10 },
 );
}

/**
 * Round 29A 必修 D：analysisCache 不存在时构造 minimal VideoAnalysis。
 *
 * `buildVideoContextPackage` 要求 analysis 是非空对象（类型上不接受 null），
 * 但其内部只读 `analysis.timeline / chapters / coreTakeaways / reviewSummary`。
 * 全部给空数组 / 空串即可——prompt 模板会渲染成"无时间线 / 无章节 / 无复盘"。
 * 这个 stub 只用于 subtitle 模式下缺少 analysisCache 的兼容兜底。
 */
function buildEmptyAnalysis(): VideoAnalysis {
 return {
 overview: '',
 watchStrategy: [],
 coreTakeaways: [],
 reviewSummary: '',
 chapters: [],
 timeline: [],
 quotes: [],
 keyConcepts: [],
 inspirations: [],
 generatedAt: 0,
 modelUsed: '',
 sourceMode: 'subtitle',
 };
}
