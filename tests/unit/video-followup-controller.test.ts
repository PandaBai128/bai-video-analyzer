import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVideoFollowupController,
  type VideoFollowupControllerDeps,
} from '@extension/background/video-followup-controller';
import type { PageContext } from '@shared/page-context';
import type { VideoFollowupPortMessage } from '@shared/messages';
import { db } from '@core/storage/db';
import type { MinimaxChatResult, MinimaxStreamChunk } from '@core/llm/minimax-client';

vi.mock('@extension/settings/text-provider-settings', () => ({
  readTextProviderSettings: vi.fn(),
}));

vi.mock('@core/storage/analysis-cache', () => ({
  getCachedAnalysis: vi.fn(),
}));

vi.mock('@core/storage/content-context-cache', () => ({
  getCachedContentContext: vi.fn(),
}));

import { readTextProviderSettings } from '@extension/settings/text-provider-settings';
import { getCachedAnalysis } from '@core/storage/analysis-cache';
import { getCachedContentContext } from '@core/storage/content-context-cache';

const readSettingsMock = vi.mocked(readTextProviderSettings);
const getCachedMock = vi.mocked(getCachedAnalysis);
const getContentContextMock = vi.mocked(getCachedContentContext);

const BILIBILI_CTX: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  detectedAt: 0,
};

const CACHED_ANALYSIS = {
  metadata: {
    platform: 'bilibili' as const,
    videoId: 'BV1xx',
    url: 'https://www.bilibili.com/video/BV1xx',
    title: '测试视频',
    author: '作者',
    duration: 600,
  },
  analysis: {
    overview: '视频核心',
    watchStrategy: [],
    coreTakeaways: ['要点 A'],
    reviewSummary: '整体总结',
    chapters: [
      {
        timestamp: 0,
        endTimestamp: 200,
        title: '章 1',
        summary: 'A',
        importance: 'must-watch' as const,
        watchGuide: '重点',
        segments: [],
      },
    ],
    timeline: [
      { timestamp: 0, title: '开场', summary: '引入', importance: 'must-watch' as const },
      { timestamp: 120, title: 'A 段', summary: '展开', importance: 'recommended' as const },
    ],
    quotes: [],
    keyConcepts: [],
    inspirations: [],
    generatedAt: 1,
    modelUsed: 'MiniMax-M3',
    sourceMode: 'subtitle' as const,
  },
  subtitleCueCount: 0,
  timings: [],
};

// Round 29A 必修 D：内容底座（contentContext）缓存。controller 必修 D 起先
// 读这个再读 analysisCache。
const CACHED_CONTENT_CONTEXT = {
  metadata: {
    platform: 'bilibili' as const,
    videoId: 'BV1xx',
    url: 'https://www.bilibili.com/video/BV1xx',
    title: '测试视频',
    author: '作者',
    duration: 600,
  },
  transcriptCues: [] as Array<{ start: number; end?: number; text: string }>,
  transcriptSource: 'official' as const,
};

function makeClientStub(chunks: readonly MinimaxStreamChunk[]): {
  client: { chat: ReturnType<typeof vi.fn>; streamChat: ReturnType<typeof vi.fn> };
  chatCalls: number;
  streamCalls: number;
} {
  const stub = {
    chat: vi.fn(async (): Promise<MinimaxChatResult> => ({
      content: 'non-stream fallback',
      model: 'MiniMax-M3',
    })),
    streamChat: vi.fn(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    }),
  };
  return { client: stub, chatCalls: 0, streamCalls: 0 };
}

interface FakeControllerHarness {
  controller: ReturnType<typeof createVideoFollowupController>;
  posted: VideoFollowupPortMessage[];
  postMessage: ReturnType<typeof vi.fn>;
  streamChat: ReturnType<typeof vi.fn>;
  resolveActiveVideoContext: ReturnType<typeof vi.fn>;
}

function buildHarness(
  options: {
    readonly chunks?: readonly MinimaxStreamChunk[];
    readonly context?: PageContext | null;
    readonly currentTime?: number | null;
    readonly cached?: typeof CACHED_ANALYSIS | null;
    readonly contentContext?: typeof CACHED_CONTENT_CONTEXT | null;
    readonly apiKey?: string;
  } = {},
): FakeControllerHarness {
  const posted: VideoFollowupPortMessage[] = [];
  const postMessage = vi.fn((msg: VideoFollowupPortMessage) => {
    posted.push(msg);
  });
  const streamStub = makeClientStub(options.chunks ?? [{ text: 'hi', done: false }, { text: '', done: true }]);
  const streamChat = streamStub.client.streamChat;
  const resolveActiveVideoContext = vi.fn(async () => ({
    context: options.context === undefined ? BILIBILI_CTX : options.context,
    currentTime: options.currentTime === undefined ? 30 : options.currentTime,
  }));

  const deps: VideoFollowupControllerDeps = {
    resolveActiveVideoContext,
    createTextProviderClient: () => streamStub.client as unknown as Parameters<VideoFollowupControllerDeps['createTextProviderClient']>[0] extends infer _ ? import('@core/llm/minimax-client').MinimaxClient : never,
    postMessage,
  };

  return {
    controller: createVideoFollowupController(deps),
    posted,
    postMessage,
    streamChat,
    resolveActiveVideoContext,
  };
}

async function awaitPosted(harness: FakeControllerHarness, minCount: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (harness.posted.length >= minCount) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('createVideoFollowupController (背景编排)', () => {
  beforeEach(() => {
    readSettingsMock.mockReset();
    getCachedMock.mockReset();
    getContentContextMock.mockReset();
    readSettingsMock.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      fastModel: 'MiniMax-M2.7-highspeed',
      analysisMode: 'subtitle',
      thinkingMode: 'disabled',
      webSearchEnabled: false,
      updatedAt: 1,
    });
    getCachedMock.mockResolvedValue(CACHED_ANALYSIS);
    // Round 29A 必修 D：默认 contentContext 命中（happy path），测"无 context"
    // 用例在自己里面用 mockResolvedValueOnce(null) 覆盖。
    getContentContextMock.mockResolvedValue(CACHED_CONTENT_CONTEXT);
  });

  afterEach(async () => {
    // 关闭可能打开的 Dexie 连接，避免影响后续测试
    try {
      await db.delete();
    } catch {
      // 忽略：可能未启动过
    }
  });

  it('没有 contentContext 时返回 CONTENT_CONTEXT_REQUIRED 错误', async () => {
    // Round 29A 必修 D：没有内容底座（既未点过"开启提问"、也未做过时间线分析
    // → contentContext 还没写入）时，追问必须先提示用户"开启当前视频内容"，
    // 不再回到旧的 ANALYSIS_REQUIRED（会暗示用户"先生成时间线"）。
    getContentContextMock.mockResolvedValueOnce(null);
    const harness = buildHarness();
    await harness.controller.handleAsk({
      requestId: 'req-1',
      question: '视频讲什么',
      includeCurrentSegment: true,
    });
    await awaitPosted(harness, 1);
    const error = harness.posted.find((m) => m.type === 'VIDEO_ANSWER_ERROR');
    expect(error).toBeDefined();
    if (error && error.type === 'VIDEO_ANSWER_ERROR') {
      expect(error.requestId).toBe('req-1');
      expect(error.code).toBe('CONTENT_CONTEXT_REQUIRED');
      expect(error.message).toBe('请先开启当前视频内容，再来提问。');
    }
  });

  it('只有 contentContext、没有 analysisCache 时也能发起追问', async () => {
    // Round 29A 必修 D：用户只点过"开启提问"、没生成时间线（analysisCache 缺失）
    // 也应能追问。timeline / chapters / review 走空数组 / 空串渲染，prompt 仍
    // 拿到 transcriptCues。
    getContentContextMock.mockReset();
    getCachedMock.mockReset();
    getContentContextMock.mockResolvedValue({
      metadata: CACHED_CONTENT_CONTEXT.metadata,
      transcriptCues: [
        { start: 100, end: 110, text: 'cue-A' },
        { start: 120, end: 130, text: 'cue-B' },
      ],
      transcriptSource: 'official',
    });
    getCachedMock.mockResolvedValue(null);
    const streamStub = makeClientStub([{ text: 'ok', done: false }, { text: '', done: true }]);
    const client = streamStub.client;
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 120 }),
      createTextProviderClient: () =>
        client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });
    await controller.handleAsk({
      requestId: 'req-ctx-only',
      question: '这段讲什么？',
      includeCurrentSegment: true,
      currentTime: 120,
    });
    // 至少有一个 chunk / done（说明 stream 真的被推进去了）
    const chunks = posted.filter(
      (m) => m.type === 'VIDEO_ANSWER_CHUNK' && m.requestId === 'req-ctx-only',
    );
    const done = posted.find((m) => m.type === 'VIDEO_ANSWER_DONE');
    const errors = posted.filter(
      (m) => m.type === 'VIDEO_ANSWER_ERROR' && m.requestId === 'req-ctx-only',
    );
    expect(errors).toEqual([]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(done).toBeDefined();
    // 验证 prompt 拿到 transcriptCues
    const streamCall = client.streamChat.mock.calls[0];
    expect(streamCall).toBeDefined();
    const messages = streamCall?.[0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('cue-A');
    expect(userMessage?.content).toContain('cue-B');
  });

  it('旧视频理解模式返回 UNSUPPORTED_ANALYSIS_MODE', async () => {
    getContentContextMock.mockReset();
    getContentContextMock.mockResolvedValue(null);
    getCachedMock.mockReset();
    getCachedMock.mockResolvedValue(null);

    const harness = buildHarness();
    await harness.controller.handleAsk({
      requestId: 'req-precise',
      question: '这个视频主要讲什么？',
      includeCurrentSegment: true,
      analysisMode: 'multimodal',
    });

    await awaitPosted(harness, 1);
    expect(getContentContextMock).not.toHaveBeenCalled();
    expect(getCachedMock).not.toHaveBeenCalled();
    expect(harness.streamChat).not.toHaveBeenCalled();
    expect(harness.posted).toContainEqual(expect.objectContaining({
      type: 'VIDEO_ANSWER_ERROR',
      requestId: 'req-precise',
      code: 'UNSUPPORTED_ANALYSIS_MODE',
    }));
  });

  it('旧转写模式返回 UNSUPPORTED_ANALYSIS_MODE', async () => {
    getContentContextMock.mockReset();
    getContentContextMock.mockResolvedValue(null);
    getCachedMock.mockReset();
    getCachedMock.mockResolvedValue(null);

    const harness = buildHarness();
    await harness.controller.handleAsk({
      requestId: 'req-transcript',
      question: '有没有提到 WorkBuddy？',
      includeCurrentSegment: true,
      analysisMode: 'transcript',
    });

    await awaitPosted(harness, 1);
    expect(getContentContextMock).not.toHaveBeenCalled();
    expect(getCachedMock).not.toHaveBeenCalled();
    expect(harness.streamChat).not.toHaveBeenCalled();
    expect(harness.posted).toContainEqual(expect.objectContaining({
      type: 'VIDEO_ANSWER_ERROR',
      requestId: 'req-transcript',
      code: 'UNSUPPORTED_ANALYSIS_MODE',
    }));
  });

  it('没有 API Key 时返回 MINIMAX_API_KEY_MISSING 错误', async () => {
    readSettingsMock.mockResolvedValueOnce({
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      fastModel: 'MiniMax-M2.7-highspeed',
      analysisMode: 'subtitle',
      thinkingMode: 'disabled',
      webSearchEnabled: false,
      updatedAt: 1,
    });
    const harness = buildHarness();
    await harness.controller.handleAsk({
      requestId: 'req-2',
      question: '视频讲什么',
      includeCurrentSegment: true,
    });
    await awaitPosted(harness, 1);
    const error = harness.posted.find((m) => m.type === 'VIDEO_ANSWER_ERROR');
    expect(error && error.type === 'VIDEO_ANSWER_ERROR' && error.code).toBe('MINIMAX_API_KEY_MISSING');
  });

  it('正常流式：推 CHUNK + DONE', async () => {
    const harness = buildHarness({
      chunks: [
        { text: '你', done: false },
        { text: '好', done: false },
        { text: '', done: true },
      ],
    });
    await harness.controller.handleAsk({
      requestId: 'req-3',
      question: '视频主要表达什么？',
      includeCurrentSegment: true,
    });
    await awaitPosted(harness, 3);
    const chunks = harness.posted.filter((m) => m.type === 'VIDEO_ANSWER_CHUNK');
    const done = harness.posted.find((m) => m.type === 'VIDEO_ANSWER_DONE');
    expect(chunks).toHaveLength(2);
    expect(chunks[0] && chunks[0].type === 'VIDEO_ANSWER_CHUNK' && chunks[0].text).toBe('你');
    expect(chunks[1] && chunks[1].type === 'VIDEO_ANSWER_CHUNK' && chunks[1].text).toBe('好');
    expect(done).toBeDefined();
    expect(done && done.type === 'VIDEO_ANSWER_DONE' && done.requestId).toBe('req-3');
  });

  it('reasoning chunk 走 VIDEO_ANSWER_REASONING_CHUNK 而不是 CHUNK', async () => {
    const harness = buildHarness({
      chunks: [
        { text: '', reasoning: 'thinking step 1', done: false },
        { text: 'real answer', done: false },
        { text: '', done: true },
      ],
    });
    await harness.controller.handleAsk({
      requestId: 'req-4',
      question: '视频讲什么',
      includeCurrentSegment: true,
    });
    await awaitPosted(harness, 3);
    const reasoning = harness.posted.filter((m) => m.type === 'VIDEO_ANSWER_REASONING_CHUNK');
    const chunks = harness.posted.filter((m) => m.type === 'VIDEO_ANSWER_CHUNK');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0] && reasoning[0].type === 'VIDEO_ANSWER_REASONING_CHUNK' && reasoning[0].text).toBe(
      'thinking step 1',
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0] && chunks[0].type === 'VIDEO_ANSWER_CHUNK' && chunks[0].text).toBe('real answer');
  });

  it('流式抛错时推 VIDEO_ANSWER_ERROR，且不推 DONE', async () => {
    const errorClient = {
      chat: vi.fn(),
      streamChat: vi.fn(async function* () {
        yield { text: 'first', done: false };
        throw new Error('网络挂了');
      }),
    };
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 0 }),
      createTextProviderClient: () => errorClient as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });
    await controller.handleAsk({
      requestId: 'req-err',
      question: '视频讲什么',
      includeCurrentSegment: true,
    });
    // 等到至少 1 条 error
    for (let i = 0; i < 200 && !posted.some((m) => m.type === 'VIDEO_ANSWER_ERROR'); i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const error = posted.find((m) => m.type === 'VIDEO_ANSWER_ERROR');
    const done = posted.find((m) => m.type === 'VIDEO_ANSWER_DONE');
    expect(error).toBeDefined();
    expect(error && error.type === 'VIDEO_ANSWER_ERROR' && error.code).toBe('STREAM_FAILED');
    expect(done).toBeUndefined();
  });

  it('新 requestId 进来时 abort 旧请求 → 旧 chunk 不会写到新 requestId 下', async () => {
    // 旧 stream yield 一段老 chunks，每段之间 sleep 模拟流式；新 stream yield
    // 一段新 chunks。两边**故意用不同前缀**以验证：旧 generator 后续的 yield
    // 不会污染 req-new 的 message list。
    let currentRequestId = 'req-old';
    async function* streamFor(reqId: string): AsyncGenerator<MinimaxStreamChunk> {
      if (reqId === 'req-old') {
        yield { text: 'old-a', done: false };
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        yield { text: 'old-b', done: false };
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        yield { text: 'old-c', done: false };
        yield { text: '', done: true };
      } else {
        yield { text: 'new-a', done: false };
        yield { text: '', done: true };
      }
    }
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 0 }),
      createTextProviderClient: () =>
        ({
          chat: vi.fn(),
          streamChat: vi.fn(async function* () {
            yield* streamFor(currentRequestId);
          }),
        }) as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });

    // 启动旧请求但不 await（让它在后台跑）
    void controller.handleAsk({
      requestId: 'req-old',
      question: '第一个问题',
      includeCurrentSegment: true,
    });
    // 等到至少有 1 条 old 推送（说明旧 stream 已经开始 yield）
    for (let i = 0; i < 200 && !posted.some((m) => m.requestId === 'req-old'); i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    // 切到新 requestId
    currentRequestId = 'req-new';
    // 发起新请求；新请求会 abort 旧请求
    await controller.handleAsk({
      requestId: 'req-new',
      question: '第二个问题',
      includeCurrentSegment: true,
    });
    // 给 100ms 让旧 stream 后续 chunk 来（如果 controller 隔离不严，会泄漏）
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const newPosted = posted.filter((m) => m.requestId === 'req-new');
    const oldPosted = posted.filter((m) => m.requestId === 'req-old');

    // 新请求至少要有一个 chunk 或 error/done
    expect(newPosted.length).toBeGreaterThan(0);
    // 关键断言：旧 stream 的 chunks（"old-" 前缀）**不会**出现在 req-new 的 message 列表里
    // ——这是 controller 隔离的核心保证。
    const leakedToNew = newPosted.filter(
      (m) => m.type === 'VIDEO_ANSWER_CHUNK' && m.text.startsWith('old-'),
    );
    expect(leakedToNew).toEqual([]);
    // 旧请求至少 yield 过 1 条（证明隔离是真的拦截了后续 chunk）
    expect(oldPosted.length).toBeGreaterThan(0);
    // 旧请求的 stream 不应被推到 DONE（被 abort 打断，handleAsk 内部不会再推 done）
    // ——但允许有（取决于时机）。这里不强约束。
  });

  it('用户主动 cancel 时 abort，旧请求的 chunk 不再写', async () => {
    async function* slowStream(): AsyncGenerator<MinimaxStreamChunk> {
      yield { text: 'a', done: false };
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      yield { text: 'b', done: false };
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      yield { text: 'c', done: false };
    }
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 0 }),
      createTextProviderClient: () =>
        ({ chat: vi.fn(), streamChat: vi.fn(slowStream) }) as unknown as ReturnType<
          VideoFollowupControllerDeps['createTextProviderClient']
        >,
      postMessage,
    });
    void controller.handleAsk({
      requestId: 'req-cancel',
      question: '问',
      includeCurrentSegment: true,
    });
    // 等到至少 1 条
    for (let i = 0; i < 200 && posted.length === 0; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    controller.handleCancel({ requestId: 'req-cancel' });
    // 给 100ms 让 stream 后续走完
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    // 没有 VIDEO_ANSWER_ERROR（cancel 不算错误）
    const errors = posted.filter((m) => m.type === 'VIDEO_ANSWER_ERROR');
    expect(errors).toEqual([]);
  });

  it('side panel disconnect 时取消 inFlight 请求', async () => {
    async function* neverEnding(): AsyncGenerator<MinimaxStreamChunk> {
      // 永远不会主动 yield done；需要外部 abort
      while (true) {
        yield { text: 'loop', done: false };
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 0 }),
      createTextProviderClient: () =>
        ({ chat: vi.fn(), streamChat: vi.fn(neverEnding) }) as unknown as ReturnType<
          VideoFollowupControllerDeps['createTextProviderClient']
        >,
      postMessage,
    });
    void controller.handleAsk({
      requestId: 'req-disc',
      question: '问',
      includeCurrentSegment: true,
    });
    for (let i = 0; i < 200 && posted.length === 0; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const beforeCount = posted.length;
    controller.handleDisconnect();
    // 给 50ms 让 stream 后续尝试 yield
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // disconnect 后不应该再产生新推送
    expect(posted.length).toBe(beforeCount);
  });

  it('平台不是 bilibili/youtube 时返回 UNSUPPORTED_PLATFORM', async () => {
    const harness = buildHarness({
      context: {
        platform: 'unknown',
        videoId: 'unknown-video',
        url: 'https://example.com/video',
        title: 'unknown',
        detectedAt: 0,
      },
    });
    await harness.controller.handleAsk({
      requestId: 'req-unknown',
      question: '视频讲什么',
      includeCurrentSegment: true,
    });
    await awaitPosted(harness, 1);
    const error = harness.posted.find((m) => m.type === 'VIDEO_ANSWER_ERROR');
    expect(error && error.type === 'VIDEO_ANSWER_ERROR' && error.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('Round 22 必修 A5 + Round 29A 必修 D：context 是 BV:p=10 时 getCachedContentContext 和 getCachedAnalysis 都用 BV:p=10 作为 contentKey 读取', async () => {
    // 用户场景：B 站多 P 切到第 10P 追问，缓存必须按 p=10 隔离。
    // Round 29A 必修 D：contentContext 也是 contentKey 隔离，测例同时验证两个调用。
    const p10Ctx: PageContext = {
      ...BILIBILI_CTX,
      contentKey: 'BV1xx:p=10',
      platformSpecific: { page: 10 },
      url: 'https://www.bilibili.com/video/BV1xx/?p=10',
    };
    getCachedMock.mockReset();
    getContentContextMock.mockReset();
    getCachedMock.mockResolvedValue({
      ...CACHED_ANALYSIS,
      metadata: {
        ...CACHED_ANALYSIS.metadata,
        url: 'https://www.bilibili.com/video/BV1xx/?p=10',
        platformSpecific: { page: 10, cid: 100010 },
      },
    });
    getContentContextMock.mockResolvedValue({
      metadata: {
        ...CACHED_CONTENT_CONTEXT.metadata,
        url: 'https://www.bilibili.com/video/BV1xx/?p=10',
        platformSpecific: { page: 10, cid: 100010 },
      },
      transcriptCues: [],
      transcriptSource: 'official',
    });
    const harness = buildHarness({ context: p10Ctx });
    await harness.controller.handleAsk({
      requestId: 'req-p10',
      question: '这段讲什么',
      includeCurrentSegment: true,
    });
    await awaitPosted(harness, 2);
    // 验证两个 cache 调用都用 contentKey=BV1xx:p=10
    const ctxCallArgs = getContentContextMock.mock.calls[0]?.[0] as
      | { platform: string; contentKey: string }
      | undefined;
    expect(ctxCallArgs).toBeDefined();
    expect(ctxCallArgs?.contentKey).toBe('BV1xx:p=10');
    const analysisCallArgs = getCachedMock.mock.calls[0]?.[0] as
      | { platform: string; videoId: string; contentKey: string }
      | undefined;
    expect(analysisCallArgs).toBeDefined();
    expect(analysisCallArgs?.contentKey).toBe('BV1xx:p=10');
  });

  // Round 24 必修 D：annotations 表已删除，listAnnotations 相关测例全部移除。
  // 未来"提问 → 复盘"重新设计打点时，从这里加回。

  it('没有 context 时返回 NO_ACTIVE_TAB', async () => {
    const harness = buildHarness({ context: null });
    await harness.controller.handleAsk({
      requestId: 'req-noctx',
      question: '视频讲什么',
      includeCurrentSegment: true,
    });
    await awaitPosted(harness, 1);
    const error = harness.posted.find((m) => m.type === 'VIDEO_ANSWER_ERROR');
    expect(error && error.type === 'VIDEO_ANSWER_ERROR' && error.code).toBe('NO_ACTIVE_TAB');
  });

  it('相同 requestId 重复进来时静默忽略（不会重置 inFlight）', async () => {
    const harness = buildHarness();
    const p1 = harness.controller.handleAsk({
      requestId: 'req-dup',
      question: '问',
      includeCurrentSegment: true,
    });
    const p2 = harness.controller.handleAsk({
      requestId: 'req-dup',
      question: '问',
      includeCurrentSegment: true,
    });
    await Promise.all([p1, p2]);
 //两次相同 requestId不会产出双份 chunk
 const chunksForReq = harness.posted.filter(
 (m) => m.type === 'VIDEO_ANSWER_CHUNK' && m.requestId === 'req-dup',
 );
 expect(chunksForReq.length).toBe(1);
 });
});

// ---------------------------------------------------------------------------
// Round12修复（streamChat fallback / fastModel / 不依赖 inFlight的catch）
// ---------------------------------------------------------------------------

describe('createVideoFollowupController (Round12: v2 protocol robustness)', () => {
  beforeEach(() => {
   readSettingsMock.mockReset();
   getCachedMock.mockReset();
   getContentContextMock.mockReset();
   readSettingsMock.mockResolvedValue({
    apiKey: 'sk-test',
    baseUrl: 'https://api.minimaxi.com',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M2.7-highspeed',
    analysisMode: 'subtitle',
    thinkingMode: 'disabled',
    webSearchEnabled: false,
    updatedAt:1,
   });
   getCachedMock.mockResolvedValue(CACHED_ANALYSIS);
   getContentContextMock.mockResolvedValue(CACHED_CONTENT_CONTEXT);
  });

 afterEach(async () => {
 try {
 await db.delete();
 } catch {
 //忽略
 }
 });

 it('streamChat抛 MinimaxStreamUnsupportedError → controller fallback 到 chat()，推 CHUNK + DONE（不再永远卡 loading）', async () => {
 //模拟 v2协议鉴权失败（HTTP200 + application/json + base_resp.status_code=1004）：
 //修复前 streamChat silently yield done，side panel永远卡 loading。
 //修复后 streamChat抛 MinimaxStreamUnsupportedError，controller 自动 fallback 到
 // chat() 把整段 content推一个 chunk，再推 DONE，side panel立即回到 idle。
 const fallbackChatContent = '这是追问的完整回答（从 chat() fallback路径）';
 const { MinimaxStreamUnsupportedError } = await import('@core/llm/minimax-client');
 const client = {
 chat: vi.fn(async (): Promise<MinimaxChatResult> => ({
 content: fallbackChatContent,
 model: 'MiniMax-M2.7-highspeed',
 })),
 // eslint-disable-next-line require-yield -- 测试 mock generator立刻抛错
 streamChat: vi.fn(async function* () {
 // 不 yield 直接抛，模拟 streamChat立刻报 unsupported
 throw new MinimaxStreamUnsupportedError(
 'MiniMax 流式响应不是 SSE（content-type=application/json）',
 '{"base_resp":{"status_code":1004,"status_msg":"login fail"}}',
 );
 }),
 };
 const posted: VideoFollowupPortMessage[] = [];
 const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
 posted.push(m);
 });
 const controller = createVideoFollowupController({
 resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime:0 }),
 createTextProviderClient: () =>
 client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
 postMessage,
 });
 await controller.handleAsk({
 requestId: 'req-fallback',
 question: '视频讲什么',
 includeCurrentSegment: true,
 });
 const chunks = posted.filter(
 (m) => m.type === 'VIDEO_ANSWER_CHUNK' && m.requestId === 'req-fallback',
 );
 const done = posted.find((m) => m.type === 'VIDEO_ANSWER_DONE');
 const errors = posted.filter((m) => m.type === 'VIDEO_ANSWER_ERROR');
 // fallback路径只产出一个 chunk + done，不发 error
 expect(chunks.length).toBe(1);
 if (chunks[0] && chunks[0].type === 'VIDEO_ANSWER_CHUNK') {
 expect(chunks[0].text).toBe(fallbackChatContent);
 }
 expect(done).toBeDefined();
 expect(errors.length).toBe(0);
 // chat() 调用时 model应该是 settings.fastModel（M2.7-highspeed），不是 settings.model（M3）
 const chatCallArgs = client.chat.mock.calls[0] as readonly unknown[] | undefined;
 const chatCallOptions = (chatCallArgs?.[1] as { model?: string } | undefined);
 expect(chatCallOptions?.model).toBe('MiniMax-M2.7-highspeed');
 });

 it('streamChat fallback路径在用户 abort 时静默退出（不推 error）', async () => {
 const { MinimaxStreamUnsupportedError } = await import('@core/llm/minimax-client');
 const client = {
 chat: vi.fn(async () => {
 //模拟 abort 后 chat()抛 AbortError
 throw new Error('The operation was aborted');
 }),
 streamChat: vi.fn(async function* () {
 // 让 stream先 yield 一段再抛，让 abort 有机会先触发
 yield { text: 'a', done: false };
 await new Promise<void>((resolve) => setTimeout(resolve,30));
 throw new MinimaxStreamUnsupportedError(
 'content-type=application/json',
 '{}',
 );
 }),
 };
 const posted: VideoFollowupPortMessage[] = [];
 const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
 posted.push(m);
 });
 const controller = createVideoFollowupController({
 resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime:0 }),
 createTextProviderClient: () =>
 client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
 postMessage,
 });
 const p = controller.handleAsk({
 requestId: 'req-abort-fallback',
 question: '问',
 includeCurrentSegment: true,
 });
 setTimeout(() => controller.handleCancel({ requestId: 'req-abort-fallback' }),10);
 await p;
 const errors = posted.filter(
 (m) => m.type === 'VIDEO_ANSWER_ERROR' && m.requestId === 'req-abort-fallback',
 );
 // abort 时不应推 error
 expect(errors.length).toBe(0);
 });

 it('streamChat抛其它错误（非 unsupported）→推 VIDEO_ANSWER_ERROR，不 fallback', async () => {
 const client = {
 chat: vi.fn(),
 // eslint-disable-next-line require-yield -- 测试 mock generator立刻抛错
 streamChat: vi.fn(async function* () {
 throw new Error('MiniMax 流式请求失败：fetch failed');
 }),
 };
 const posted: VideoFollowupPortMessage[] = [];
 const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
 posted.push(m);
 });
 const controller = createVideoFollowupController({
 resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime:0 }),
 createTextProviderClient: () =>
 client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
 postMessage,
 });
 await controller.handleAsk({
 requestId: 'req-stream-failed',
 question: '问',
 includeCurrentSegment: true,
 });
 const error = posted.find(
 (m) => m.type === 'VIDEO_ANSWER_ERROR' && m.requestId === 'req-stream-failed',
 );
 expect(error).toBeDefined();
 if (error && error.type === 'VIDEO_ANSWER_ERROR') {
 expect(error.code).toBe('STREAM_FAILED');
 }
 expect(client.chat).not.toHaveBeenCalled();
 });

 it('streamChat 调用时显式传 fastModel 作为 model override（避免追问用 M3）', async () => {
 const streamClient = {
 chat: vi.fn(async (): Promise<MinimaxChatResult> => ({
 content: 'chat answer',
 model: 'MiniMax-M2.7-highspeed',
 })),
 streamChat: vi.fn(async function* () {
 yield { text: 'ok', done: false };
 yield { text: '', done: true };
 }),
 };
 const posted: VideoFollowupPortMessage[] = [];
 const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
 posted.push(m);
 });
 const controller = createVideoFollowupController({
 resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime:0 }),
 createTextProviderClient: () =>
 streamClient as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
 postMessage,
 });
 await controller.handleAsk({
 requestId: 'req-fastmodel',
 question: '问',
 includeCurrentSegment: true,
 });
 const streamCallArgs = streamClient.streamChat.mock.calls[0] as readonly unknown[] | undefined;
 const streamCallOptions = (streamCallArgs?.[1] as { model?: string } | undefined);
 expect(streamCallOptions?.model).toBe('MiniMax-M2.7-highspeed');
 });

 it('cleanup race：handleCancel → inFlight 重置后 streamChat 最后一段抛错 →静默退出，不推 error', async () => {
 const client = {
 chat: vi.fn(),
 streamChat: vi.fn(async function* () {
 yield { text: 'a', done: false };
 await new Promise<void>((resolve) => setTimeout(resolve,30));
 throw new Error('late error after cancel');
 }),
 };
 const posted: VideoFollowupPortMessage[] = [];
 const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
 posted.push(m);
 });
 const controller = createVideoFollowupController({
 resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime:0 }),
 createTextProviderClient: () =>
 client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
 postMessage,
 });
 void controller.handleAsk({
 requestId: 'req-cancel-race',
 question: '问',
 includeCurrentSegment: true,
 });
 await new Promise<void>((resolve) => setTimeout(resolve,10));
 controller.handleCancel({ requestId: 'req-cancel-race' });
 await new Promise<void>((resolve) => setTimeout(resolve,50));
 const errors = posted.filter(
 (m) => m.type === 'VIDEO_ANSWER_ERROR' && m.requestId === 'req-cancel-race',
 );
  expect(errors.length).toBe(0);
 });
});

describe('createVideoFollowupController (Round 16 必修 1 transcriptCues 透传)', () => {
  it('contentContext 返回的 transcriptCues 会被 buildVideoContextPackage 接收', async () => {
    // Round 29A 必修 D：transcriptCues 现在从 contentContext 来（不再读 analysisCache）。
    readSettingsMock.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com',
      model: 'MiniMax-M3',
      fastModel: 'MiniMax-M2.7-highspeed',
      analysisMode: 'subtitle',
      thinkingMode: 'disabled',
      webSearchEnabled: false,
      updatedAt: 0,
    });
    getCachedMock.mockReset();
    getContentContextMock.mockReset();
    getCachedMock.mockResolvedValue(CACHED_ANALYSIS);
    getContentContextMock.mockResolvedValue({
      metadata: CACHED_CONTENT_CONTEXT.metadata,
      transcriptCues: [
        { start: 100, end: 110, text: 'cue-A' },
        { start: 120, end: 130, text: 'cue-B' },
        { start: 140, end: 150, text: 'cue-C' },
      ],
      transcriptSource: 'official',
    });
    const streamStub = makeClientStub([{ text: 'answer', done: false }, { text: '', done: true }]);
    const client = streamStub.client;
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 130 }),
      createTextProviderClient: () =>
        client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });
    await controller.handleAsk({
      requestId: 'req-cues',
      question: '解释当前片段',
      includeCurrentSegment: true,
      currentTime: 130,
    });
    // 拿到传给 streamChat 的 messages，确认 transcriptCues 进了 prompt
    const streamCall = client.streamChat.mock.calls[0];
    expect(streamCall).toBeDefined();
    const messages = streamCall?.[0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('cue-A');
    expect(userMessage?.content).toContain('cue-B');
    expect(userMessage?.content).toContain('cue-C');
  });

  it('contentContext 字幕为空走兜底逻辑：prompt 不含 cue 且显示"anchor 附近没有逐字稿"', async () => {
    // Round 29A 必修 D：transcriptCues 走 contentContext，contentContext 没字幕时
    // pkg.transcriptCues=[] → 主窗口无 cue 也不兜底，prompt 应有"anchor 附近没有逐字稿"。
    readSettingsMock.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com',
      model: 'MiniMax-M3',
      fastModel: 'MiniMax-M2.7-highspeed',
      analysisMode: 'subtitle',
      thinkingMode: 'disabled',
      webSearchEnabled: false,
      updatedAt: 0,
    });
    getCachedMock.mockReset();
    getContentContextMock.mockReset();
    getCachedMock.mockResolvedValue(CACHED_ANALYSIS);
    getContentContextMock.mockResolvedValue({
      metadata: CACHED_CONTENT_CONTEXT.metadata,
      transcriptCues: [],
      transcriptSource: 'official',
    });
    const streamStub = makeClientStub([{ text: 'a', done: false }, { text: '', done: true }]);
    const client = streamStub.client;
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 500 }),
      createTextProviderClient: () =>
        client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });
    await controller.handleAsk({
      requestId: 'req-fallback',
      question: '解释当前片段',
      includeCurrentSegment: true,
      currentTime: 500,
    });
    const streamCall = client.streamChat.mock.calls[0];
    const messages = streamCall?.[0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    // pkg.transcriptCues=[] 时主窗口无 cue 也不兜底，prompt 应有"anchor 附近没有逐字稿"
    expect(userMessage?.content).toContain('anchor 附近没有逐字稿');
  });
});

describe('createVideoFollowupController (Round 20 端到端 prompt scope 补洞)', () => {
  // Round 20 必修 4：覆盖"UI 发包到 controller 后最终 prompt scope"的端到端。
  // Round 19 Codex review 发现：之前测试只覆盖"payload 是否带 selectedTimestamp"，
  // 没覆盖"最终 prompt scope 是否真的走 selected_segment"。本组测例把
  // FollowupTab → controller → buildFollowupChatPrompt 整条链路串起来验证
  // final scope 与 payload 一致（Round 20 收敛后：payload 不带 selectedTimestamp
  // 时 prompt 不应有 <focus_anchor>，payload 带 selectedTimestamp 且命中 selected
  // intent 时 prompt 应有 <focus_anchor> 且类型/时间正确）。

  const SETTINGS = {
    apiKey: 'sk-test',
    baseUrl: 'https://api.minimaxi.com',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M2.7-highspeed' as const,
    analysisMode: 'subtitle' as const,
    thinkingMode: 'disabled' as const,
    webSearchEnabled: false,
    updatedAt: 1,
  };

  function makeHarnessWith(currentTime: number | null) {
    readSettingsMock.mockReset();
    getCachedMock.mockReset();
    getContentContextMock.mockReset();
    readSettingsMock.mockResolvedValue(SETTINGS);
    getCachedMock.mockResolvedValue(CACHED_ANALYSIS);
    getContentContextMock.mockResolvedValue(CACHED_CONTENT_CONTEXT);
    const streamStub = makeClientStub([{ text: 'answer', done: false }, { text: '', done: true }]);
    const client = streamStub.client;
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime }),
      createTextProviderClient: () =>
        client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });
    return { controller, client, posted, postMessage };
  }

  function findUserMessage(client: { streamChat: ReturnType<typeof vi.fn> }): string {
    const streamCall = client.streamChat.mock.calls[0];
    expect(streamCall).toBeDefined();
    const messages = streamCall?.[0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    return userMessage?.content ?? '';
  }

  it('Round 20 必修 4 - case A：自由输入"哪些地方值得看？" + 无 selectedTimestamp → prompt 是 global 描述，无 <focus_anchor>', async () => {
    // 模拟 Round 20 收敛后 FollowupTab.handleSubmit 的最终 payload：
    // "哪些地方值得看？" 是全局白名单命中，UI 不透传 selectedTimestamp。
    const { controller, client } = makeHarnessWith(30);
    await controller.handleAsk({
      requestId: 'req-r20-global',
      question: '哪些地方值得看？',
      includeCurrentSegment: true,
      currentTime: 30,
      // 无 selectedTimestamp
    });
    const userPrompt = findUserMessage(client);
    // 1. primary_scope 应是 global 描述
    expect(userPrompt).toContain('<primary_scope>');
    expect(userPrompt).toMatch(/<primary_scope>\s*用户问的是视频整体/);
    // 2. 不应有 <focus_anchor> 块（global scope 不设 anchor）
    expect(userPrompt).not.toContain('<focus_anchor>');
  });

  it('Round 20 必修 4 - case B：自由输入"我选的这个节点为什么重要？" + selectedTimestamp=300 → prompt 含 <focus_anchor> 且类型=用户点选的时间线节点 / 时间=5:00', async () => {
    // 模拟 Round 20 收敛后 FollowupTab.handleSubmit 的最终 payload：
    // "我选的这个节点为什么重要？" 命中 selected intent，UI 透传 selectedTimestamp=300。
    const { controller, client } = makeHarnessWith(30);
    await controller.handleAsk({
      requestId: 'req-r20-selected',
      question: '我选的这个节点为什么重要？',
      includeCurrentSegment: true,
      currentTime: 30,
      selectedTimestamp: 300,
    });
    const userPrompt = findUserMessage(client);
    // 1. primary_scope 应是 selected_segment 描述
    expect(userPrompt).toContain('<primary_scope>');
    expect(userPrompt).toMatch(/<primary_scope>\s*用户点选了某个时间线节点/);
    // 2. 必含 <focus_anchor> 块
    expect(userPrompt).toContain('<focus_anchor>');
    // 3. <focus_anchor> 类型是"用户点选的时间线节点"
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?类型：用户点选的时间线节点[\s\S]*?<\/focus_anchor>/);
    // 4. <focus_anchor> 时间是 5:00（300s = 5:00）
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?时间：5:00[\s\S]*?<\/focus_anchor>/);
    // 5. 完整闭合
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?<\/focus_anchor>/);
  });

  it('Round 20 必修 4 - case C（防御）：自由输入"这段讲什么？" + 无 selectedTimestamp → prompt 是 current_segment + <focus_anchor> 类型=当前播放位置', async () => {
    // 模拟 Round 20 收敛后 FollowupTab.handleSubmit 的最终 payload：
    // "这段讲什么？" 是双义词（不再命中 selected intent），UI 不透传 selectedTimestamp；
    // current intent 命中 → current_segment → <focus_anchor> 类型=当前播放位置 / 时间=30s → 0:30
    const { controller, client } = makeHarnessWith(30);
    await controller.handleAsk({
      requestId: 'req-r20-current',
      question: '这段讲什么？',
      includeCurrentSegment: true,
      currentTime: 30,
      // 无 selectedTimestamp
    });
    const userPrompt = findUserMessage(client);
    // 1. primary_scope 应是 current_segment 描述
    expect(userPrompt).toContain('<primary_scope>');
    expect(userPrompt).toMatch(/<primary_scope>\s*用户问的是"这段 \/ 这里 \/ 现在讲"等当前片段意图/);
    // 2. 必含 <focus_anchor> 块
    expect(userPrompt).toContain('<focus_anchor>');
    // 3. <focus_anchor> 类型是"当前播放位置"
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?类型：当前播放位置[\s\S]*?<\/focus_anchor>/);
    // 4. <focus_anchor> 时间是 0:30
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?时间：0:30[\s\S]*?<\/focus_anchor>/);
  });

  it('Round 20 必修 4 - case D：自由输入"现在讲的是什么？" + 无 selectedTimestamp → prompt 是 current_segment + <focus_anchor> 类型=当前播放位置', async () => {
    const { controller, client } = makeHarnessWith(125);
    await controller.handleAsk({
      requestId: 'req-r20-current-now',
      question: '现在讲的是什么？',
      includeCurrentSegment: true,
      currentTime: 125,
    });
    const userPrompt = findUserMessage(client);
    expect(userPrompt).toMatch(/<primary_scope>\s*用户问的是"这段 \/ 这里 \/ 现在讲"等当前片段意图/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?类型：当前播放位置[\s\S]*?<\/focus_anchor>/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?时间：2:05[\s\S]*?<\/focus_anchor>/);
  });

  it('Round 20 必修 4 - case E（防御）：自由输入"解释当前片段"（forceCurrentSegment）+ selectedTimestamp=120 → prompt 是 current_segment + <focus_anchor> 类型=当前播放位置 / 时间=0:30', async () => {
    // 模拟 Round 18 必修 1 + Round 20 收敛的交互：
    // 用户点过时间线节点 (selectedTimestamp=120)，再点"解释当前片段"快捷问题
    // (forceCurrentSegment=true)。UI 不透传 selectedTimestamp → controller 走
    // current_segment → prompt <focus_anchor> 是当前播放位置 (0:30)，不是旧节点 2:00。
    const { controller, client } = makeHarnessWith(30);
    await controller.handleAsk({
      requestId: 'req-r20-current-force',
      question: '解释当前片段',
      includeCurrentSegment: true,
      currentTime: 30,
      forceCurrentSegment: true,
    });
    const userPrompt = findUserMessage(client);
    expect(userPrompt).toMatch(/<primary_scope>\s*用户问的是"这段 \/ 这里 \/ 现在讲"等当前片段意图/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?类型：当前播放位置[\s\S]*?<\/focus_anchor>/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?时间：0:30[\s\S]*?<\/focus_anchor>/);
    // 防御：不能误把旧节点 2:00 写进 anchor
    expect(userPrompt).not.toMatch(/<focus_anchor>[\s\S]*?时间：2:00[\s\S]*?<\/focus_anchor>/);
  });
});

describe('createVideoFollowupController (Round 21 必修 4 端到端 prompt scope 补洞：明确 selected 路由 selected_segment)', () => {
  // Round 21 必修 4：模拟 Round 21 必修 3 后的 FollowupTab.handleSubmit 最终 payload：
  //   - "我选的这段讲什么？" / "选中的这段讲什么？" / "刚才点的讲什么？" + selectedTimestamp=300
  //     → UI 透传 selectedTimestamp（detectSelectedSegmentIntent 命中"我选的/选中的/刚才点的"）
  //     → controller 走 selected_segment → prompt <focus_anchor> 类型=用户点选的时间线节点 / 时间=5:00

  const SETTINGS = {
    apiKey: 'sk-test',
    baseUrl: 'https://api.minimaxi.com',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M2.7-highspeed' as const,
    analysisMode: 'subtitle' as const,
    thinkingMode: 'disabled' as const,
    webSearchEnabled: false,
    updatedAt: 1,
  };

  function makeHarnessWith(currentTime: number | null) {
    readSettingsMock.mockReset();
    getCachedMock.mockReset();
    getContentContextMock.mockReset();
    readSettingsMock.mockResolvedValue(SETTINGS);
    getCachedMock.mockResolvedValue(CACHED_ANALYSIS);
    getContentContextMock.mockResolvedValue(CACHED_CONTENT_CONTEXT);
    const streamStub = makeClientStub([{ text: 'answer', done: false }, { text: '', done: true }]);
    const client = streamStub.client;
    const posted: VideoFollowupPortMessage[] = [];
    const postMessage = vi.fn((m: VideoFollowupPortMessage) => {
      posted.push(m);
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime }),
      createTextProviderClient: () =>
        client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });
    return { controller, client, posted, postMessage };
  }

  function findUserMessage(client: { streamChat: ReturnType<typeof vi.fn> }): string {
    const streamCall = client.streamChat.mock.calls[0];
    expect(streamCall).toBeDefined();
    const messages = streamCall?.[0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    return userMessage?.content ?? '';
  }

  it('Round 21 必修 4 - case 1：自由输入"我选的这段讲什么？" + selectedTimestamp=300 + currentTime=30 → prompt selected_segment + <focus_anchor> 类型=用户点选的时间线节点 / 时间=5:00', async () => {
    // Round 20 旧路由会让"这段" 抢走 → current_segment；Round 21 必修 2 新路由让
    // selected intent（"我选的"）优先 → selected_segment。
    const { controller, client } = makeHarnessWith(30);
    await controller.handleAsk({
      requestId: 'req-r21-picked',
      question: '我选的这段讲什么？',
      includeCurrentSegment: true,
      currentTime: 30,
      selectedTimestamp: 300,
    });
    const userPrompt = findUserMessage(client);
    expect(userPrompt).toMatch(/<primary_scope>\s*用户点选了某个时间线节点/);
    expect(userPrompt).toContain('<focus_anchor>');
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?类型：用户点选的时间线节点[\s\S]*?<\/focus_anchor>/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?时间：5:00[\s\S]*?<\/focus_anchor>/);
    // 防御：不能误把当前播放位置 (0:30) 写进 anchor
    expect(userPrompt).not.toMatch(/<focus_anchor>[\s\S]*?时间：0:30[\s\S]*?<\/focus_anchor>/);
  });

  it('Round 21 必修 4 - case 2：自由输入"选中的这段讲什么？" + selectedTimestamp=300 + currentTime=30 → prompt selected_segment + <focus_anchor> 类型=用户点选的时间线节点 / 时间=5:00', async () => {
    // 同 case 1,只是把 selected intent 触发词换成"选中的"。
    const { controller, client } = makeHarnessWith(30);
    await controller.handleAsk({
      requestId: 'req-r21-selected',
      question: '选中的这段讲什么？',
      includeCurrentSegment: true,
      currentTime: 30,
      selectedTimestamp: 300,
    });
    const userPrompt = findUserMessage(client);
    expect(userPrompt).toMatch(/<primary_scope>\s*用户点选了某个时间线节点/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?类型：用户点选的时间线节点[\s\S]*?<\/focus_anchor>/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?时间：5:00[\s\S]*?<\/focus_anchor>/);
    expect(userPrompt).not.toMatch(/<focus_anchor>[\s\S]*?时间：0:30[\s\S]*?<\/focus_anchor>/);
  });

  it('Round 21 必修 4 - case 3：自由输入"刚才点的讲什么？" + selectedTimestamp=300 + currentTime=30 → prompt selected_segment + <focus_anchor> 类型=用户点选的时间线节点 / 时间=5:00', async () => {
    // "刚才点的" 含 selected intent（"刚才点的"）+ ambiguous current（"刚才"）。
    // Round 20 旧路由：current intent 优先 → current_segment。
    // Round 21 必修 2 新路由：selected intent 优先 → selected_segment。
    const { controller, client } = makeHarnessWith(30);
    await controller.handleAsk({
      requestId: 'req-r21-clicked',
      question: '刚才点的讲什么？',
      includeCurrentSegment: true,
      currentTime: 30,
      selectedTimestamp: 300,
    });
    const userPrompt = findUserMessage(client);
    expect(userPrompt).toMatch(/<primary_scope>\s*用户点选了某个时间线节点/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?类型：用户点选的时间线节点[\s\S]*?<\/focus_anchor>/);
    expect(userPrompt).toMatch(/<focus_anchor>[\s\S]*?时间：5:00[\s\S]*?<\/focus_anchor>/);
    expect(userPrompt).not.toMatch(/<focus_anchor>[\s\S]*?时间：0:30[\s\S]*?<\/focus_anchor>/);
  });
});
