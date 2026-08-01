import { describe, expect, it, vi } from 'vitest';
import {
  createContentContextHandler,
  loadCachedContentContext,
} from '@extension/background/handlers/content-context-handler';
import type {
  ContentContextHandlerDeps,
  ContentContextStorage,
  ContentContextRequest,
} from '@extension/background/handlers/content-context-handler';
import type { ExtensionResponse } from '@shared/messages';
import type { PageContext } from '@shared/page-context';
import type { SubtitleCue, TranscriptSource, VideoMetadata, VideoPlatform } from '@core/types';
import type { ContentContextCacheValue } from '@core/storage/content-context-cache';
import type { YouTubePrefetchOutcome } from '@extension/background/handlers/content-context-handler';

function makeMetadata(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    platform: 'bilibili',
    videoId: 'BV-mock',
    title: 'mock',
    author: 'mock-author',
    duration: 120,
    url: 'https://www.bilibili.com/video/BV-mock',
    ...overrides,
  };
}

function makeCues(): SubtitleCue[] {
  return [
    { start: 0, end: 2, text: '第一句' },
    { start: 2, end: 4, text: '第二句' },
  ];
}

function makePageContext(overrides: Partial<PageContext> = {}): PageContext {
  return {
    platform: 'bilibili',
    videoId: 'BV-mock',
    url: 'https://www.bilibili.com/video/BV-mock',
    title: 'mock',
    detectedAt: 0,
    contentKey: 'BV-mock:p=1',
    ...overrides,
  };
}

function makeCacheValue(
  metadata: VideoMetadata = makeMetadata(),
  cues: SubtitleCue[] = makeCues(),
): ContentContextCacheValue {
  return { metadata, transcriptCues: cues, transcriptSource: 'official' };
}

function makeStorage(overrides: Partial<ContentContextStorage> = {}): ContentContextStorage {
  return {
    getCachedContentContext: vi.fn().mockResolvedValue(null),
    saveContentContext: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ContentContextHandlerDeps> = {}): ContentContextHandlerDeps {
  return {
    resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: null }),
    deriveContentKey: vi.fn().mockReturnValue('BV-mock:p=1'),
    storage: makeStorage(),
    fetchMetadataForContext: vi.fn().mockResolvedValue(makeMetadata()),
    maybeFetchYouTubeTranscript: vi
      .fn()
      .mockResolvedValue({ kind: 'skipped' } as YouTubePrefetchOutcome),
    fetchSubtitlesForTimeline: vi.fn().mockResolvedValue({
      subtitles: makeCues(),
      transcriptSource: 'official' satisfies TranscriptSource,
    }),
    cookieProvider: vi.fn().mockResolvedValue(null),
    now: () => 1_700_000_000_000,
    createErrorResponse: (code, message) => ({ ok: false, error: { code, message } }),
    ...overrides,
  };
}

describe('createContentContextHandler', () => {
  describe('PREPARE_CONTENT_CONTEXT', () => {
    it('无 active tab → 返回 NO_ACTIVE_TAB', async () => {
      const createErrorResponse = vi.fn(
        (code: string, message: string): ExtensionResponse => ({
          ok: false,
          error: { code, message },
        }),
      );
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue(null),
        createErrorResponse,
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: false,
        error: { code: 'NO_ACTIVE_TAB', message: '没有找到当前标签页' },
      });
      expect(createErrorResponse).toHaveBeenCalledWith('NO_ACTIVE_TAB', '没有找到当前标签页');
    });

    it('有 tab 但无 page context → 返回 NO_PAGE_CONTEXT', async () => {
      const createErrorResponse = vi.fn(
        (code: string, message: string): ExtensionResponse => ({
          ok: false,
          error: { code, message },
        }),
      );
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: null }),
        createErrorResponse,
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: false,
        error: { code: 'NO_PAGE_CONTEXT', message: '还没有检测到当前内容页面' },
      });
    });

    it('不支持的平台 → 返回 UNSUPPORTED_PLATFORM', async () => {
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({
          tabId: 1,
          context: {
            // 内联构造：exactOptionalPropertyTypes 不允许给可选字段写 `undefined`
            platform: 'unknown',
            url: 'https://example.com/',
            title: '未支持页面',
            detectedAt: 0,
          },
        }),
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: false,
        error: {
          code: 'UNSUPPORTED_PLATFORM',
          message: '当前页面平台暂不支持内容底座（仅 B 站 / YouTube 视频）。',
        },
      });
    });

    it('缓存命中且非 forceRefresh → 直返缓存（不重复抓 metadata / subtitle）', async () => {
      const cached = makeCacheValue();
      const fetchMetadataForContext = vi.fn();
      const fetchSubtitlesForTimeline = vi.fn();
      const storage = makeStorage({
        getCachedContentContext: vi.fn().mockResolvedValue(cached),
      });
      const now = vi.fn().mockReturnValue(1_700_000_000_000);
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        storage,
        fetchMetadataForContext,
        fetchSubtitlesForTimeline,
        now,
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };

      const response = await handler(request);

      expect(response.ok).toBe(true);
      if (response.ok && response.type === 'CONTENT_CONTEXT') {
        // 引用透传
        expect(response.payload.metadata).toBe(cached.metadata);
        expect(response.payload.transcriptCues).toBe(cached.transcriptCues);
        // QA1 必修 B：createdAt/updatedAt 使用注入的 now（**不**写死 0）
        expect(response.payload.createdAt).toBe(1_700_000_000_000);
        expect(response.payload.updatedAt).toBe(1_700_000_000_000);
        expect(now).toHaveBeenCalled();
        // 不抓 metadata / 字幕
        expect(fetchMetadataForContext).not.toHaveBeenCalled();
        expect(fetchSubtitlesForTimeline).not.toHaveBeenCalled();
      } else {
        throw new Error('response 不是 CONTENT_CONTEXT 成功响应');
      }
    });

    it('forceRefresh → 不读缓存，直接走完整准备流程', async () => {
      const saveContentContext = vi.fn().mockResolvedValue(undefined);
      const storage = makeStorage({
        getCachedContentContext: vi.fn().mockResolvedValue(makeCacheValue()),
        saveContentContext,
      });
      const fetchMetadataForContext = vi.fn().mockResolvedValue(makeMetadata());
      const fetchSubtitlesForTimeline = vi.fn().mockResolvedValue({
        subtitles: makeCues(),
        transcriptSource: 'official' satisfies TranscriptSource,
      });
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        storage,
        fetchMetadataForContext,
        fetchSubtitlesForTimeline,
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = {
        type: 'PREPARE_CONTENT_CONTEXT',
        payload: { forceRefresh: true },
      };

      const response = await handler(request);

      expect(response.ok).toBe(true);
      // 强制刷新 → 缓存没被读
      expect(storage.getCachedContentContext).not.toHaveBeenCalled();
      expect(fetchMetadataForContext).toHaveBeenCalled();
      expect(fetchSubtitlesForTimeline).toHaveBeenCalled();
      expect(saveContentContext).toHaveBeenCalled();
    });

    it('未命中缓存 → 走完整流程 + 保存', async () => {
      const metadata = makeMetadata();
      const cues = makeCues();
      const saveContentContext = vi.fn().mockResolvedValue(undefined);
      const storage = makeStorage({
        getCachedContentContext: vi.fn().mockResolvedValue(null),
        saveContentContext,
      });
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        storage,
        fetchMetadataForContext: vi.fn().mockResolvedValue(metadata),
        fetchSubtitlesForTimeline: vi.fn().mockResolvedValue({
          subtitles: cues,
          transcriptSource: 'official' satisfies TranscriptSource,
        }),
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };

      const response = await handler(request);

      expect(response.ok).toBe(true);
      if (response.ok && response.type === 'CONTENT_CONTEXT') {
        expect(response.payload.metadata).toBe(metadata);
        expect(response.payload.transcriptCues).toBe(cues);
        expect(saveContentContext).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata,
            transcriptCues: cues,
            transcriptSource: 'official',
            subtitlePreferenceKey: 'zh-cn,en-us',
          }),
          expect.objectContaining({ contentKey: 'BV-mock:p=1' }),
        );
      } else {
        throw new Error('response 不是 CONTENT_CONTEXT 成功响应');
      }
    });

    it('未命中缓存保存实际字幕来源，B 站 AI 字幕显示为自动字幕', async () => {
      const metadata = makeMetadata();
      const cues = makeCues();
      const saveContentContext = vi.fn().mockResolvedValue(undefined);
      const storage = makeStorage({
        getCachedContentContext: vi.fn().mockResolvedValue(null),
        saveContentContext,
      });
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        storage,
        fetchMetadataForContext: vi.fn().mockResolvedValue(metadata),
        fetchSubtitlesForTimeline: vi.fn().mockResolvedValue({
          subtitles: cues,
          transcriptSource: 'asr' satisfies TranscriptSource,
          language: 'zh-CN',
        }),
      });
      const handler = createContentContextHandler(deps);

      const response = await handler({ type: 'PREPARE_CONTENT_CONTEXT' });

      expect(response.ok).toBe(true);
      if (response.ok && response.type === 'CONTENT_CONTEXT') {
        expect(response.payload.transcriptSource).toBe('asr');
        expect(response.payload.language).toBe('zh-CN');
      } else {
        throw new Error('response 不是 CONTENT_CONTEXT 成功响应');
      }
      expect(saveContentContext).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata,
          transcriptCues: cues,
          transcriptSource: 'asr',
          language: 'zh-CN',
          subtitlePreferenceKey: 'zh-cn,en-us',
        }),
        expect.objectContaining({ contentKey: 'BV-mock:p=1' }),
      );
    });

    // QA1 必修 A：tab 身份一致性
    // resolveCurrentPage 必须**单次**返回，PREPARE 整个流程用同一 (tabId, context) 配对。
    it('tab 身份一致性：PREPARE 流程用 resolveCurrentPage 单次返回的 (tabId, context)，不允许第二次 tab 查询', async () => {
      const resolveCurrentPage = vi.fn().mockResolvedValue({
        tabId: 42,
        context: makePageContext(),
      });
      const maybeFetchYouTubeTranscript = vi
        .fn()
        .mockResolvedValue({ kind: 'skipped' } as YouTubePrefetchOutcome);
      const deps = makeDeps({
        resolveCurrentPage,
        maybeFetchYouTubeTranscript,
        fetchMetadataForContext: vi.fn().mockResolvedValue(makeMetadata()),
        fetchSubtitlesForTimeline: vi.fn().mockResolvedValue({
          subtitles: makeCues(),
          transcriptSource: 'official' satisfies TranscriptSource,
        }),
      });
      const handler = createContentContextHandler(deps);
      await handler({ type: 'PREPARE_CONTENT_CONTEXT' });
      // resolveCurrentPage **只调一次**（不允许第二次查 tab 切换竞态）
      expect(resolveCurrentPage).toHaveBeenCalledTimes(1);
      // maybeFetchYouTubeTranscript 收到与 resolveCurrentPage 同次的 tabId=42
      const callArgs = maybeFetchYouTubeTranscript.mock.calls[0]?.[0];
      expect(callArgs?.tabId).toBe(42);
    });

    it('metadata 缺失 → 返回 NO_CONTENT_CONTEXT', async () => {
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        fetchMetadataForContext: vi.fn().mockResolvedValue(null),
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: false,
        error: { code: 'NO_CONTENT_CONTEXT', message: '当前内容没有可用的元数据。' },
      });
    });

    it('字幕为空 → 返回 NO_CONTENT_CONTEXT', async () => {
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        cookieProvider: vi.fn().mockResolvedValue('SESSDATA=xxx'),
        fetchMetadataForContext: vi.fn().mockResolvedValue(makeMetadata()),
        fetchSubtitlesForTimeline: vi.fn().mockResolvedValue({
          subtitles: [],
          transcriptSource: 'unknown' satisfies TranscriptSource,
        }),
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: false,
        error: {
          code: 'NO_CONTENT_CONTEXT',
          message: expect.stringMatching(/没有可用字幕/),
        },
      });
    });

    it('B 站未登录且字幕为空 → 提示登录后刷新再试', async () => {
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        cookieProvider: vi.fn().mockResolvedValue(null),
        fetchMetadataForContext: vi.fn().mockResolvedValue(makeMetadata()),
        fetchSubtitlesForTimeline: vi.fn().mockResolvedValue({
          subtitles: [],
          transcriptSource: 'unknown' satisfies TranscriptSource,
        }),
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: false,
        error: {
          code: 'NO_CONTENT_CONTEXT',
          message: expect.stringContaining('B 站未登录时没有返回字幕'),
        },
      });
    });

    it('B 站 fallback 路径：fetchSubtitlesForTimeline 收到 deps.cookieProvider 闭包（**不**复制 cookie 取 cookie 的实现）', async () => {
      const cookieProvider = vi.fn().mockResolvedValue('SESSDATA=xxx; bili_jct=yyy');
      // fetchSubtitlesForTimeline 用精确类型（vi.fn 推断出 Mock 形状，.mock.calls
      // 可直接读，**不**需要 `as unknown as`）。
      const fetchSubtitlesForTimeline = vi.fn(
        async (input: { cookieProvider: (platform: VideoPlatform) => Promise<string | null> }) => {
          // 真实实现内部会调 cookieProvider 拿 B 站登录态 → 这里也调
          await input.cookieProvider('bilibili');
          const transcriptSource: TranscriptSource = 'official';
          return { subtitles: makeCues(), transcriptSource };
        },
      );
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        cookieProvider,
        fetchSubtitlesForTimeline,
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'PREPARE_CONTENT_CONTEXT' };
      await handler(request);
      // 验证 fetchSubtitlesForTimeline 收到的是 deps.cookieProvider 闭包（同一引用）
      const call = fetchSubtitlesForTimeline.mock.calls[0]?.[0];
      expect(call?.cookieProvider).toBe(cookieProvider);
      // 验证 cookieProvider 被 'bilibili' 调过（mock fetchSubtitlesForTimeline 内部调用）
      expect(cookieProvider).toHaveBeenCalledWith('bilibili');
    });
  });

  describe('GET_CACHED_CONTENT_CONTEXT', () => {
    it('无 page context → 返回 CACHED_CONTENT_CONTEXT payload=null', async () => {
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue(null),
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'GET_CACHED_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: true,
        type: 'CACHED_CONTENT_CONTEXT',
        payload: null,
      });
    });

    it('非 B 站 / YouTube → payload=null，不调 loadOrMigrate', async () => {
      const storage = makeStorage();
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({
          tabId: 1,
          context: {
            // 内联构造：exactOptionalPropertyTypes 不允许给可选字段写 `undefined`
            platform: 'unknown',
            url: 'https://example.com/',
            title: '未支持页面',
            detectedAt: 0,
          },
        }),
        storage,
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'GET_CACHED_CONTENT_CONTEXT' };
      const response = await handler(request);
      expect(response).toEqual({
        ok: true,
        type: 'CACHED_CONTENT_CONTEXT',
        payload: null,
      });
      expect(storage.getCachedContentContext).not.toHaveBeenCalled();
    });

    it('支持平台 + 缓存命中 → 透传 payload（**不**调 analysisCache 也不 save）', async () => {
      const cached = makeCacheValue();
      const storage = makeStorage({
        getCachedContentContext: vi.fn().mockResolvedValue(cached),
      });
      const now = vi.fn().mockReturnValue(1_700_000_000_001);
      const deps = makeDeps({
        resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 1, context: makePageContext() }),
        storage,
        now,
      });
      const handler = createContentContextHandler(deps);
      const request: ContentContextRequest = { type: 'GET_CACHED_CONTENT_CONTEXT' };
      const response = await handler(request);
      if (response.ok && response.type === 'CACHED_CONTENT_CONTEXT' && response.payload) {
        expect(response.payload.metadata).toBe(cached.metadata);
        // QA1 必修 B：createdAt/updatedAt 使用注入的 now（**不**写死 0）
        expect(response.payload.createdAt).toBe(1_700_000_000_001);
        expect(response.payload.updatedAt).toBe(1_700_000_000_001);
      } else {
        throw new Error('response 不是 CACHED_CONTENT_CONTEXT 命中响应');
      }
      expect(storage.saveContentContext).not.toHaveBeenCalled();
    });
  });
});

describe('loadCachedContentContext（旧 analysisCache 不再迁移）', () => {
  it('缓存命中 → 返回 CACHED_CONTENT_CONTEXT payload（**不**调 analysisCache 也不 save）', async () => {
    const cached = makeCacheValue();
    const storage = makeStorage({
      getCachedContentContext: vi.fn().mockResolvedValue(cached),
    });
    const result = await loadCachedContentContext(
      { platform: 'bilibili', videoId: 'BV-mock', contentKey: 'BV-mock:p=1' },
      storage,
      () => 1_000,
    );
    expect(storage.saveContentContext).not.toHaveBeenCalled();
    expect(result.type).toBe('CACHED_CONTENT_CONTEXT');
    if (result.type === 'CACHED_CONTENT_CONTEXT' && result.payload) {
      expect(result.payload.transcriptCues).toBe(cached.transcriptCues);
      // QA1 必修 B：createdAt/updatedAt = now() = 1_000（**不**写死 0）
      expect(result.payload.createdAt).toBe(1_000);
      expect(result.payload.updatedAt).toBe(1_000);
    } else {
      throw new Error('expected payload to be non-null');
    }
  });

  it('缓存未命中 + analysisCache 有 transcriptCues → 不迁移，返回 null', async () => {
    const storage = makeStorage({
      getCachedContentContext: vi.fn().mockResolvedValue(null),
    });
    const result = await loadCachedContentContext(
      { platform: 'bilibili', videoId: 'BV-mock', contentKey: 'BV-mock:p=1' },
      storage,
      () => 1_000,
    );
    expect(storage.saveContentContext).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, type: 'CACHED_CONTENT_CONTEXT', payload: null });
  });

  it('analysisCache 缺 transcriptCues → 返回 null（**不**save）', async () => {
    const storage = makeStorage({
      getCachedContentContext: vi.fn().mockResolvedValue(null),
    });
    const result = await loadCachedContentContext(
      { platform: 'bilibili', videoId: 'BV-mock', contentKey: 'BV-mock:p=1' },
      storage,
      () => 1_000,
    );
    expect(storage.saveContentContext).not.toHaveBeenCalled();
    if (result.type === 'CACHED_CONTENT_CONTEXT') {
      expect(result.payload).toBeNull();
    } else {
      throw new Error('expected CACHED_CONTENT_CONTEXT type');
    }
  });

  it('analysisCache metadata 不匹配 → 返回 null（**不**save）', async () => {
    const storage = makeStorage({
      getCachedContentContext: vi.fn().mockResolvedValue(null),
    });
    const result = await loadCachedContentContext(
      { platform: 'bilibili', videoId: 'BV-mock', contentKey: 'BV-mock:p=1' },
      storage,
      () => 1_000,
    );
    expect(storage.saveContentContext).not.toHaveBeenCalled();
    if (result.type === 'CACHED_CONTENT_CONTEXT') {
      expect(result.payload).toBeNull();
    } else {
      throw new Error('expected CACHED_CONTENT_CONTEXT type');
    }
  });
});
