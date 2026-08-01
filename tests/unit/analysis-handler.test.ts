import { describe, expect, it, vi } from 'vitest';
import { createAnalysisHandler } from '@extension/background/handlers/analysis-handler';
import type {
  AnalysisHandlerDeps,
  AnalysisRequest,
} from '@extension/background/handlers/analysis-handler';
import type { CachedAnalysisValue } from '@core/storage/analysis-cache';
import type { SubtitleCue, VideoAnalysis, VideoMetadata, VideoPlatform } from '@core/types';
import type { YouTubePrefetchOutcome } from '@extension/background/handlers/content-context-handler';
import type { TextProviderSettings } from '@shared/settings';
import type { ExtensionResponse } from '@shared/messages';
import type { PageContext } from '@shared/page-context';

// ---------------------------------------------------------------------------
// 测试 fixtures 与工厂 helpers
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: TextProviderSettings = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com',
  model: 'test-model',
  fastModel: 'MiniMax-M3',
  analysisMode: 'subtitle',
  thinkingMode: 'enabled',
  webSearchEnabled: false,
  updatedAt: 0,
};

function makePageContext(overrides: Partial<PageContext> = {}): PageContext {
  return {
    platform: 'youtube',
    videoId: 'vid-1',
    url: 'https://www.youtube.com/watch?v=vid-1',
    title: 'mock',
    detectedAt: 0,
    contentKey: 'youtube:vid-1',
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    platform: 'youtube',
    videoId: 'vid-1',
    title: 'mock',
    author: 'mock-author',
    duration: 120,
    url: 'https://www.youtube.com/watch?v=vid-1',
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<VideoAnalysis> = {}): VideoAnalysis {
  return {
    overview: 'mock',
    watchStrategy: [],
    coreTakeaways: [],
    reviewSummary: '',
    chapters: [],
    timeline: [],
    quotes: [],
    keyConcepts: [],
    inspirations: [],
    generatedAt: 0,
    modelUsed: 'test',
    sourceMode: 'subtitle',
    ...overrides,
  };
}

function makeCachedValue(overrides: Partial<CachedAnalysisValue> = {}): CachedAnalysisValue {
  return {
    metadata: makeMetadata(),
    analysis: makeAnalysis(),
    subtitleCueCount: 0,
    transcriptCues: [],
    timings: [],
    ...overrides,
  };
}

function makePrefetchOk(
  overrides: Partial<Extract<YouTubePrefetchOutcome, { kind: 'ok' }>> = {},
): Extract<YouTubePrefetchOutcome, { kind: 'ok' }> {
  return {
    kind: 'ok',
    transcript: {
      metadata: makeMetadata(),
      cues: [] as SubtitleCue[],
    },
    attempts: [{ stage: 'dom_panel', durationMs: 100 }],
    ...overrides,
  };
}

function makePrefetchError(
  code = 'NO_CAPTION_TRACKS',
): Extract<YouTubePrefetchOutcome, { kind: 'business_error' }> {
  return {
    kind: 'business_error',
    error: { code, message: `mock-${code}` },
  };
}

/** 默认 makeDeps：所有依赖都是 vi.fn()，不预设行为。 */
function makeDeps(overrides: Partial<AnalysisHandlerDeps> = {}): AnalysisHandlerDeps {
  return {
    resolveCurrentPage: vi.fn().mockResolvedValue({
      tabId: 7,
      context: makePageContext(),
    }),
    getActiveVideoContext: vi.fn().mockResolvedValue({
      platform: 'youtube' as VideoPlatform,
      videoId: 'vid-1',
      contentKey: 'youtube:vid-1',
    }),
    readTextProviderSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    deriveContentKey: vi.fn(
      (ctx: PageContext) => ctx.contentKey ?? `${ctx.platform}:${ctx.videoId}`,
    ),
    analysisModeToSourceMode: vi.fn().mockReturnValue(undefined),
    getCachedAnalysis: vi.fn().mockResolvedValue(null),
    maybeFetchYouTubeTranscript: vi.fn().mockResolvedValue({ kind: 'skipped' as const }),
    analyzeVideo: vi.fn().mockResolvedValue({
      ok: true as const,
      value: makeCachedValue(),
    }),
    cookieProvider: vi.fn().mockResolvedValue(null),
    saveCachedAnalysis: vi.fn().mockResolvedValue(undefined),
    createErrorResponse: (code: string, message: string): ExtensionResponse => ({
      ok: false,
      error: { code, message },
    }),
    ...overrides,
  };
}

function asRequest(req: AnalysisRequest) {
  return req;
}

// ---------------------------------------------------------------------------
// REQUEST_ANALYSIS
// ---------------------------------------------------------------------------

describe('createAnalysisHandler — REQUEST_ANALYSIS', () => {
  it('resolveCurrentPage 返回 null → NO_ACTIVE_TAB', async () => {
    const deps = makeDeps({ resolveCurrentPage: vi.fn().mockResolvedValue(null) });
    const handler = createAnalysisHandler(deps);
    const response = await handler(
      asRequest({ type: 'REQUEST_ANALYSIS', payload: { analysisMode: 'subtitle' } }),
    );
    expect(response).toEqual({
      ok: false,
      error: { code: 'NO_ACTIVE_TAB', message: '没有找到当前标签页' },
    });
    expect(deps.analyzeVideo).not.toHaveBeenCalled();
  });

  it('context 为 null → NO_PAGE_CONTEXT', async () => {
    const deps = makeDeps({
      resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 7, context: null }),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_ANALYSIS' }));
    expect(response).toEqual({
      ok: false,
      error: { code: 'NO_PAGE_CONTEXT', message: '还没有检测到当前视频页面' },
    });
    expect(deps.analyzeVideo).not.toHaveBeenCalled();
  });

  it('API Key 为空 → MINIMAX_API_KEY_MISSING，不调缓存 / 不调 analyze', async () => {
    const deps = makeDeps({
      readTextProviderSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: '  ' }),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_ANALYSIS' }));
    expect(response).toEqual({
      ok: false,
      error: { code: 'MINIMAX_API_KEY_MISSING', message: '请先在设置中配置当前文本模型 API Key' },
    });
    expect(deps.getCachedAnalysis).not.toHaveBeenCalled();
    expect(deps.analyzeVideo).not.toHaveBeenCalled();
  });

  it('未传 analysisMode 且缓存未命中 → getCachedAnalysis 不带 sourceMode', async () => {
    const getCachedAnalysis = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({ getCachedAnalysis });
    const handler = createAnalysisHandler(deps);
    await handler(asRequest({ type: 'REQUEST_ANALYSIS' }));
    expect(getCachedAnalysis).toHaveBeenCalledWith({
      platform: 'youtube',
      videoId: 'vid-1',
      contentKey: 'youtube:vid-1',
      outputLocale: 'zh-CN',
      subtitlePreferenceKey: 'zh-cn,en-us',
    });
  });

  it('传 analysisMode=subtitle → getCachedAnalysis 带 sourceMode=subtitle', async () => {
    const getCachedAnalysis = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      getCachedAnalysis,
      analysisModeToSourceMode: vi.fn().mockReturnValue('subtitle' as VideoAnalysis['sourceMode']),
    });
    const handler = createAnalysisHandler(deps);
    await handler(asRequest({ type: 'REQUEST_ANALYSIS', payload: { analysisMode: 'subtitle' } }));
    expect(deps.analysisModeToSourceMode).toHaveBeenCalledWith('subtitle');
    expect(getCachedAnalysis).toHaveBeenCalledWith({
      platform: 'youtube',
      videoId: 'vid-1',
      contentKey: 'youtube:vid-1',
      sourceMode: 'subtitle',
      outputLocale: 'zh-CN',
      subtitlePreferenceKey: 'zh-cn,en-us',
    });
  });

  it('forceRefresh=true → 跳过 getCachedAnalysis', async () => {
    const getCachedAnalysis = vi.fn();
    const deps = makeDeps({ getCachedAnalysis });
    const handler = createAnalysisHandler(deps);
    await handler(asRequest({ type: 'REQUEST_ANALYSIS', payload: { forceRefresh: true } }));
    expect(getCachedAnalysis).not.toHaveBeenCalled();
  });

  it('缓存命中 → 返回 ANALYSIS_RESULT，**不**调 analyzeVideo', async () => {
    const cached = makeCachedValue({ subtitleCueCount: 5 });
    const deps = makeDeps({
      getCachedAnalysis: vi.fn().mockResolvedValue(cached),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(
      asRequest({ type: 'REQUEST_ANALYSIS', payload: { analysisMode: 'subtitle' } }),
    );
    expect(response).toEqual({ ok: true, type: 'ANALYSIS_RESULT', payload: cached });
    expect(deps.analyzeVideo).not.toHaveBeenCalled();
    expect(deps.saveCachedAnalysis).not.toHaveBeenCalled();
  });

  it('缓存未命中 → **无条件**调 prefetch（传 effective mode），analyze 成功 → save + return', async () => {
    const maybeFetchYouTubeTranscript = vi.fn().mockResolvedValue(makePrefetchOk());
    const analyzeVideo = vi.fn().mockResolvedValue({
      ok: true as const,
      value: makeCachedValue({ subtitleCueCount: 7 }),
    });
    const saveCachedAnalysis = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      maybeFetchYouTubeTranscript,
      analyzeVideo,
      saveCachedAnalysis,
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(
      asRequest({ type: 'REQUEST_ANALYSIS', payload: { analysisMode: 'subtitle' } }),
    );
    // REQUEST_ANALYSIS **无条件**调 prefetch，传 effective mode（不是固定 'subtitle'）
    expect(maybeFetchYouTubeTranscript).toHaveBeenCalledTimes(1);
    expect(maybeFetchYouTubeTranscript).toHaveBeenCalledWith({
      context: expect.objectContaining({ platform: 'youtube', videoId: 'vid-1' }),
      tabId: 7,
      analysisMode: 'subtitle',
      subtitleLanguages: [],
    });
    // analyzeVideo 收到 prefetchedTranscript（attempts → timings）
    expect(analyzeVideo).toHaveBeenCalledTimes(1);
    const analyzeArg = analyzeVideo.mock.calls[0]?.[0] as Parameters<typeof analyzeVideo>[0];
    expect(analyzeArg.usageFeature).toBe('analysis');
    expect(analyzeArg.prefetchedTranscript).toBeDefined();
    expect(analyzeArg.prefetchedTranscript?.timings).toEqual([
      { stage: 'dom_panel', durationMs: 100 },
    ]);
    expect(saveCachedAnalysis).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      type: 'ANALYSIS_RESULT',
      payload: expect.objectContaining({ subtitleCueCount: 7 }),
    });
  });

  it('prefetch 返回 business_error → 透传错误，**不**调 analyzeVideo', async () => {
    const analyzeVideo = vi.fn();
    const deps = makeDeps({
      maybeFetchYouTubeTranscript: vi
        .fn()
        .mockResolvedValue(makePrefetchError('NO_CAPTION_TRACKS')),
      analyzeVideo,
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_ANALYSIS' }));
    expect(response).toEqual({
      ok: false,
      error: { code: 'NO_CAPTION_TRACKS', message: 'mock-NO_CAPTION_TRACKS' },
    });
    expect(analyzeVideo).not.toHaveBeenCalled();
  });

  it('analyzeVideo 返回 !ok → 透传错误，**不**调 saveCachedAnalysis', async () => {
    const saveCachedAnalysis = vi.fn();
    const deps = makeDeps({
      analyzeVideo: vi.fn().mockResolvedValue({
        ok: false as const,
        error: { code: 'LLM_ERROR', message: 'mock-llm-fail' },
      }),
      saveCachedAnalysis,
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_ANALYSIS' }));
    expect(response).toEqual({
      ok: false,
      error: { code: 'LLM_ERROR', message: 'mock-llm-fail' },
    });
    expect(saveCachedAnalysis).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// REQUEST_TIMELINE
// ---------------------------------------------------------------------------

describe('createAnalysisHandler — REQUEST_TIMELINE', () => {
  it('resolveCurrentPage 返回 null → NO_ACTIVE_TAB', async () => {
    const deps = makeDeps({ resolveCurrentPage: vi.fn().mockResolvedValue(null) });
    const handler = createAnalysisHandler(deps);
    const response = await handler(
      asRequest({ type: 'REQUEST_TIMELINE', payload: { analysisMode: 'subtitle' } }),
    );
    expect(response).toEqual({
      ok: false,
      error: { code: 'NO_ACTIVE_TAB', message: '没有找到当前标签页' },
    });
  });

  it('context 为 null → NO_PAGE_CONTEXT', async () => {
    const deps = makeDeps({
      resolveCurrentPage: vi.fn().mockResolvedValue({ tabId: 7, context: null }),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_TIMELINE' }));
    expect(response).toEqual({
      ok: false,
      error: { code: 'NO_PAGE_CONTEXT', message: '还没有检测到当前视频页面' },
    });
  });

  it('API Key 为空 → MINIMAX_API_KEY_MISSING', async () => {
    const deps = makeDeps({
      readTextProviderSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, apiKey: '' }),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_TIMELINE' }));
    expect(response).toEqual({
      ok: false,
      error: { code: 'MINIMAX_API_KEY_MISSING', message: '请先在设置中配置当前文本模型 API Key' },
    });
    expect(deps.getCachedAnalysis).not.toHaveBeenCalled();
  });

  it(
    '未传 analysisMode → 用 settings.analysisMode=' +
      "'subtitle'" +
      ' 查缓存（带 sourceMode=subtitle）',
    async () => {
      const getCachedAnalysis = vi.fn().mockResolvedValue(null);
      const deps = makeDeps({
        getCachedAnalysis,
        analysisModeToSourceMode: vi
          .fn()
          .mockReturnValue('subtitle' as VideoAnalysis['sourceMode']),
      });
      const handler = createAnalysisHandler(deps);
      await handler(asRequest({ type: 'REQUEST_TIMELINE' }));
      // timeline 永远把 effective mode 喂给 map
      expect(deps.analysisModeToSourceMode).toHaveBeenCalledWith('subtitle');
      expect(getCachedAnalysis).toHaveBeenCalledWith({
        platform: 'youtube',
        videoId: 'vid-1',
        contentKey: 'youtube:vid-1',
        sourceMode: 'subtitle',
        outputLocale: 'zh-CN',
        subtitlePreferenceKey: 'zh-cn,en-us',
      });
    },
  );

  it('传旧 analysisMode=multimodal → 返回 UNSUPPORTED_ANALYSIS_MODE', async () => {
    const getCachedAnalysis = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      getCachedAnalysis,
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(
      asRequest({ type: 'REQUEST_TIMELINE', payload: { analysisMode: 'multimodal' } }),
    );
    expect(response).toEqual({
      ok: false,
      error: {
        code: 'UNSUPPORTED_ANALYSIS_MODE',
        message: '公开版只支持快速字幕分析；本地转写和视频理解实验已从公开版移除。',
      },
    });
    expect(getCachedAnalysis).not.toHaveBeenCalled();
  });

  it('传旧 analysisMode=multimodal → 不调 prefetch / analyzeVideo', async () => {
    const maybeFetchYouTubeTranscript = vi.fn();
    const analyzeVideo = vi.fn().mockResolvedValue({
      ok: true as const,
      value: makeCachedValue(),
    });
    const deps = makeDeps({
      maybeFetchYouTubeTranscript,
      analyzeVideo,
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(
      asRequest({ type: 'REQUEST_TIMELINE', payload: { analysisMode: 'multimodal' } }),
    );
    expect(maybeFetchYouTubeTranscript).not.toHaveBeenCalled();
    expect(analyzeVideo).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_ANALYSIS_MODE' },
    });
  });

  it(
    'analysisMode=subtitle（settings 默认） → 调 prefetch 固定传 analysisMode=' +
      "'subtitle'" +
      '，analyzeVideo 带 prefetchedTranscript',
    async () => {
      const maybeFetchYouTubeTranscript = vi.fn().mockResolvedValue(makePrefetchOk());
      const analyzeVideo = vi.fn().mockResolvedValue({
        ok: true as const,
        value: makeCachedValue(),
      });
      const deps = makeDeps({
        maybeFetchYouTubeTranscript,
        analyzeVideo,
        // settings 默认 subtitle
        getCachedAnalysis: vi.fn().mockResolvedValue(null),
      });
      const handler = createAnalysisHandler(deps);
      await handler(asRequest({ type: 'REQUEST_TIMELINE' }));
      expect(maybeFetchYouTubeTranscript).toHaveBeenCalledTimes(1);
      // timeline 调 prefetch 固定传 'subtitle'，不是 effective mode
      expect(maybeFetchYouTubeTranscript).toHaveBeenCalledWith({
        context: expect.objectContaining({ platform: 'youtube', videoId: 'vid-1' }),
        tabId: 7,
        analysisMode: 'subtitle',
        subtitleLanguages: [],
      });
      const analyzeArg = analyzeVideo.mock.calls[0]?.[0] as Parameters<typeof analyzeVideo>[0];
      expect(analyzeArg.usageFeature).toBe('navigation');
      expect(analyzeArg.prefetchedTranscript).toBeDefined();
    },
  );

  it('prefetch business_error → 透传错误，**不**调 analyzeVideo', async () => {
    const analyzeVideo = vi.fn();
    const deps = makeDeps({
      maybeFetchYouTubeTranscript: vi.fn().mockResolvedValue(makePrefetchError('UNPLAYABLE')),
      analyzeVideo,
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_TIMELINE' }));
    expect(response).toEqual({
      ok: false,
      error: { code: 'UNPLAYABLE', message: 'mock-UNPLAYABLE' },
    });
    expect(analyzeVideo).not.toHaveBeenCalled();
  });

  it('B 站未登录且 analyzeVideo 返回 NO_SUBTITLE → 提示登录后刷新再试', async () => {
    const analyzeVideo = vi.fn().mockResolvedValue({
      ok: false as const,
      error: {
        code: 'NO_SUBTITLE',
        message: '当前视频没有可用字幕。稳定时间线需要字幕。',
        retryable: false,
      },
    });
    const deps = makeDeps({
      resolveCurrentPage: vi.fn().mockResolvedValue({
        tabId: 7,
        context: makePageContext({
          platform: 'bilibili',
          videoId: 'BV-mock',
          url: 'https://www.bilibili.com/video/BV-mock',
          contentKey: 'BV-mock:p=1',
        }),
      }),
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
      analyzeVideo,
      cookieProvider: vi.fn().mockResolvedValue(null),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'REQUEST_TIMELINE' }));
    expect(response).toEqual({
      ok: false,
      error: {
        code: 'NO_SUBTITLE',
        message: expect.stringContaining('B 站未登录时没有返回字幕'),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// GET_CACHED_ANALYSIS
// ---------------------------------------------------------------------------

describe('createAnalysisHandler — GET_CACHED_ANALYSIS', () => {
  it('无 active video context → 返回 CACHED_ANALYSIS payload=null，**不**调缓存', async () => {
    const getCachedAnalysis = vi.fn();
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue(null),
      getCachedAnalysis,
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'GET_CACHED_ANALYSIS' }));
    expect(response).toEqual({ ok: true, type: 'CACHED_ANALYSIS', payload: null });
    expect(getCachedAnalysis).not.toHaveBeenCalled();
  });

  it('active video context 缺 videoId → 返回 null，**不**调缓存依赖', async () => {
    const getCachedAnalysis = vi.fn();
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue({
        platform: 'youtube',
        videoId: '',
        contentKey: 'k',
      }),
      getCachedAnalysis,
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'GET_CACHED_ANALYSIS' }));
    expect(response).toEqual({ ok: true, type: 'CACHED_ANALYSIS', payload: null });
    expect(getCachedAnalysis).not.toHaveBeenCalled();
  });

  it('未传 analysisMode → getCachedAnalysis 参数**不**含 sourceMode', async () => {
    const getCachedAnalysis = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue({
        platform: 'youtube',
        videoId: 'vid-1',
        contentKey: 'youtube:vid-1',
      }),
      getCachedAnalysis,
    });
    const handler = createAnalysisHandler(deps);
    await handler(asRequest({ type: 'GET_CACHED_ANALYSIS' }));
    expect(getCachedAnalysis).toHaveBeenCalledWith({
      platform: 'youtube',
      videoId: 'vid-1',
      contentKey: 'youtube:vid-1',
      outputLocale: 'zh-CN',
      subtitlePreferenceKey: 'zh-cn,en-us',
    });
  });

  it('analysisMode 映射返回 undefined → 仍不传 sourceMode', async () => {
    const getCachedAnalysis = vi.fn().mockResolvedValue(null);
    const analysisModeToSourceMode = vi.fn().mockReturnValue(undefined);
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue({
        platform: 'youtube',
        videoId: 'vid-1',
        contentKey: 'youtube:vid-1',
      }),
      getCachedAnalysis,
      analysisModeToSourceMode,
    });
    const handler = createAnalysisHandler(deps);
    await handler(
      asRequest({ type: 'GET_CACHED_ANALYSIS', payload: { analysisMode: 'subtitle' } }),
    );
    expect(analysisModeToSourceMode).toHaveBeenCalledWith('subtitle');
    expect(getCachedAnalysis).toHaveBeenCalledWith({
      platform: 'youtube',
      videoId: 'vid-1',
      contentKey: 'youtube:vid-1',
      outputLocale: 'zh-CN',
      subtitlePreferenceKey: 'zh-cn,en-us',
    });
  });

  it('GET_CACHED_ANALYSIS 传旧 analysisMode=multimodal → 返回 null 且不查缓存', async () => {
    const getCachedAnalysis = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue({
        platform: 'youtube',
        videoId: 'vid-1',
        contentKey: 'youtube:vid-1',
      }),
      getCachedAnalysis,
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(
      asRequest({ type: 'GET_CACHED_ANALYSIS', payload: { analysisMode: 'multimodal' } }),
    );
    expect(response).toEqual({ ok: true, type: 'CACHED_ANALYSIS', payload: null });
    expect(getCachedAnalysis).not.toHaveBeenCalled();
  });

  it('getCachedAnalysis 返回缓存 → payload 引用透传', async () => {
    const cached = makeCachedValue();
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue({
        platform: 'youtube',
        videoId: 'vid-1',
        contentKey: 'youtube:vid-1',
      }),
      getCachedAnalysis: vi.fn().mockResolvedValue(cached),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'GET_CACHED_ANALYSIS' }));
    if (response.ok && response.type === 'CACHED_ANALYSIS') {
      expect(response.payload).toBe(cached);
    } else {
      throw new Error('response 不是 CACHED_ANALYSIS 成功响应');
    }
  });

  it('getCachedAnalysis 返回 null → payload 原样为 null', async () => {
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue({
        platform: 'youtube',
        videoId: 'vid-1',
        contentKey: 'youtube:vid-1',
      }),
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createAnalysisHandler(deps);
    const response = await handler(asRequest({ type: 'GET_CACHED_ANALYSIS' }));
    expect(response).toEqual({ ok: true, type: 'CACHED_ANALYSIS', payload: null });
  });
});
