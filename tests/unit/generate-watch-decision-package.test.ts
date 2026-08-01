import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateWatchDecisionPackage,
  generateWatchDecisionPackageStream,
  WATCH_DECISION_PACKAGE_MAX_TOKENS,
} from '@core/learning/generate-watch-decision-package';
import type {
  LanguageModelChatMessage,
  LanguageModelStreamChunk,
  LanguageModelStreamOptions,
} from '@core/llm/language-model-client';
import type { LearningSession, SubtitleCue, VideoMetadata } from '@core/types';
import { createDefaultTextProviderSettings } from '@shared/settings';

const mocks = vi.hoisted(() => ({
  client: {
    testAuth: vi.fn(),
    chat: vi.fn(),
    streamChat: vi.fn(),
  },
}));

vi.mock('@core/llm/language-model-factory', () => ({
  createLanguageModelClient: vi.fn(() => mocks.client),
}));

const metadata: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1watch',
  title: 'Cursor 教程',
  author: '作者',
  url: 'https://www.bilibili.com/video/BV1watch',
  duration: 494,
};

const cues: SubtitleCue[] = [
  { start: 0, end: 8, text: '开场介绍 Cursor。' },
  { start: 8, end: 16, text: '演示 AI 编程。' },
];

const session: LearningSession = {
  id: 'bilibili:BV1watch',
  schemaVersion: 3,
  platform: 'bilibili',
  videoId: 'BV1watch',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('generateWatchDecisionPackage', () => {
  beforeEach(() => {
    mocks.client.chat.mockReset();
    mocks.client.streamChat.mockReset();
  });

  it('非流式生成会给观看决策包传入更大的输出上限', async () => {
    mocks.client.chat.mockResolvedValue({
      content: validPackageJson(),
      model: 'MiniMax-M3',
    });

    await generateWatchDecisionPackage({
      settings: { ...createDefaultTextProviderSettings(), apiKey: 'sk-test' },
      metadata,
      transcriptCues: cues,
      session,
    });

    expect(mocks.client.chat).toHaveBeenCalledWith(expect.any(Array), {
      model: 'MiniMax-M2.7-highspeed',
      signal: expect.any(AbortSignal),
      maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
      usageFeature: 'analysis',
    });
  });
});

describe('generateWatchDecisionPackageStream', () => {
  beforeEach(() => {
    mocks.client.chat.mockReset();
    mocks.client.streamChat.mockReset();
  });

  it('流式结果解析失败时自动用普通生成重试，并保留更大的输出上限', async () => {
    const statuses: string[] = [];
    const chunks: string[] = [];
    mocks.client.streamChat.mockImplementation(async function* (
      _messages: readonly LanguageModelChatMessage[],
      _options?: LanguageModelStreamOptions,
    ): AsyncGenerator<LanguageModelStreamChunk, void, void> {
      yield { text: '{"contentType":"课程讲解"', done: false };
      yield { text: '', done: true };
    });
    mocks.client.chat.mockResolvedValue({
      content: validPackageJson(),
      model: 'MiniMax-M3',
    });

    const result = await generateWatchDecisionPackageStream({
      settings: { ...createDefaultTextProviderSettings(), apiKey: 'sk-test' },
      metadata,
      transcriptCues: cues,
      session,
      signal: new AbortController().signal,
      onStatus: (status) => statuses.push(status),
      onChunk: (chunk) => chunks.push(chunk.text),
    });

    expect(result.guide.contentType).toBe('课程讲解');
    expect(statuses).toContain('流式结果格式异常，已切换为普通生成');
    expect(chunks).toContain('{"contentType":"课程讲解"');
    expect(mocks.client.streamChat).toHaveBeenCalledWith(expect.any(Array), {
      model: 'MiniMax-M2.7-highspeed',
      signal: expect.any(AbortSignal),
      maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
      usageFeature: 'analysis',
    });
    expect(mocks.client.chat).toHaveBeenCalledWith(expect.any(Array), {
      model: 'MiniMax-M2.7-highspeed',
      signal: expect.any(AbortSignal),
      maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
      usageFeature: 'analysis',
    });
  });
});

function validPackageJson(): string {
  return JSON.stringify({
    contentType: '课程讲解',
    contentTypeReason: '演示 Cursor 入门流程。',
    suggestedStance: '选择性看核心演示。',
    decision: {
      rating: 'selective',
      score: 72,
      valueProfile: {
        kind: 'learning_tutorial',
        label: '课程讲解',
        criteria: [
          { label: '结构清晰', score: 70, reason: '演示路径清楚。' },
          { label: '可迁移性', score: 75, reason: '入门流程可复用。' },
          { label: '实践成本', score: 72, reason: '需要自己跟做。' },
        ],
      },
      verdict: '选择性看，重点看演示。',
      overallMeaning: '视频讲 Cursor 入门和 AI 编程演示。',
      reason: '内容偏基础，但能建立入门流程。',
      worthReasons: ['演示路径清楚。'],
      bestFor: ['Cursor 新手'],
      notFor: ['已经熟悉 Cursor 的用户'],
      mustWatch: [
        {
          nodeId: 'c1',
          title: 'Cursor 入门',
          tag: 'method',
          reason: '核心演示。',
        },
      ],
      canWatch: [],
      canSkim: [],
      canSkip: [],
      reservations: [],
    },
    overview: '视频讲 Cursor 入门流程。',
    coreTakeaways: ['先用 AI 快速搭页面。'],
    reviewSummary: '适合了解 Cursor 基础操作。',
    chapters: [
      {
        id: 'c1',
        startCueId: 0,
        endCueId: 1,
        importance: 'recommended',
        contentTag: 'demo',
        title: 'Cursor 入门',
        summary: '演示 Cursor 基础流程。',
        watchGuide: '新手可看。',
        segments: [],
      },
    ],
  });
}
