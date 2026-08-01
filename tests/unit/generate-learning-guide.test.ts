import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateLearningGuide,
  LEARNING_GUIDE_MAX_TOKENS,
} from '@core/learning/generate-learning-guide';
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
  videoId: 'BV1guide',
  title: '设计评论',
  author: '作者',
  url: 'https://www.bilibili.com/video/BV1guide',
  duration: 487,
};

const cues: SubtitleCue[] = [
  { start: 0, end: 8, text: '开场介绍设计主题。' },
  { start: 8, end: 16, text: '拆解场景美术风格。' },
];

const session: LearningSession = {
  id: 'bilibili:BV1guide',
  schemaVersion: 3,
  platform: 'bilibili',
  videoId: 'BV1guide',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('generateLearningGuide', () => {
  beforeEach(() => {
    mocks.client.chat.mockReset();
  });

  it('首次输出不是合法 JSON 时重试一次，并保留更大的输出上限', async () => {
    mocks.client.chat
      .mockResolvedValueOnce({
        content: '这里是说明文字，不是 JSON',
        model: 'MiniMax-M3',
      })
      .mockResolvedValueOnce({
        content: validGuideJson(),
        model: 'MiniMax-M3',
      });

    const guide = await generateLearningGuide({
      settings: { ...createDefaultTextProviderSettings(), apiKey: 'sk-test' },
      metadata,
      transcriptCues: cues,
      analysis: null,
      session,
    });

    expect(guide.contentType).toBe('设计评论');
    expect(guide.decision.score).toBe(62);
    expect(mocks.client.chat).toHaveBeenCalledTimes(2);
    expect(mocks.client.chat).toHaveBeenNthCalledWith(1, expect.any(Array), {
      model: 'MiniMax-M2.7-highspeed',
      signal: expect.any(AbortSignal),
      maxTokens: LEARNING_GUIDE_MAX_TOKENS,
      usageFeature: 'analysis',
    });
    expect(mocks.client.chat).toHaveBeenNthCalledWith(2, expect.any(Array), {
      model: 'MiniMax-M2.7-highspeed',
      signal: expect.any(AbortSignal),
      maxTokens: LEARNING_GUIDE_MAX_TOKENS,
      usageFeature: 'analysis',
    });
    expect(String(mocks.client.chat.mock.calls[1]?.[0]?.[0]?.content)).toContain(
      '上一次输出不是可解析的 JSON',
    );
  });
});

function validGuideJson(): string {
  return JSON.stringify({
    contentType: '设计评论',
    contentTypeReason: '围绕游戏美术设计展开。',
    suggestedStance: '选择性看。',
    decision: {
      rating: 'selective',
      score: 62,
      valueProfile: {
        kind: 'opinion_commentary',
        label: '设计评论',
        criteria: [
          { label: '视角新鲜', score: 65, reason: '提供设计拆解视角。' },
          { label: '论点清晰', score: 62, reason: '围绕场景风格展开。' },
          { label: '表达效率', score: 58, reason: '后半段可以略过。' },
        ],
      },
      verdict: '选择性看。',
      overallMeaning: '视频主要拆解游戏场景风格。',
      reason: '前半段有方法参考，后半段可以略过。',
      worthReasons: ['提供了设计拆解视角。'],
      bestFor: ['想了解美术设计视角的人'],
      notFor: ['只想看攻略的人'],
      learningValue: ['学习如何拆解场景风格'],
      timePlans: [],
      mustWatch: [],
      canWatch: [],
      canSkim: [],
      canSkip: [],
      reservations: [],
    },
  });
}
