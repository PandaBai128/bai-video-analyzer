/**
 * Content context 领域消息 handler。
 *
 * 处理 `PREPARE_CONTENT_CONTEXT` / `GET_CACHED_CONTENT_CONTEXT`。业务逻辑从
 * service-worker.ts 迁出；handler 不调用 chrome.*、不持有全局状态、不引入
 * default throw。
 *
 * 领域边界：
 * - 创建和读取属于同一 content context 领域；旧 analysisCache 不再迁移。
 * - 编排现有 storage repository（getCachedContentContext / saveContentContext /
 *   fetchMetadataForContext、maybeFetchYouTubeTranscript、
 *   fetchSubtitlesForTimeline；不复制这些实现。
 *
 * PREPARE_CONTENT_CONTEXT 错误分流（与旧 service-worker 一致）：
 * - `NO_ACTIVE_TAB` / `NO_PAGE_CONTEXT` / `UNSUPPORTED_PLATFORM` 走错误响应
 * - 缓存命中（!forceRefresh）→ 直接返回 CONTENT_CONTEXT
 * - 缓存缺失或 forceRefresh → 重新准备并保存
 * - `NO_CONTENT_CONTEXT`：metadata 缺失 或 cues 为空
 */
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { PageContext } from '@shared/page-context';
import {
  CONTENT_CONTEXT_SCHEMA_VERSION,
  type ContentContext,
  type VideoMetadata,
  type VideoPlatform,
  type SubtitleCue,
  type TranscriptSource,
} from '@core/types';
import type { ContentContextCacheValue } from '@core/storage/content-context-cache';
import { createSubtitlePreferenceKey } from '@core/subtitles/language-preference';
import type { YouTubePrefetchOutcome } from '@extension/background/services/video-analysis-service';
import { createNoSubtitleMessageForContext } from '../bilibili-subtitle-errors';

/**
 * SG-02K：`YouTubePrefetchOutcome` 迁到 `services/video-analysis-service.ts` 作为
 * video-analysis service 的公共契约；这里 re-export 保持向后兼容（analysis-handler
 * / 测试旧 import 路径不变）。
 */
export type { YouTubePrefetchOutcome };

export type ContentContextRequest = Extract<
  ExtensionRequest,
  { type: 'PREPARE_CONTENT_CONTEXT' | 'GET_CACHED_CONTENT_CONTEXT' }
>;

/** content context 迁移依赖的精确响应类型。 */
export type CachedContentContextResponse = Extract<
  ExtensionResponse,
  { ok: true; type: 'CACHED_CONTENT_CONTEXT' }
>;

/** content context storage 子依赖（方便测试直接构造）。 */
export interface ContentContextStorage {
  readonly getCachedContentContext: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly subtitlePreferenceKey?: string;
  }) => Promise<ContentContextCacheValue | null>;
  readonly saveContentContext: (
    input: ContentContextCacheValue,
    options: { readonly contentKey: string },
  ) => Promise<void>;
}

export interface ContentContextHandlerDeps {
  /**
   * 解析当前 active tab 的 (tabId, PageContext)。**单次**查询 active tab，避免
   * 两次查询之间用户切换标签页导致"视频 A 的 context 配视频 B 的 tab.id"竞态。
   *
   * - `null` → 无 active tab
   * - `{ tabId, context: null }` → 有 tab 但未检测到 PageContext
   * - `{ tabId, context }` → 同时存在
   */
  readonly resolveCurrentPage: () => Promise<{
    readonly tabId: number;
    readonly context: PageContext | null;
  } | null>;
  /** 从 PageContext 派生 contentKey（缺 contentKey 时回退 `platform:videoId`）。 */
  readonly deriveContentKey: (context: PageContext) => string;
  readonly storage: ContentContextStorage;
  /** 扩展层读取的浏览器字幕语言偏好；core 不依赖 chrome.*。 */
  readonly getSubtitleLanguages?: () => Promise<readonly string[]>;
  /** 解析 metadata（adapter.setCookieHeader + adapter.fetchMetadata 包装）。 */
  readonly fetchMetadataForContext: (context: PageContext) => Promise<VideoMetadata | null>;
  /** YouTube 字幕预取（fast path）。 */
  readonly maybeFetchYouTubeTranscript: (input: {
    readonly context: PageContext;
    readonly tabId: number;
    readonly analysisMode: 'subtitle';
    readonly subtitleLanguages?: readonly string[];
  }) => Promise<YouTubePrefetchOutcome>;
  /** 抓取字幕 cues（带 prefetched YouTube + cookie provider）。 */
  readonly fetchSubtitlesForTimeline: (input: {
    readonly context: PageContext;
    readonly prefetchedYouTube: YouTubePrefetchOutcome;
    readonly startedAt: number;
    readonly cookieProvider: (platform: VideoPlatform) => Promise<string | null>;
    readonly subtitleLanguages?: readonly string[];
  }) => Promise<{
    readonly subtitles: readonly SubtitleCue[];
    readonly transcriptSource: TranscriptSource;
    readonly language?: string;
  }>;
  /** 抓登录态 cookie（用于 B 站 fallback）。 */
  readonly cookieProvider: (platform: VideoPlatform) => Promise<string | null>;
  /** 当前时间戳；测试可注入。 */
  readonly now: () => number;
  readonly createErrorResponse: (code: string, message: string) => ExtensionResponse;
}

export type ContentContextHandler = (
  request: ContentContextRequest,
) => Promise<ExtensionResponse>;

export function createContentContextHandler(
  deps: ContentContextHandlerDeps,
): ContentContextHandler {
  return async (request) => {
    switch (request.type) {
      case 'PREPARE_CONTENT_CONTEXT': {
        return handlePrepareContentContext(deps, request.payload?.forceRefresh === true);
      }
      case 'GET_CACHED_CONTENT_CONTEXT': {
        return handleGetCachedContentContext(deps);
      }
    }
  };
}

async function handlePrepareContentContext(
  deps: ContentContextHandlerDeps,
  forceRefresh: boolean,
): Promise<ExtensionResponse> {
  // **单次**查询 active tab：返回的 tabId 和 context 来自同一次解析，
  // 避免"两次查询之间用户切换标签页导致 video A 的 context 配 video B 的 tab.id"竞态。
  const page = await deps.resolveCurrentPage();
  if (page === null) {
    return deps.createErrorResponse('NO_ACTIVE_TAB', '没有找到当前标签页');
  }
  const { tabId } = page;
  const { context } = page;
  if (context === null) {
    return deps.createErrorResponse('NO_PAGE_CONTEXT', '还没有检测到当前内容页面');
  }
  if (context.platform !== 'bilibili' && context.platform !== 'youtube') {
    return deps.createErrorResponse(
      'UNSUPPORTED_PLATFORM',
      '当前页面平台暂不支持内容底座（仅 B 站 / YouTube 视频）。',
    );
  }
  const subtitleLanguages = await resolveSubtitleLanguages(deps);
  const subtitlePreferenceKey = createSubtitlePreferenceKey(subtitleLanguages);

  // 1) 缓存命中直接返回（不重复抓字幕）。
  if (!forceRefresh) {
    const contentKey = deps.deriveContentKey(context);
    const cached = await deps.storage.getCachedContentContext({
      platform: context.platform,
      contentKey,
      subtitlePreferenceKey,
    });
    if (cached) {
      // 命中缓存时仍要构造 ContentContext 完整结构（带 createdAt / updatedAt / kind）。
      const now = deps.now();
      return {
        ok: true,
        type: 'CONTENT_CONTEXT',
        payload: {
          schemaVersion: CONTENT_CONTEXT_SCHEMA_VERSION,
          platform: context.platform,
          contentKey,
          videoId: context.videoId ?? '',
          kind: 'video',
          metadata: cached.metadata,
          transcriptCues: cached.transcriptCues,
          transcriptCueCount: cached.transcriptCues.length,
          transcriptSource: cached.transcriptSource,
          subtitlePreferenceKey,
          ...(cached.language ? { language: cached.language } : {}),
          createdAt: now,
          updatedAt: now,
        },
      };
    }
  }

  // 2) 拿 metadata（复用 fetchMetadataForContext helper）。
  const metadata = await deps.fetchMetadataForContext(context);
  if (!metadata) {
    return deps.createErrorResponse('NO_CONTENT_CONTEXT', '当前内容没有可用的元数据。');
  }

  // 3) 拿字幕：YouTube 优先走 prefetched transcript；其它走 fetchSubtitlesForTimeline。
  // 整个 PREPARE 流程 tabId 始终用本函数入口的 `tabId`（与上面 context 来自同一次解析）。
  const startedAt = deps.now();
  const prefetched = await deps.maybeFetchYouTubeTranscript({
    context,
    tabId,
    analysisMode: 'subtitle',
    subtitleLanguages,
  });
  const fetched = await deps.fetchSubtitlesForTimeline({
    context,
    prefetchedYouTube: prefetched,
    startedAt,
    cookieProvider: deps.cookieProvider,
    subtitleLanguages,
  });
  const cues = fetched.subtitles;
  const transcriptSource = fetched.transcriptSource ?? 'unknown';
  if (cues.length === 0) {
    let bilibiliCookieHeader: string | null | undefined;
    if (context.platform === 'bilibili') {
      try {
        bilibiliCookieHeader = await deps.cookieProvider('bilibili');
      } catch {
        bilibiliCookieHeader = undefined;
      }
    }
    return deps.createErrorResponse(
      'NO_CONTENT_CONTEXT',
      createNoSubtitleMessageForContext({
        context,
        bilibiliCookieHeader,
        fallback: '当前内容没有可用字幕。公开版需要字幕作为分析、提问和学习笔记依据。',
      }),
    );
  }

  // 4) 保存 contentContext（contentKey 沿用 PageContext 派生规则）。
  const contentKey = deps.deriveContentKey(context);
  await deps.storage.saveContentContext(
    {
      metadata,
      transcriptCues: cues,
      transcriptSource,
      subtitlePreferenceKey,
      ...(fetched.language ? { language: fetched.language } : {}),
    },
    { contentKey },
  );

  // 5) 返回 CONTENT_CONTEXT payload。
  const now = deps.now();
  return {
    ok: true,
    type: 'CONTENT_CONTEXT',
    payload: {
      schemaVersion: CONTENT_CONTEXT_SCHEMA_VERSION,
      platform: context.platform,
      contentKey,
      videoId: context.videoId ?? '',
      kind: 'video',
      metadata,
      transcriptCues: cues,
      transcriptCueCount: cues.length,
      transcriptSource,
      subtitlePreferenceKey,
      ...(fetched.language ? { language: fetched.language } : {}),
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function handleGetCachedContentContext(
  deps: ContentContextHandlerDeps,
): Promise<ExtensionResponse> {
  // GET_CACHED_CONTENT_CONTEXT 不需要 tabId（不需要预取），但复用 resolveCurrentPage
  // 避免新增第二次 active tab 查询。无 tab / 无 context 都返回 payload: null。
  const page = await deps.resolveCurrentPage();
  if (page === null) {
    return { ok: true, type: 'CACHED_CONTENT_CONTEXT', payload: null };
  }
  const { context } = page;
  if (context === null) {
    return { ok: true, type: 'CACHED_CONTENT_CONTEXT', payload: null };
  }
  if (context.platform !== 'bilibili' && context.platform !== 'youtube') {
    return { ok: true, type: 'CACHED_CONTENT_CONTEXT', payload: null };
  }
  return loadCachedContentContext(
    {
      platform: context.platform,
      videoId: context.videoId ?? '',
      contentKey: deps.deriveContentKey(context),
      subtitlePreferenceKey: createSubtitlePreferenceKey(await resolveSubtitleLanguages(deps)),
    },
    deps.storage,
    deps.now,
  );
}

/**
 * 读取 content context 缓存。旧 analysisCache 的 transcriptCues 可能来自错误语言，
 * 因此 schema 升级后不再把它迁移回 contentContext；缓存 miss 直接返回 null。
 *
 * 导出供独立单测使用（`tests/unit/content-context-handler.test.ts`）。
 */
export async function loadCachedContentContext(
  input: {
    readonly platform: VideoPlatform;
    readonly videoId: string;
    readonly contentKey: string;
    readonly subtitlePreferenceKey?: string;
  },
  storage: ContentContextStorage,
  /**
   * 当前时间戳；命中和迁移分支都用它设置 `createdAt` / `updatedAt`。
   * 注入而非 `Date.now()` 写死，让测试能稳定验证响应时间戳。
   */
  now: () => number,
): Promise<CachedContentContextResponse> {
  const cached = await storage.getCachedContentContext({
    platform: input.platform,
    contentKey: input.contentKey,
    ...(input.subtitlePreferenceKey ? { subtitlePreferenceKey: input.subtitlePreferenceKey } : {}),
  });
  if (cached) {
    return {
      ok: true,
      type: 'CACHED_CONTENT_CONTEXT',
      payload: buildContentContextPayload(input, cached, now),
    };
  }

  return { ok: true, type: 'CACHED_CONTENT_CONTEXT', payload: null };
}

function buildContentContextPayload(
  input: {
    readonly platform: VideoPlatform;
    readonly videoId: string;
    readonly contentKey: string;
    readonly subtitlePreferenceKey?: string;
  },
  cached: ContentContextCacheValue,
  now: () => number,
): ContentContext {
  const ts = now();
  return {
    schemaVersion: CONTENT_CONTEXT_SCHEMA_VERSION,
    platform: input.platform,
    contentKey: input.contentKey,
    videoId: input.videoId,
    kind: 'video',
    metadata: cached.metadata,
    transcriptCues: cached.transcriptCues,
    transcriptCueCount: cached.transcriptCues.length,
    transcriptSource: cached.transcriptSource,
    subtitlePreferenceKey:
      cached.subtitlePreferenceKey ??
      input.subtitlePreferenceKey ??
      createSubtitlePreferenceKey(undefined),
    ...(cached.language ? { language: cached.language } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
}

async function resolveSubtitleLanguages(
  deps: Pick<ContentContextHandlerDeps, 'getSubtitleLanguages'>,
): Promise<readonly string[]> {
  return (await deps.getSubtitleLanguages?.()) ?? [];
}
