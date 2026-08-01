import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateLearningReview } from '@core/learning/generate-learning-review';
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
  videoId: 'BV1review',
  title: '学习笔记测试',
  author: '作者',
  url: 'https://www.bilibili.com/video/BV1review',
  duration: 360,
};

const cues: SubtitleCue[] = [
  { start: 0, end: 8, text: '介绍任务拆解。' },
  { start: 8, end: 16, text: '总结迁移方法。' },
];

const session: LearningSession = {
  id: 'bilibili:BV1review',
  schemaVersion: 3,
  platform: 'bilibili',
  videoId: 'BV1review',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('generateLearningReview', () => {
  beforeEach(() => {
    mocks.client.chat.mockReset();
  });

  it('生成学习笔记时用 notes 作为免费服务用量功能标识', async () => {
    mocks.client.chat.mockResolvedValue({
      content: validReviewJson(),
      model: 'MiniMax-M3',
    });

    await generateLearningReview({
      settings: { ...createDefaultTextProviderSettings(), apiKey: 'sk-test' },
      metadata,
      transcriptCues: cues,
      analysis: null,
      session,
    });

    expect(mocks.client.chat).toHaveBeenCalledWith(expect.any(Array), {
      model: 'MiniMax-M2.7-highspeed',
      usageFeature: 'notes',
    });
  });
});

function validReviewJson(): string {
  return JSON.stringify({
    coreSummary: '视频讲了如何拆解任务。',
    keyIdeas: [{ title: '先拆任务', explanation: '把大任务拆成可执行步骤。' }],
    personalInsights: ['我可以先写出最小任务链。'],
    transferReflection: '可以迁移到自己的项目规划里。',
    openQuestions: ['哪些任务不适合继续拆？'],
    actionItems: ['用一个真实项目试一次。'],
    finalReflection: '核心价值是降低启动成本。',
  });
}
