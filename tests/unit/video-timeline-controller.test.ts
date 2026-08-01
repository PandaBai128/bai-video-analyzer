import { describe, expect, it, vi } from 'vitest';
import {
  createVideoTimelineController,
  type VideoTimelineControllerDeps,
} from '@extension/background/video-timeline-controller';
import {
  MinimaxClient,
  MinimaxStreamUnsupportedError,
  type MinimaxChatResult,
  type MinimaxStreamChunk,
} from '@core/llm/minimax-client';
import { getCachedAnalysis, saveCachedAnalysis } from '@core/storage/analysis-cache';
import {
  getCachedContentContext,
  saveContentContext,
} from '@core/storage/content-context-cache';
import { readTextProviderSettings } from '@extension/settings/text-provider-settings';
import { parseVideoAnalysisJson } from '@core/analysis/video-analysis-schema';
import {
  fetchSubtitlesForTimeline,
  isSupportedTimelinePlatform,
  resolveContentContextForTimeline,
} from '@core/analysis/timeline-request-context';
import type { TextProviderSettings } from '@shared/settings';
import type { PageContext } from '@shared/page-context';
import type { VideoTimelinePortMessage } from '@shared/messages';
import type { SubtitleCue, TranscriptSource, VideoAnalysis, VideoMetadata } from '@core/types';

// --- Mocks ---------------------------------------------------------------

vi.mock('@core/storage/analysis-cache', () => ({
  getCachedAnalysis: vi.fn(),
  saveCachedAnalysis: vi.fn(),
}));

// Round 29A 必修 E：mock content-context-cache 模块（controller 调
// `resolveContentContextForTimeline`，里面会调 `getCachedContentContext`）。
// 默认返回 null（缓存未命中），让所有旧测例走原 prefetchYouTubeTranscript +
// fetchSubtitlesForTimeline 路径。命中场景由专门的 'hit' 测例覆盖。
vi.mock('@core/storage/content-context-cache', () => ({
  getCachedContentContext: vi.fn(),
  saveContentContext: vi.fn(),
  createContentContextId: vi.fn(
    (platform: string, contentKey: string) => `${platform}:${contentKey}`,
  ),
}));

vi.mock('@extension/settings/text-provider-settings', () => ({
  readTextProviderSettings: vi.fn(),
}));

vi.mock('@core/analysis/video-analysis-schema', () => ({
  parseVideoAnalysisJson: vi.fn(),
}));

vi.mock('@core/analysis/timeline-request-context', async () => {
  const actual =
    await vi.importActual<typeof import('@core/analysis/timeline-request-context')>(
      '@core/analysis/timeline-request-context',
    );
  return {
    ...actual,
    fetchSubtitlesForTimeline: vi.fn(),
    resolveContentContextForTimeline: vi.fn(),
  };
});

// --- Helpers -------------------------------------------------------------

const SAMPLE_SUBTITLES: SubtitleCue[] = [
  { start: 0, end: 6, text: '今天我们来聊一聊这个话题的背景与起源' },
  { start: 6, end: 12, text: '这是第一部分关于基础概念的开始' },
  { start: 12, end: 18, text: '接下来我们看一下具体的例子以及案例' },
  { start: 18, end: 24, text: '这里有一个非常重要的观点值得说明' },
  { start: 24, end: 30, text: '我们继续深入探讨背后的核心问题' },
  { start: 30, end: 36, text: '下面是一个非常详细的对比分析' },
  { start: 36, end: 42, text: '我们可以看到明显的差异和区别' },
  { start: 42, end: 48, text: '这背后的原因是多方面的复杂因素' },
  { start: 48, end: 54, text: '让我解释一下核心的机制和原理' },
  { start: 54, end: 60, text: '总结一下我们刚才讨论的全部内容' },
];

const SAMPLE_METADATA: VideoMetadata = {
  platform: 'youtube',
  videoId: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Sample',
  author: 'Sample',
  duration: 60,
};

const MEDIUM_METADATA: VideoMetadata = {
  ...SAMPLE_METADATA,
  videoId: 'BV1Nd596vEyU',
  url: 'https://www.bilibili.com/video/BV1Nd596vEyU/',
  title: '全网最全！40分钟全面掌握Codex～【附完整文档】',
  duration: 2451,
};

const MEDIUM_SUBTITLES: SubtitleCue[] = Array.from({ length: 1030 }, (_, index) => ({
  start: index === 1029 ? 2447.54 : index * (2448.6 / 1030),
  end: index === 1029 ? 2448.6 : index * (2448.6 / 1030) + 1,
  text: `40 分钟教程字幕 ${index + 1}`,
}));

const BILIBILI_CTX: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  contentKey: 'BV1xx:p=1',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: 'B 站样例',
  detectedAt: 1,
};

interface Harness {
  controller: ReturnType<typeof createVideoTimelineController>;
  posted: VideoTimelinePortMessage[];
  clientSettings: TextProviderSettings[];
  streamChat: ReturnType<typeof vi.fn>;
  chat: ReturnType<typeof vi.fn>;
}

function buildHarness(input: {
  context: PageContext | null;
  fetchMetadata?: (context: PageContext) => Promise<VideoMetadata | null>;
  prefetched?: import('@core/analysis/timeline-request-context').YouTubePrefetchOutcomeLite;
  subtitles?: readonly SubtitleCue[];
  cachedAnalysis?: unknown;
  settings?: Partial<TextProviderSettings>;
  streamedChunks?: AsyncGenerator<MinimaxStreamChunk, void, void>;
  chatResult?: MinimaxChatResult;
  parseAnalysis?: unknown;
  streamThrows?: unknown;
  chatThrows?: unknown;
  saveCachedThrows?: unknown;
  fetchSubtitlesDurationMs?: number;
  fetchSubtitlesSource?: TranscriptSource;
  fetchSubtitlesLanguage?: string;
  forceRefresh?: boolean;
  cookieHeader?: string | null;
  /** Round 29A 必修 E：注入 contentContext 缓存行为。 */
  contentContext?:
    | { kind: 'miss' }
    | {
        kind: 'hit';
        cached: {
          metadata: VideoMetadata;
          transcriptCues: readonly SubtitleCue[];
          transcriptSource: 'official' | 'asr' | 'page' | 'unknown';
          language?: string;
        };
      };
}): Harness {
  const posted: VideoTimelinePortMessage[] = [];
  const getCachedMock = vi.mocked(getCachedAnalysis);
  const saveCachedMock = vi.mocked(saveCachedAnalysis);
  const readSettingsMock = vi.mocked(readTextProviderSettings);
  const parseMock = vi.mocked(parseVideoAnalysisJson);
  const fetchSubMock = vi.mocked(fetchSubtitlesForTimeline);
  const resolveContentContextMock = vi.mocked(resolveContentContextForTimeline);
  const getCachedContentContextMock = vi.mocked(getCachedContentContext);
  const saveContentContextMock = vi.mocked(saveContentContext);

  getCachedMock.mockReset();
  saveCachedMock.mockReset();
  readSettingsMock.mockReset();
  parseMock.mockReset();
  fetchSubMock.mockReset();
  resolveContentContextMock.mockReset();
  getCachedContentContextMock.mockReset();
  saveContentContextMock.mockReset();

  // 默认 cached 未命中
  getCachedMock.mockResolvedValue(
    (input.cachedAnalysis ?? null) as Awaited<ReturnType<typeof getCachedAnalysis>>,
  );
  saveCachedMock.mockResolvedValue(undefined);
  if (input.saveCachedThrows) {
    saveCachedMock.mockRejectedValue(input.saveCachedThrows);
  }
  const settings: TextProviderSettings = {
    apiKey: input.settings?.apiKey ?? 'sk-test',
    baseUrl: input.settings?.baseUrl ?? 'https://api.minimaxi.com',
    model: input.settings?.model ?? 'MiniMax-M3',
    fastModel: input.settings?.fastModel ?? 'MiniMax-M2.7-highspeed',
    analysisMode: input.settings?.analysisMode ?? 'subtitle',
    thinkingMode: input.settings?.thinkingMode ?? 'disabled',
    webSearchEnabled: input.settings?.webSearchEnabled ?? false,
    updatedAt: input.settings?.updatedAt ?? 1,
  };
  readSettingsMock.mockResolvedValue({ ...settings, ...input.settings });
  parseMock.mockReturnValue(
    (input.parseAnalysis ?? {
      overview: 'o',
      chapters: [],
      timeline: [],
      quotes: [],
      keyConcepts: [],
      inspirations: [],
      coreTakeaways: [],
      reviewSummary: '',
      watchStrategy: [],
      generatedAt: 1,
      modelUsed: 'MiniMax-M2.7-highspeed',
      sourceMode: 'subtitle',
    }) as ReturnType<typeof parseVideoAnalysisJson>,
  );
  fetchSubMock.mockResolvedValue({
    subtitles: input.subtitles ?? SAMPLE_SUBTITLES,
    durationMs: input.fetchSubtitlesDurationMs ?? 100,
    transcriptSource: input.fetchSubtitlesSource ?? 'official',
    ...(input.fetchSubtitlesLanguage ? { language: input.fetchSubtitlesLanguage } : {}),
  });
  // Round 29A 必修 E：默认 contentContext miss（不命中），让所有旧测例走
  // 原 prefetchYouTubeTranscript / fetchSubtitlesForTimeline 路径。命中
  // 场景由专门的 'hit' 测例覆盖。
  if (input.contentContext && input.contentContext.kind === 'hit') {
    resolveContentContextMock.mockResolvedValue({
      kind: 'hit',
      cached: input.contentContext.cached,
    });
    getCachedContentContextMock.mockResolvedValue(input.contentContext.cached);
  } else {
    resolveContentContextMock.mockResolvedValue({
      kind: 'miss',
      reason: 'cache_empty',
    });
    getCachedContentContextMock.mockResolvedValue(null);
  }
  saveContentContextMock.mockResolvedValue(undefined);

  const clientSettings: TextProviderSettings[] = [];
  const streamMock = vi.fn(
    async function* (): AsyncGenerator<MinimaxStreamChunk, void, void> {
      if (input.streamedChunks) {
        yield* input.streamedChunks;
      }
      if (input.streamThrows) {
        throw input.streamThrows;
      }
    },
  );
  const chatMock = input.chatThrows
    ? vi.fn(async () => {
        throw input.chatThrows;
      })
    : vi.fn(async () =>
        input.chatResult ?? {
          content: '{}',
          model: 'MiniMax-M2.7-highspeed',
        },
      );
  const deps: VideoTimelineControllerDeps = {
    resolveActiveVideoContext: async () => input.context,
    fetchMetadataForContext: async () => input.fetchMetadata ? input.fetchMetadata(input.context!) : SAMPLE_METADATA,
    prefetchYouTubeTranscript: async () =>
      input.prefetched ?? { kind: 'skipped' },
    createTextProviderClient: ((settingsArg: TextProviderSettings) => {
      clientSettings.push(settingsArg);
      const client = {
        streamChat: streamMock as unknown as MinimaxClient['streamChat'],
        chat: chatMock as unknown as MinimaxClient['chat'],
      };
      return client as unknown as MinimaxClient;
    }) as VideoTimelineControllerDeps['createTextProviderClient'],
    postMessage: (msg) => {
      posted.push(msg);
    },
    cookieProvider: async () =>
      input.cookieHeader === undefined ? 'SESSDATA=mock' : input.cookieHeader,
    now: () => 1,
  };
  const controller = createVideoTimelineController(deps);
  return { controller, posted, clientSettings, streamChat: streamMock, chat: chatMock };
}

async function* chunkStream(chunks: MinimaxStreamChunk[]): AsyncGenerator<MinimaxStreamChunk, void, void> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeAnalysisFromCueJson(input: {
  content: string;
  subtitles: readonly SubtitleCue[];
  modelUsed?: string;
}): VideoAnalysis {
  const parsed = JSON.parse(input.content) as {
    overview?: string;
    chapters?: Array<{
      startCueId: number;
      endCueId: number;
      title: string;
      summary: string;
      segments?: Array<{
        startCueId: number;
        endCueId: number;
        title: string;
        summary: string;
      }>;
    }>;
  };
  const chapters = (parsed.chapters ?? []).map((chapter) => {
    const start = input.subtitles[chapter.startCueId]?.start ?? 0;
    const end = input.subtitles[chapter.endCueId]?.end ?? input.subtitles[chapter.endCueId]?.start ?? start;
    const segments = (chapter.segments ?? []).map((segment) => {
      const segmentStart = input.subtitles[segment.startCueId]?.start ?? start;
      const segmentEnd =
        input.subtitles[segment.endCueId]?.end ??
        input.subtitles[segment.endCueId]?.start ??
        segmentStart;
      return {
        timestamp: segmentStart,
        endTimestamp: segmentEnd,
        title: segment.title,
        summary: segment.summary,
        importance: 'recommended' as const,
      };
    });
    return {
      timestamp: start,
      endTimestamp: end,
      title: chapter.title,
      summary: chapter.summary,
      importance: 'recommended' as const,
      watchGuide: 'wg',
      segments,
    };
  });
  return {
    overview: parsed.overview ?? 'o',
    chapters,
    timeline: chapters.flatMap((chapter) => chapter.segments),
    quotes: [],
    keyConcepts: [],
    inspirations: [],
    coreTakeaways: [],
    reviewSummary: '',
    watchStrategy: [],
    generatedAt: 1,
    modelUsed: input.modelUsed ?? 'MiniMax-M2.7-highspeed',
    sourceMode: 'subtitle',
  };
}

// --- Tests ---------------------------------------------------------------

describe('createVideoTimelineController (Round 24 必修 A: 时间线流式)', () => {
  it('正常流式：JSONL 事件流 → 推 PARTIAL events + DONE，缓存写入', async () => {
    // Round 24 QA2 必修 B：LLM 输出 JSONL（每行一个完整 JSON object），
    // controller 行 buffer 解析后推 `VIDEO_TIMELINE_PARTIAL` 事件。
    // 不再推 `VIDEO_TIMELINE_CHUNK` 给默认 UI（按 handoff §3 必修 A）。
    const chunks = chunkStream([
      {
        text: '{"type":"overview","text":"这个视频主要讲测试主题。"}\n',
        done: false,
      },
      {
        text: '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"开场","summary":"开场白"}\n',
        done: false,
      },
      {
        text: '{"type":"chapter","id":"c2","startCueId":6,"endCueId":9,"title":"主体","summary":"核心内容"}\n',
        done: false,
      },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
    });
    await harness.controller.handleRequest({
      requestId: 'req-1',
      analysisMode: 'subtitle',
    });
    // STATUS 至少 1 条
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_STATUS')).toBe(true);
    // PARTIAL 事件：3 个（overview + 2 chapter）+ 1 个 done
    const partialMessages = harness.posted.filter(
      (m) => m.type === 'VIDEO_TIMELINE_PARTIAL',
    );
    expect(partialMessages.length).toBeGreaterThanOrEqual(4);
    // 必修 B 验收：不允许默认 CHUNK 给 UI
    const chunkMessages = harness.posted.filter(
      (m) => m.type === 'VIDEO_TIMELINE_CHUNK',
    );
    expect(chunkMessages).toHaveLength(0);
    // DONE 推完
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    // saveCachedAnalysis 被调
    const { saveCachedAnalysis: saveCached } = await import('@core/storage/analysis-cache');
    expect(vi.mocked(saveCached).mock.calls.length).toBe(1);
  });

  it('英文导航生成成功后，缓存分析结果写入 en-US outputLocale', async () => {
    const chunks = chunkStream([
      {
        text: '{"type":"overview","text":"This video explains the test topic."}\n',
        done: false,
      },
      {
        text: '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"Opening","summary":"Introduces the topic."}\n',
        done: false,
      },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
    });

    await harness.controller.handleRequest({
      requestId: 'req-en-locale',
      analysisMode: 'subtitle',
      outputLocale: 'en-US',
    });

    const { getCachedAnalysis: getCached, saveCachedAnalysis: saveCached } =
      await import('@core/storage/analysis-cache');
    expect(vi.mocked(getCached)).toHaveBeenCalledWith(
      expect.objectContaining({ outputLocale: 'en-US' }),
    );
    const saved = vi.mocked(saveCached).mock.calls[0]?.[0];
    expect(saved?.analysis.outputLocale).toBe('en-US');
  });

  it('时间线生成固定关闭 thinking，避免结构化抽取提前命名后文主题', async () => {
    const chunks = chunkStream([
      {
        text: '{"type":"overview","text":"这个视频主要讲测试主题。"}\n',
        done: false,
      },
      {
        text: '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"开场","summary":"开场白"}\n',
        done: false,
      },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      settings: {
        fastModel: 'MiniMax-M3',
        thinkingMode: 'enabled',
      },
    });

    await harness.controller.handleRequest({
      requestId: 'req-thinking-disabled',
      analysisMode: 'subtitle',
    });

    expect(harness.clientSettings).toHaveLength(1);
    expect(harness.clientSettings[0]?.fastModel).toBe('MiniMax-M3');
    expect(harness.clientSettings[0]?.thinkingMode).toBe('disabled');
  });

  it('30 分钟以上视频流式时间线未覆盖字幕尾部时，不保存半截结果并自动非流式重试', async () => {
    const chunks = chunkStream([
      {
        text: '{"type":"overview","text":"这个视频主要讲 Codex。"}\n',
        done: false,
      },
      {
        text:
          '{"type":"chapter","id":"c1","startCueId":0,"endCueId":744,"title":"前半段能力","summary":"只覆盖到 29 分钟左右"}\n',
        done: false,
      },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const fallbackContent = JSON.stringify({
      overview: '这个视频完整讲解 Codex 能力。',
      chapters: [
        {
          startCueId: 0,
          endCueId: 1029,
          title: '完整时间线',
          summary: '覆盖到视频结尾',
          segments: [
            {
              startCueId: 900,
              endCueId: 1029,
              title: '结尾总结',
              summary: '补齐 30 分钟后的内容',
            },
          ],
        },
      ],
    });
    const harness = buildHarness({
      context: BILIBILI_CTX,
      fetchMetadata: async () => MEDIUM_METADATA,
      subtitles: MEDIUM_SUBTITLES,
      streamedChunks: chunks,
      chatResult: {
        content: fallbackContent,
        model: 'MiniMax-M2.7-highspeed',
      },
    });
    vi.mocked(parseVideoAnalysisJson).mockImplementation((input) =>
      makeAnalysisFromCueJson({
        content: input.content,
        subtitles: input.subtitles ?? MEDIUM_SUBTITLES,
        modelUsed: input.modelUsed,
      }),
    );

    await harness.controller.handleRequest({
      requestId: 'req-coverage-retry',
      analysisMode: 'subtitle',
    });

    const { saveCachedAnalysis: saveCached } = await import('@core/storage/analysis-cache');
    expect(vi.mocked(saveCached)).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveCached).mock.calls[0]?.[0];
    expect(saved?.analysis.chapters[0]?.endTimestamp).toBeGreaterThan(2400);
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    const statusTexts = harness.posted
      .filter((m) => m.type === 'VIDEO_TIMELINE_STATUS')
      .map((m) => ('text' in m ? m.text : ''));
    expect(statusTexts.some((text) => text.includes('普通生成'))).toBe(true);
  });

  it('缓存命中：不调用 streamChat，直接推 DONE', async () => {
    const cachedMockValue = {
      metadata: SAMPLE_METADATA,
      analysis: {
        overview: 'cached',
        chapters: [],
        timeline: [],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
        coreTakeaways: [],
        reviewSummary: '',
        watchStrategy: [],
        generatedAt: 1,
        modelUsed: 'MiniMax-M2.7-highspeed',
        sourceMode: 'subtitle',
      },
      subtitleCueCount: 0,
      timings: [],
    };
    const harness = buildHarness({
      context: BILIBILI_CTX,
      cachedAnalysis: cachedMockValue,
    });
    await harness.controller.handleRequest({
      requestId: 'req-2',
      analysisMode: 'subtitle',
    });
    const doneMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_DONE');
    expect(doneMessages).toHaveLength(1);
    const chunkMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_CHUNK');
    expect(chunkMessages).toHaveLength(0);
  });

  it('streamChat 抛 MinimaxStreamUnsupportedError → fallback 到 chat() 走完整 JSON 解析，UI 不收原始 JSON', async () => {
    // Round 24 QA2 必修 D：fallback chat() 拿到完整文本后**不**推 CHUNK 给
    // 默认 UI（按 handoff §3 必修 A：禁止默认展示原始 JSON）。它会走
    // `parseVideoAnalysisJson` 旧路径解析，存 cache，UI 拿 GET_CACHED_ANALYSIS
    // 拿结构化结果。
    const streamErr = new MinimaxStreamUnsupportedError('not SSE', 'plain body');
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamThrows: streamErr,
      chatResult: {
        content: '{"overview":"fallback 测试主题","chapters":[]}',
        model: 'MiniMax-M2.7-highspeed',
      },
    });
    await harness.controller.handleRequest({
      requestId: 'req-fallback',
      analysisMode: 'subtitle',
    });
    // 必修 A：fallback 不推 CHUNK 给 UI
    const chunkMessages = harness.posted.filter(
      (m) => m.type === 'VIDEO_TIMELINE_CHUNK',
    );
    expect(chunkMessages).toHaveLength(0);
    // 推 PARTIAL done（让 side panel 知道流结束）
    const partialMessages = harness.posted.filter(
      (m) => m.type === 'VIDEO_TIMELINE_PARTIAL',
    );
    const donePartials = partialMessages.filter(
      (m) => m.event.type === 'done',
    );
    expect(donePartials.length).toBeGreaterThanOrEqual(1);
    // DONE 推完
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    // STATUS 应包含 fallback 提示
    const statusTexts = harness.posted
      .filter((m) => m.type === 'VIDEO_TIMELINE_STATUS')
      .map((m) => ('text' in m ? m.text : ''));
    expect(statusTexts.some((t) => t.includes('普通生成'))).toBe(true);
  });

  it('streaming reasoning 不进入完整 JSON fallback，避免 thinking 污染解析内容', async () => {
    const chunks = chunkStream([
      {
        text: '',
        reasoning: '我会先思考一个示例 {"type":"overview"}，但这不是最终 JSON。',
        done: false,
      },
      {
        text: '{"overview":"fallback 测试主题","chapters":[]}',
        done: true,
      },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
    });

    await harness.controller.handleRequest({
      requestId: 'req-reasoning-fallback',
      analysisMode: 'subtitle',
    });

    const parseMock = vi.mocked(parseVideoAnalysisJson);
    const parsedContents = parseMock.mock.calls.map((call) => call[0].content);
    expect(parsedContents.length).toBeGreaterThan(0);
    for (const content of parsedContents) {
      expect(content).toContain('"overview":"fallback 测试主题"');
      expect(content).not.toContain('我会先思考');
      expect(content).not.toContain('"type":"overview"');
    }
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
  });

  it('streaming 正文为空但 reasoning 含有效 JSONL 时，用 reasoning 作为最后兜底生成时间线', async () => {
    const chunks = chunkStream([
      {
        text: '',
        reasoning:
          '```jsonl\n' +
          '{"type":"overview","text":"这个视频主要讲 reasoning fallback。"}' +
          '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"开场","summary":"开场白"}\n' +
          '{"type":"done"}\n```',
        done: true,
      },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
    });
    vi.mocked(parseVideoAnalysisJson).mockImplementation((input) => {
      if (input.content.includes('```jsonl')) {
        throw new Error('complete json should fail');
      }
      return {
        overview: 'o',
        chapters: [],
        timeline: [],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
        coreTakeaways: [],
        reviewSummary: '',
        watchStrategy: [],
        generatedAt: 1,
        modelUsed: 'MiniMax-M2.7-highspeed',
        sourceMode: 'subtitle',
      };
    });

    await harness.controller.handleRequest({
      requestId: 'req-reasoning-jsonl',
      analysisMode: 'subtitle',
    });

    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_ERROR')).toBe(false);
    const parsedContents = vi.mocked(parseVideoAnalysisJson).mock.calls.map((call) => call[0].content);
    expect(parsedContents.some((content) => content.includes('"chapters"'))).toBe(true);
  });

  it('自定义 OpenAI-compatible 导航保留流式 JSONL 主路，不退回非流式 chat', async () => {
    const chunks = chunkStream([
      {
        text: '{"type":"overview","text":"本地模型流式导航。"}\n',
        done: false,
      },
      {
        text: '{"type":"chapter","id":"c1","startCueId":0,"endCueId":9,"title":"本地流式","summary":"保留流式输出"}\n',
        done: false,
      },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      settings: {
        activeTextProvider: 'custom-openai-compatible',
        openAiCompatible: {
          providerId: 'custom-openai-compatible',
          apiKey: 'local',
          baseUrl: 'http://127.0.0.1:1234/v1',
          model: 'local-model',
        },
      },
      streamedChunks: chunks,
    });

    await harness.controller.handleRequest({
      requestId: 'req-openai-stream',
      analysisMode: 'subtitle',
    });

    expect(harness.streamChat).toHaveBeenCalledTimes(1);
    expect(harness.chat).not.toHaveBeenCalled();
    const partialMessages = harness.posted.filter(
      (m) => m.type === 'VIDEO_TIMELINE_PARTIAL',
    );
    expect(partialMessages.length).toBeGreaterThanOrEqual(3);
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_ERROR')).toBe(false);
  });

  it('自定义 OpenAI-compatible reasoning-only 流不触发非流式重试，避免等待时间翻倍', async () => {
    const chunks = chunkStream([
      {
        text: '',
        reasoning: '这里只是模型思考，没有最终 JSONL。',
        done: false,
      },
      {
        text: '',
        done: true,
      },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      settings: {
        activeTextProvider: 'custom-openai-compatible',
        openAiCompatible: {
          providerId: 'custom-openai-compatible',
          apiKey: 'local',
          baseUrl: 'http://127.0.0.1:1234/v1',
          model: 'local-model',
        },
      },
      streamedChunks: chunks,
    });

    await harness.controller.handleRequest({
      requestId: 'req-openai-reasoning-only',
      analysisMode: 'subtitle',
    });

    expect(harness.streamChat).toHaveBeenCalledTimes(1);
    expect(harness.chat).not.toHaveBeenCalled();
    const errorMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_ERROR');
    expect(errorMessages).toHaveLength(1);
    const errorMessage = errorMessages[0]?.message ?? '';
    expect(errorMessage).toContain('自定义 OpenAI-compatible');
    expect(errorMessage).toContain('thinking/reasoning');
    expect(errorMessage).not.toContain('MiniMax 返回的内容');
  });

  it('模型返回代码块/说明文字包裹的 JSONL 时，走松散 JSONL fallback 生成时间线', async () => {
    const chunks = chunkStream([
      {
        text:
          '下面是时间线：\n```jsonl\n' +
          '{"type":"overview","text":"这个视频主要讲测试主题。"}' +
          '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"开场","summary":"开场白"}\n' +
          '{"type":"done"}\n```',
        done: true,
      },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
    });
    vi.mocked(parseVideoAnalysisJson).mockImplementation((input) => {
      if (input.content.includes('下面是时间线')) {
        throw new Error('complete json should fail');
      }
      return {
        overview: 'o',
        chapters: [],
        timeline: [],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
        coreTakeaways: [],
        reviewSummary: '',
        watchStrategy: [],
        generatedAt: 1,
        modelUsed: 'MiniMax-M2.7-highspeed',
        sourceMode: 'subtitle',
      };
    });

    await harness.controller.handleRequest({
      requestId: 'req-loose-jsonl',
      analysisMode: 'subtitle',
    });

    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    const errorMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_ERROR');
    expect(errorMessages).toHaveLength(0);
    const parsedContents = vi.mocked(parseVideoAnalysisJson).mock.calls.map((call) => call[0].content);
    expect(parsedContents.some((content) => content.includes('下面是时间线'))).toBe(true);
    expect(parsedContents.some((content) => content.includes('"chapters"'))).toBe(true);
  });

  it('JSONL 中途解析失败后不再按后续 partial 事件直接成功，而是走完整内容 fallback', async () => {
    const chunks = chunkStream([
      {
        text: '{"type":"overview","text":"这个视频主要讲测试主题。"}\n',
        done: false,
      },
      {
        text: '这不是 JSONL\n',
        done: false,
      },
      {
        text:
          '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"开场","summary":"开场白"}\n',
        done: true,
      },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
    });
    vi.mocked(parseVideoAnalysisJson).mockImplementation((input) => {
      if (input.content.includes('这不是 JSONL')) {
        throw new Error('complete json should fail');
      }
      return {
        overview: 'o',
        chapters: [],
        timeline: [],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
        coreTakeaways: [],
        reviewSummary: '',
        watchStrategy: [],
        generatedAt: 1,
        modelUsed: 'MiniMax-M2.7-highspeed',
        sourceMode: 'subtitle',
      };
    });

    await harness.controller.handleRequest({
      requestId: 'req-jsonl-mid-parse-fallback',
      analysisMode: 'subtitle',
    });

    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_ERROR')).toBe(false);
    const parsedContents = vi.mocked(parseVideoAnalysisJson).mock.calls.map((call) => call[0].content);
    expect(parsedContents.some((content) => content.includes('这不是 JSONL'))).toBe(true);
    expect(parsedContents.some((content) => content.includes('"chapters"'))).toBe(true);
  });

  it('流式产物不可解析时自动非流式重试，而不是直接报 JSONL/完整 JSON 解析失败', async () => {
    const chunks = chunkStream([
      {
        text: '这不是 JSONL，也不是完整 JSON。',
        done: true,
      },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      chatResult: {
        content: '{"overview":"非流式重试成功","chapters":[]}',
        model: 'MiniMax-M2.7-highspeed',
      },
    });
    vi.mocked(parseVideoAnalysisJson).mockImplementation((input) => {
      if (input.content.includes('这不是 JSONL')) {
        throw new Error('stream content should fail');
      }
      return {
        overview: 'o',
        chapters: [],
        timeline: [],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
        coreTakeaways: [],
        reviewSummary: '',
        watchStrategy: [],
        generatedAt: 1,
        modelUsed: 'MiniMax-M2.7-highspeed',
        sourceMode: 'subtitle',
      };
    });

    await harness.controller.handleRequest({
      requestId: 'req-stream-parse-retry-chat',
      analysisMode: 'subtitle',
    });

    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_ERROR')).toBe(false);
    const parsedContents = vi.mocked(parseVideoAnalysisJson).mock.calls.map((call) => call[0].content);
    expect(parsedContents.some((content) => content.includes('非流式重试成功'))).toBe(true);
    const statusTexts = harness.posted
      .filter((m) => m.type === 'VIDEO_TIMELINE_STATUS')
      .map((m) => ('text' in m ? m.text : ''));
    expect(statusTexts.some((text) => text.includes('普通生成'))).toBe(true);
  });

  it('新 requestId 进来时 abort 旧 inFlight，旧 chunk 不污染新请求', async () => {
    // 让第一次 streamChat 永远 hang（用个未结束的 generator）
    async function* hangForever(): AsyncGenerator<MinimaxStreamChunk, void, void> {
      // 显式 yield 一次以满足 lint require-yield 规则，然后永远 hang
      yield { text: '', done: false };
      await new Promise<void>(() => {
        // never resolve
      });
    }
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: hangForever(),
    });

    // 第一个请求
    const firstPromise = harness.controller.handleRequest({
      requestId: 'req-old',
      analysisMode: 'subtitle',
    });
    // 给点时间让 controller 进入 inFlight
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 第二个请求应该 abort 第一个
    void harness.controller.handleRequest({
      requestId: 'req-new',
      analysisMode: 'subtitle',
    });
    // 等一会儿让 controller 内部处理 abort
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 第一个请求应该被 abort 不会推任何 chunk
    // （abort signal 触发后 stream 内部抛出 AbortError → 不会走 fallback chat）
    // 关键：旧 requestId 的 chunk 不会被推
    const oldRequestIdChunks = harness.posted.filter(
      (m) => m.type === 'VIDEO_TIMELINE_CHUNK' && 'requestId' in m && m.requestId === 'req-old',
    );
    expect(oldRequestIdChunks).toHaveLength(0);
    // 不 await 第一个 promise 因为它会永远 hang
    void firstPromise.catch(() => {
      // ignore
    });
  });

  it('无 context：推 NO_ACTIVE_TAB 错误', async () => {
    const harness = buildHarness({ context: null });
    await harness.controller.handleRequest({
      requestId: 'req-noctx',
      analysisMode: 'subtitle',
    });
    const errorMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_ERROR');
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]?.code).toBe('NO_ACTIVE_TAB');
  });

  it('无 API Key：推 MINIMAX_API_KEY_MISSING 错误', async () => {
    const harness = buildHarness({
      context: BILIBILI_CTX,
      settings: { apiKey: '  ' },
    });
    await harness.controller.handleRequest({
      requestId: 'req-nokey',
      analysisMode: 'subtitle',
    });
    const errorMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_ERROR');
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]?.code).toBe('MINIMAX_API_KEY_MISSING');
  });

  it('无字幕：推 NO_SUBTITLE 错误', async () => {
    const harness = buildHarness({
      context: BILIBILI_CTX,
      subtitles: [],
      cookieHeader: 'SESSDATA=mock',
    });
    await harness.controller.handleRequest({
      requestId: 'req-nosub',
      analysisMode: 'subtitle',
    });
    const errorMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_ERROR');
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]?.code).toBe('NO_SUBTITLE');
  });

  it('B 站未登录且无字幕：提示登录后刷新再试', async () => {
    const harness = buildHarness({
      context: BILIBILI_CTX,
      subtitles: [],
      cookieHeader: null,
    });
    await harness.controller.handleRequest({
      requestId: 'req-bili-login-subtitle',
      analysisMode: 'subtitle',
    });
    const errorMessages = harness.posted.filter((m) => m.type === 'VIDEO_TIMELINE_ERROR');
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]?.code).toBe('NO_SUBTITLE');
    expect(errorMessages[0]?.message).toContain('B 站未登录时没有返回字幕');
    expect(errorMessages[0]?.message).toContain('登录 B 站后刷新页面再试');
  });

  it('handleDisconnect abort inFlight；handleCancel 只 abort 对应 requestId', async () => {
    async function* hangForever(): AsyncGenerator<MinimaxStreamChunk, void, void> {
      yield { text: '', done: false };
      await new Promise<void>(() => {
        // hang
      });
    }
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: hangForever(),
    });
    const firstPromise = harness.controller.handleRequest({
      requestId: 'req-1',
      analysisMode: 'subtitle',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // cancel 旧 requestId
    harness.controller.handleCancel({ requestId: 'req-1' });
    // 不应再推 chunk
    await new Promise((resolve) => setTimeout(resolve, 10));
    const req1Chunks = harness.posted.filter(
      (m) => m.type === 'VIDEO_TIMELINE_CHUNK' && 'requestId' in m && m.requestId === 'req-1',
    );
    expect(req1Chunks).toHaveLength(0);
    void firstPromise.catch(() => {
      // ignore
    });
  });
});

describe('createVideoTimelineController (Round 29A 必修 E: 复用 contentContext)', () => {
  it('必修 E 验收 1：contentContext 命中时 fetchSubtitlesForTimeline 不被调用', async () => {
    // 命中 contentContext → 跳过 prefetchYouTubeTranscript + fetchSubtitlesForTimeline
    // （关键：不再重复抓字幕）。
    const chunks = chunkStream([
      { text: '{"type":"overview","text":"复用底座测试主题。"}\n', done: false },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      contentContext: {
        kind: 'hit',
        cached: {
          metadata: SAMPLE_METADATA,
          transcriptCues: SAMPLE_SUBTITLES,
          transcriptSource: 'official',
        },
      },
    });
    await harness.controller.handleRequest({
      requestId: 'req-cc-hit',
      analysisMode: 'subtitle',
    });
    // 核心验收：fetchSubtitlesForTimeline 未被调用
    const fetchSubMock = vi.mocked(fetchSubtitlesForTimeline);
    expect(fetchSubMock).not.toHaveBeenCalled();
    // resolveContentContextForTimeline 被调（命中时走 hit 分支）
    const resolveMock = vi.mocked(resolveContentContextForTimeline);
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0]?.[0]).toMatchObject({
      platform: 'bilibili',
      contentKey: BILIBILI_CTX.contentKey,
    });
    // LLM 仍然走完
    expect(harness.posted.some((m) => m.type === 'VIDEO_TIMELINE_DONE')).toBe(true);
    // 命中时**不**应调 saveContentContext（避免覆盖 updatedAt 噪声）
    const saveContentContextMock = vi.mocked(saveContentContext);
    expect(saveContentContextMock).not.toHaveBeenCalled();
  });

  it('contentContext 命中但 metadata 缺少 B 站章节时，会补取新 metadata 作为时间线锚点', async () => {
    const chunks = chunkStream([
      { text: '{"type":"overview","text":"复用底座并补章节。"}\n', done: false },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const freshMetadata: VideoMetadata = {
      ...MEDIUM_METADATA,
      platformChapters: [
        { title: '插件使用', start: 1611, end: 1913 },
        { title: 'Skills', start: 1913, end: 2204 },
      ],
    };
    const fetchMetadata = vi.fn(async () => freshMetadata);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      fetchMetadata,
      contentContext: {
        kind: 'hit',
        cached: {
          metadata: MEDIUM_METADATA,
          transcriptCues: SAMPLE_SUBTITLES,
          transcriptSource: 'official',
        },
      },
    });

    await harness.controller.handleRequest({
      requestId: 'req-cc-refresh-metadata-chapters',
      analysisMode: 'subtitle',
    });

    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    const saveCachedMock = vi.mocked(saveCachedAnalysis);
    expect(saveCachedMock.mock.calls[0]?.[0].metadata.platformChapters).toEqual(
      freshMetadata.platformChapters,
    );
  });

  it('必修 E 验收 2：contentContext 未命中时走原路径 + LLM 成功后调 saveContentContext', async () => {
    // 未命中 → 走 prefetchYouTubeTranscript + fetchSubtitlesForTimeline 旧路径，
    // LLM 成功后调 saveContentContext 写入底座，让后续时间线 / 追问能复用。
    const chunks = chunkStream([
      { text: '{"type":"overview","text":"首次跑测试主题。"}\n', done: false },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      contentContext: { kind: 'miss' },
    });
    await harness.controller.handleRequest({
      requestId: 'req-cc-miss',
      analysisMode: 'subtitle',
    });
    // 旧路径被走：fetchSubtitlesForTimeline 被调
    const fetchSubMock = vi.mocked(fetchSubtitlesForTimeline);
    expect(fetchSubMock).toHaveBeenCalledTimes(1);
    // LLM 成功后调 saveContentContext
    const saveContentContextMock = vi.mocked(saveContentContext);
    expect(saveContentContextMock).toHaveBeenCalledTimes(1);
    const saveCall = saveContentContextMock.mock.calls[0];
    expect(saveCall?.[0]).toMatchObject({
      transcriptCues: SAMPLE_SUBTITLES,
      transcriptSource: 'official',
    });
    expect(saveCall?.[1]).toMatchObject({ contentKey: BILIBILI_CTX.contentKey });
  });

  it('contentContext 未命中时保存实际字幕来源，避免导航生成把 AI 字幕写成官方字幕', async () => {
    const chunks = chunkStream([
      { text: '{"type":"overview","text":"首次跑 AI 字幕来源测试。"}\n', done: false },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      contentContext: { kind: 'miss' },
      fetchSubtitlesSource: 'asr',
      fetchSubtitlesLanguage: 'zh-CN',
    });

    await harness.controller.handleRequest({
      requestId: 'req-cc-miss-asr',
      analysisMode: 'subtitle',
    });

    const saveContentContextMock = vi.mocked(saveContentContext);
    const saveCall = saveContentContextMock.mock.calls[0];
    expect(saveCall?.[0]).toMatchObject({
      transcriptCues: SAMPLE_SUBTITLES,
      transcriptSource: 'asr',
      language: 'zh-CN',
    });
  });

  it('必修 E 验收 3：contentContext 命中时也走 saveCachedAnalysis（含 cues 副本，兼容旧链路）', async () => {
    // 按 handoff 验收 #3：analysisCache 仍然写入（含 cues 副本，兼容旧链路）。
    const chunks = chunkStream([
      { text: '{"type":"overview","text":"复用测试主题。"}\n', done: false },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      contentContext: {
        kind: 'hit',
        cached: {
          metadata: SAMPLE_METADATA,
          transcriptCues: SAMPLE_SUBTITLES,
          transcriptSource: 'official',
        },
      },
    });
    await harness.controller.handleRequest({
      requestId: 'req-cc-save-analysis',
      analysisMode: 'subtitle',
    });
    const { saveCachedAnalysis: saveCached } = await import('@core/storage/analysis-cache');
    expect(vi.mocked(saveCached).mock.calls.length).toBe(1);
    const saveCall = vi.mocked(saveCached).mock.calls[0]?.[0];
    expect(saveCall?.transcriptCues).toEqual(SAMPLE_SUBTITLES);
    expect(saveCall?.subtitleCueCount).toBe(SAMPLE_SUBTITLES.length);
  });

  it('必修 E 验收 4：forceRefresh=true 时跳过 contentContext 命中，强制重新抓字幕', async () => {
    // 强制刷新语义：forceRefresh=true → resolveContentContextForTimeline 返回
    // miss（即使底层缓存还在），controller 走旧抓字幕路径。
    const chunks = chunkStream([
      { text: '{"type":"overview","text":"强制刷新测试主题。"}\n', done: false },
      { text: '{"type":"done"}\n', done: true },
    ]);
    const harness = buildHarness({
      context: BILIBILI_CTX,
      streamedChunks: chunks,
      contentContext: { kind: 'miss' },
      forceRefresh: true,
    });
    await harness.controller.handleRequest({
      requestId: 'req-cc-force',
      analysisMode: 'subtitle',
      forceRefresh: true,
    });
    // 旧路径被走：fetchSubtitlesForTimeline 被调（不命中即说明走了抓字幕）
    const fetchSubMock = vi.mocked(fetchSubtitlesForTimeline);
    expect(fetchSubMock).toHaveBeenCalledTimes(1);
    // LLM 成功后调 saveContentContext 刷新底座
    const saveContentContextMock = vi.mocked(saveContentContext);
    expect(saveContentContextMock).toHaveBeenCalledTimes(1);
  });
});

describe('isSupportedTimelinePlatform (Round 24 必修 A 公共 helper)', () => {
  it('bilibili / youtube → true', () => {
    expect(isSupportedTimelinePlatform('bilibili')).toBe(true);
    expect(isSupportedTimelinePlatform('youtube')).toBe(true);
  });
  it('unknown → false', () => {
    expect(isSupportedTimelinePlatform('unknown')).toBe(false);
  });
});
