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
    chapters: [],
    timeline: [{ timestamp: 0, title: '开场', summary: '引入', importance: 'must-watch' as const }],
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

const CACHED_CONTENT_CONTEXT = {
  metadata: CACHED_ANALYSIS.metadata,
  transcriptCues: [] as Array<{ start: number; end?: number; text: string }>,
  transcriptSource: 'official' as const,
};

function makeClientStub(chunks: readonly MinimaxStreamChunk[]): {
  client: { chat: ReturnType<typeof vi.fn>; streamChat: ReturnType<typeof vi.fn> };
} {
  return {
    client: {
      chat: vi.fn(async (): Promise<MinimaxChatResult> => ({
        content: 'fallback',
        model: 'MiniMax-M3',
      })),
      streamChat: vi.fn(async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      }),
    },
  };
}

/**
 * answerBasis 在 background controller 的边界归一化与透传契约。
 *
 * 与 `video-followup-controller.test.ts` 拆开：本文件只覆盖本功能场景，避免
 * 把答案堆进 1300 行的综合 controller 测试文件（按 AGENT_HANDOFF QA1 必修 4 §6）。
 * 共享 helper：db / minimax settings / contentContext mock + BILIBILI_CTX fixtures
 * 都内联定义，避免在 tests/unit/_fixtures/ 复制大量 mock 基础设施。
 */
describe('createVideoFollowupController (回答依据 answerBasis 边界归一化与透传)', () => {
  const SETTINGS = {
    apiKey: 'sk-test',
    baseUrl: 'https://api.minimaxi.com',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M2.7-highspeed' as const,
    analysisMode: 'subtitle' as const,
    thinkingMode: 'disabled' as const,
    webSearchEnabled: true,
    updatedAt: 1,
  };

  beforeEach(() => {
    readSettingsMock.mockReset();
    getCachedMock.mockReset();
    getContentContextMock.mockReset();
    readSettingsMock.mockResolvedValue(SETTINGS);
    getCachedMock.mockResolvedValue(CACHED_ANALYSIS);
    getContentContextMock.mockResolvedValue(CACHED_CONTENT_CONTEXT);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    try {
      await db.delete();
    } catch {
      // 忽略
    }
  });

  function makeHarness(): {
    controller: ReturnType<typeof createVideoFollowupController>;
    client: { streamChat: ReturnType<typeof vi.fn> };
    postMessage: ReturnType<typeof vi.fn>;
  } {
    const streamStub = makeClientStub([{ text: 'answer', done: false }, { text: '', done: true }]);
    const client = streamStub.client;
    const postMessage = vi.fn((_m: VideoFollowupPortMessage) => {
      // 多数测例只关心 streamChat 拿到的 prompt；失败分支会单独断言 postMessage。
    });
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: async () => ({ context: BILIBILI_CTX, currentTime: 30 }),
      createTextProviderClient: () =>
        client as unknown as ReturnType<VideoFollowupControllerDeps['createTextProviderClient']>,
      postMessage,
    });
    return { controller, client, postMessage };
  }

  function findSystemPrompt(client: { streamChat: ReturnType<typeof vi.fn> }): string {
    const streamCall = client.streamChat.mock.calls[0];
    expect(streamCall).toBeDefined();
    const messages = streamCall?.[0] as Array<{ role: string; content: string }>;
    const systemMessage = messages.find((m) => m.role === 'system');
    expect(systemMessage).toBeDefined();
    return systemMessage?.content ?? '';
  }

  function findUserPrompt(client: { streamChat: ReturnType<typeof vi.fn> }): string {
    const streamCall = client.streamChat.mock.calls[0];
    expect(streamCall).toBeDefined();
    const messages = streamCall?.[0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    return userMessage?.content ?? '';
  }

  it('ASK_VIDEO_QUESTION 不传 answerBasis → controller 归一化为 video_only（边界防御）', async () => {
    const { controller, client } = makeHarness();
    await controller.handleAsk({
      requestId: 'req-basis-default',
      question: '视频讲什么',
      includeCurrentSegment: true,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const system = findSystemPrompt(client);
    // basis 块必须是 video_only（不是 video_plus_general）
    expect(system).toMatch(/0\. \*\*回答依据：仅视频上下文/);
    expect(system).not.toMatch(/0\. \*\*回答依据：视频上下文 \+ 模型通识知识/);
    // basis 块额外要求：不用训练数据补齐
    expect(system).toMatch(/不使用模型训练数据|不使用模型通识|不.*主动补充背景/);
    // 不应出现"补充理解（通识）"标注的段落（basis 块没启用）
    expect(system).not.toMatch(/\*\*补充理解（通识）\*\*/);
  });

  it('ASK_VIDEO_QUESTION 显式 video_plus_general → prompt 允许通识补充且要求视频优先 / 来源分隔 / 不得冒充联网', async () => {
    const { controller, client } = makeHarness();
    await controller.handleAsk({
      requestId: 'req-basis-vpg',
      question: '视频讲什么',
      includeCurrentSegment: true,
      answerBasis: 'video_plus_general',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const system = findSystemPrompt(client);
    // basis 块必须是 video_plus_general
    expect(system).toMatch(/0\. \*\*回答依据：视频上下文 \+ 模型通识知识/);
    expect(system).not.toMatch(/0\. \*\*回答依据：仅视频上下文/);
    // 视频优先 / 来源分隔
    expect(system).toMatch(/\*\*视频内容\*\*/);
    expect(system).toMatch(/\*\*补充理解（通识）\*\*/);
    // 不得冒充联网
    expect(system).toMatch(/不得.*声称已联网/);
    // basis 是 video_plus_general → 不应再要求 video_only 的"不使用模型通识"
    expect(system).not.toMatch(/不使用模型训练数据|不使用模型通识/);
  });

  it('ASK_VIDEO_QUESTION 显式 video_plus_web → 先调用 MiniMax 搜索并把来源写入 prompt', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          organic: [
            {
              title: 'Apple Intelligence 新闻',
              link: 'https://example.com/apple-ai',
              snippet: '苹果发布了新的 AI 功能。',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { controller, client } = makeHarness();
    await controller.handleAsk({
      requestId: 'req-basis-web',
      question: '这个观点有最新背景吗？',
      includeCurrentSegment: true,
      answerBasis: 'video_plus_web',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.minimaxi.com/v1/coding_plan/search');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('测试视频');
    expect(init.body).toContain('这个观点有最新背景吗');

    const system = findSystemPrompt(client);
    const user = findUserPrompt(client);
    expect(system).toMatch(/MiniMax 联网搜索结果/);
    expect(user).toContain('<web_search_results>');
    expect(user).toContain('Apple Intelligence 新闻');
    expect(user).toContain('https://example.com/apple-ai');
  });

  it('ASK_VIDEO_QUESTION 显式 video_plus_web 但实验开关关闭 → 发错误且不调用搜索 / chat stream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    readSettingsMock.mockResolvedValueOnce({ ...SETTINGS, webSearchEnabled: false });
    const { controller, client, postMessage } = makeHarness();

    await controller.handleAsk({
      requestId: 'req-basis-web-disabled',
      question: '这个观点有最新背景吗？',
      includeCurrentSegment: true,
      answerBasis: 'video_plus_web',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.streamChat).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'VIDEO_ANSWER_ERROR',
        requestId: 'req-basis-web-disabled',
        code: 'WEB_SEARCH_DISABLED',
      }),
    );
  });

  it('ASK_VIDEO_QUESTION 显式 video_plus_web 但搜索业务失败 → 发错误且不调用 chat stream', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          base_resp: {
            status_code: 1008,
            status_msg: 'permission denied',
          },
          organic: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { controller, client, postMessage } = makeHarness();
    await controller.handleAsk({
      requestId: 'req-basis-web-business-error',
      question: '这个观点有最新背景吗？',
      includeCurrentSegment: true,
      answerBasis: 'video_plus_web',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.streamChat).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'VIDEO_ANSWER_ERROR',
        requestId: 'req-basis-web-business-error',
        code: 'MINIMAX_ERROR',
        message: expect.stringMatching(/业务状态 1008|Token Plan|permission denied/),
      }),
    );
  });
});
