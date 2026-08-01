import { describe, expect, it, vi } from 'vitest';
import {
  createWatchDecisionController,
  type WatchDecisionControllerDeps,
} from '@extension/background/watch-decision-controller';
import { createContentContextDigest } from '@core/learning/content-context-digest';
import type { WatchDecisionPackage } from '@core/learning/watch-decision-package-schema';
import type {
  LearningGuide,
  LearningSession,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import type { WatchDecisionPortMessage } from '@shared/messages';
import type { TextProviderSettings } from '@shared/settings';

const SETTINGS: TextProviderSettings = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.minimaxi.com',
  model: 'MiniMax-M3',
  fastModel: 'MiniMax-M2.7-highspeed',
  analysisMode: 'subtitle',
  thinkingMode: 'disabled',
  webSearchEnabled: false,
  updatedAt: 1,
};

const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1watch',
  title: 'Watch decision',
  author: 'tester',
  url: 'https://www.bilibili.com/video/BV1watch',
};

const CUES: SubtitleCue[] = [
  { start: 0, end: 3, text: '开场' },
  { start: 3, end: 8, text: '核心方法' },
];

const SESSION: LearningSession = {
  id: 'bilibili:BV1watch:p=1',
  schemaVersion: 3,
  platform: 'bilibili',
  videoId: 'BV1watch:p=1',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

const ANALYSIS: VideoAnalysis = {
  overview: '视频讲核心方法。',
  watchStrategy: [],
  coreTakeaways: [],
  reviewSummary: '复盘',
  chapters: [],
  timeline: [],
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

const GUIDE: LearningGuide = {
  decision: {
    rating: 'worth_watching',
    score: 82,
    valueProfile: {
      kind: 'learning_tutorial',
      label: '课程讲解',
      criteria: [
        { label: '结构清晰', score: 82, reason: '核心方法集中。' },
        { label: '可迁移性', score: 82, reason: '方法可复用。' },
        { label: '实践成本', score: 82, reason: '适合自行尝试。' },
      ],
    },
    verdict: '值得看。',
    overallMeaning: '视频讲核心方法。',
    reason: '方法可复用。',
    worthReasons: ['方法可复用'],
    bestFor: ['想学方法的人'],
    notFor: [],
    timePlans: [],
    mustWatch: [],
    canWatch: [],
    canSkim: [],
    canSkip: [],
    reservations: [],
  },
  contentType: '课程讲解',
  contentTypeReason: '讲方法。',
  suggestedStance: '值得看。',
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
};

function makePackage(overrides: Partial<WatchDecisionPackage> = {}): WatchDecisionPackage {
  return {
    analysis: ANALYSIS,
    guide: GUIDE,
    ...overrides,
  };
}

function buildHarness(overrides: Partial<WatchDecisionControllerDeps> = {}): {
  readonly controller: ReturnType<typeof createWatchDecisionController>;
  readonly posted: WatchDecisionPortMessage[];
  readonly deps: WatchDecisionControllerDeps;
} {
  const posted: WatchDecisionPortMessage[] = [];
  const saveLearningGuide = vi.fn().mockResolvedValue({ ...SESSION, guide: GUIDE });
  const deps: WatchDecisionControllerDeps = {
    getActiveVideoContext: vi.fn().mockResolvedValue({
      platform: 'bilibili',
      videoId: 'BV1watch',
      contentKey: 'BV1watch:p=1',
    }),
    readSettings: vi.fn().mockResolvedValue(SETTINGS),
    getContentContext: vi.fn().mockResolvedValue({
      metadata: METADATA,
      transcriptCues: CUES,
      transcriptSource: 'official',
    }),
    getCachedAnalysis: vi.fn().mockResolvedValue(null),
    getOrCreateLearningSession: vi.fn().mockResolvedValue(SESSION),
    saveCachedAnalysis: vi.fn().mockResolvedValue(undefined),
    saveLearningGuide,
    createErrorResponse: (code, message) => ({ ok: false, error: { code, message } }),
    postMessage: (message) => {
      posted.push(message);
    },
    now: vi.fn(() => 1_000),
    generatePackage: vi.fn(async () => makePackage()),
    ...overrides,
  };
  return {
    controller: createWatchDecisionController(deps),
    posted,
    deps,
  };
}

describe('createWatchDecisionController', () => {
  it('稳定生成同源判断包：只推阶段进度，成功后保存 analysis/guide 并 DONE', async () => {
    const harness = buildHarness();

    await harness.controller.handleRequest({
      requestId: 'req-1',
      analysisMode: 'subtitle',
      forceRefresh: true,
    });

    expect(harness.posted.map((message) => message.type)).toEqual([
      'WATCH_DECISION_STATUS',
      'WATCH_DECISION_STATUS',
      'WATCH_DECISION_STATUS',
      'WATCH_DECISION_STATUS',
      'WATCH_DECISION_DONE',
    ]);
    expect(harness.posted).toContainEqual({
      type: 'WATCH_DECISION_STATUS',
      requestId: 'req-1',
      text: '正在稳定生成结构化结果，完成后一次性展示',
    });
    expect(harness.deps.generatePackage).toHaveBeenCalledWith({
      prepared: expect.objectContaining({
        metadata: METADATA,
        transcriptCues: CUES,
        session: SESSION,
      }),
      signal: expect.any(AbortSignal),
    });
    expect(harness.deps.saveCachedAnalysis).toHaveBeenCalledWith({
      metadata: METADATA,
      analysis: { ...ANALYSIS, outputLocale: 'zh-CN' },
      subtitleCueCount: 2,
      transcriptCues: CUES,
      subtitlePreferenceKey: 'zh-cn,en-us',
      timings: [
        { label: '模型分析 · MiniMax-M3', durationMs: 0 },
        { label: '总耗时', durationMs: 0 },
      ],
    });
    expect(harness.deps.saveLearningGuide).toHaveBeenCalledWith({
      platform: 'bilibili',
      contentKey: 'BV1watch:p=1',
      guide: { ...GUIDE, outputLocale: 'zh-CN' },
    });
    expect(harness.posted.at(-1)).toMatchObject({
      type: 'WATCH_DECISION_DONE',
      requestId: 'req-1',
      session: { guide: GUIDE },
      receivedCharacters: 0,
    });
  });

  it('旧 guide 和 analysis 同源时直接复用，不重新请求模型', async () => {
    const contextDigest = createContentContextDigest({
      metadata: METADATA,
      transcriptCues: CUES,
    });
    const analysis: VideoAnalysis = {
      ...ANALYSIS,
      contextDigest,
      timelineDigest: 'td',
    };
    const guide: LearningGuide = {
      ...GUIDE,
      contextDigest,
      timelineDigest: 'td',
    };
    const generatePackage = vi.fn();
    const harness = buildHarness({
      getCachedAnalysis: vi.fn().mockResolvedValue({
        metadata: METADATA,
        analysis,
        subtitleCueCount: 2,
        transcriptCues: CUES,
        timings: [],
      }),
      getOrCreateLearningSession: vi.fn().mockResolvedValue({
        ...SESSION,
        guide,
      }),
      generatePackage,
    });

    await harness.controller.handleRequest({
      requestId: 'req-cache',
      analysisMode: 'subtitle',
    });

    expect(generatePackage).not.toHaveBeenCalled();
    expect(harness.deps.saveCachedAnalysis).not.toHaveBeenCalled();
    expect(harness.deps.saveLearningGuide).not.toHaveBeenCalled();
    expect(harness.posted.at(-1)).toMatchObject({
      type: 'WATCH_DECISION_DONE',
      reused: true,
      session: { guide },
    });
  });

  it('模型输出失败时推可读错误且不保存半截结果', async () => {
    const harness = buildHarness({
      generatePackage: vi.fn().mockRejectedValue(new Error('invalid json')),
    });

    await harness.controller.handleRequest({
      requestId: 'req-fail',
      analysisMode: 'subtitle',
      forceRefresh: true,
    });

    expect(harness.deps.saveCachedAnalysis).not.toHaveBeenCalled();
    expect(harness.deps.saveLearningGuide).not.toHaveBeenCalled();
    expect(harness.posted.at(-1)).toEqual({
      type: 'WATCH_DECISION_ERROR',
      requestId: 'req-fail',
      code: 'LEARNING_GUIDE_GENERATION_FAILED',
      message: '分析生成失败：模型输出不完整或格式异常。如已有旧分析，会继续保留；请稍后重试。',
    });
  });
});
