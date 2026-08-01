import { describe, expect, it, vi } from 'vitest';
import {
  createLearningReviewHandler,
  type ActiveLearningContext,
  type LearningReviewHandlerDeps,
  type LearningReviewRequest,
} from '@extension/background/handlers/learning-review-handler';
import { LearningGuideGenerationTimeoutError } from '@core/learning/generate-learning-guide';
import { createContentContextDigest } from '@core/learning/content-context-digest';
import type {
  LearningReview,
  LearningSession,
  LearningGuide,
  LearningMomentCoach,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import type { TextProviderSettings } from '@shared/settings';

const CONTEXT: ActiveLearningContext = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  contentKey: 'BV1xx:p=10',
};

const SETTINGS: TextProviderSettings = {
  apiKey: 'real-key',
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
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试',
  author: '作者',
};

const ANALYSIS: VideoAnalysis = {
  overview: 'x',
  watchStrategy: [],
  coreTakeaways: [],
  reviewSummary: '',
  chapters: [],
  timeline: [],
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

const SESSION: LearningSession = {
  id: 'bilibili:BV1xx:p=10',
  schemaVersion: 3,
  platform: 'bilibili',
  videoId: 'BV1xx:p=10',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [
    {
      id: 'm1',
      kind: 'insight',
      content: '我喜欢这个转场',
      timestamp: 12,
      createdAt: 1,
    },
  ],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

const REVIEW: LearningReview = {
  coreSummary: '核心',
  keyIdeas: [{ title: '观点', explanation: '解释' }],
  personalInsights: [],
  openQuestions: [],
  actionItems: [],
  finalReflection: '总结',
  generatedAt: 2,
  modelUsed: 'MiniMax-M2.7-highspeed',
};

const GUIDE: LearningGuide = {
  contentType: '娱乐整活',
  contentTypeReason: '主要是笑点。',
  suggestedStance: '轻松看，记录喜欢的梗。',
  decision: {
    rating: 'selective',
    score: 62,
    valueProfile: {
      kind: 'entertainment_reaction',
      label: '娱乐整活',
      criteria: [
        { label: '情绪价值', score: 68, reason: '主要提供笑点。' },
        { label: '节目效果', score: 62, reason: '趣味片段集中。' },
        { label: '放松观看', score: 58, reason: '不适合系统学习。' },
      ],
    },
    verdict: '轻松看，记录喜欢的梗。',
    overallMeaning: '主要提供放松和灵感，不是系统教程。',
    reason: '笑点可看，但学习密度不高。',
    bestFor: ['想放松或收集灵感的人'],
    notFor: ['想学系统方法的人'],
    timePlans: [],
    mustWatch: [
      {
        title: '笑点片段',
        tag: 'case',
        reason: '这里体现主要趣味。',
        startTimestamp: 12,
      },
    ],
    canWatch: [],
    canSkim: [
      {
        title: '铺垫闲聊',
        tag: 'skim',
        reason: '了解背景即可。',
      },
    ],
    canSkip: [],
    reservations: ['不要把娱乐效果当成通用方法。'],
    },
  generatedAt: 2,
  modelUsed: 'MiniMax-M2.7-highspeed',
};

const MOMENT_COACH: LearningMomentCoach = {
  response: '这是兴趣点，保留就好。',
  handling: 'release',
  suggestedQuestions: [],
  linkedTimestamps: [],
  generatedAt: 2,
  modelUsed: 'MiniMax-M2.7-highspeed',
};

function makeDeps(
  overrides: Partial<LearningReviewHandlerDeps> = {},
): LearningReviewHandlerDeps {
  return {
    getActiveVideoContext: vi.fn().mockResolvedValue(CONTEXT),
    readSettings: vi.fn().mockResolvedValue(SETTINGS),
    getContentContext: vi.fn().mockResolvedValue({
      metadata: METADATA,
      transcriptCues: [{ start: 0, text: '字幕' }],
      transcriptSource: 'official',
    }),
    getCachedAnalysis: vi.fn().mockResolvedValue({
      metadata: METADATA,
      analysis: ANALYSIS,
      subtitleCueCount: 1,
      timings: [],
    }),
    getLearningSession: vi.fn().mockResolvedValue(SESSION),
    getOrCreateLearningSession: vi.fn().mockResolvedValue(SESSION),
    updateLearningGoal: vi.fn().mockResolvedValue(SESSION),
    updateLearningCoach: vi.fn().mockResolvedValue(SESSION),
    saveLearningGuide: vi
      .fn()
      .mockResolvedValue({ ...SESSION, guide: GUIDE }),
    saveCachedAnalysis: vi.fn().mockResolvedValue(undefined),
    appendLearningMoment: vi.fn().mockResolvedValue(SESSION),
    updateLearningMoment: vi.fn().mockResolvedValue(SESSION),
    removeLearningMoment: vi.fn().mockResolvedValue(SESSION),
    saveLearningMomentCoach: vi
      .fn()
      .mockResolvedValue({ ...SESSION, moments: [{ ...SESSION.moments[0]!, coach: MOMENT_COACH }] }),
    saveLearningExchange: vi.fn().mockResolvedValue(SESSION),
    saveLearningReview: vi
      .fn()
      .mockResolvedValue({ ...SESSION, review: REVIEW }),
    generateLearningReview: vi.fn().mockResolvedValue(REVIEW),
    generateLearningGuide: vi.fn().mockResolvedValue(GUIDE),
    generateWatchDecisionPackage: vi.fn().mockResolvedValue({
      analysis: ANALYSIS,
      guide: GUIDE,
    }),
    generateLearningMomentCoach: vi.fn().mockResolvedValue(MOMENT_COACH),
    createErrorResponse: (code, message) => ({
      ok: false,
      error: { code, message },
    }),
    ...overrides,
  };
}

describe('createLearningReviewHandler', () => {
  it('无页面时读取返回 null，写操作返回错误', async () => {
    const deps = makeDeps({
      getActiveVideoContext: vi.fn().mockResolvedValue(null),
    });
    const handler = createLearningReviewHandler(deps);
    expect(await handler({ type: 'GET_LEARNING_SESSION' })).toEqual({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: null,
    });
    expect(
      await handler({
        type: 'ADD_LEARNING_MOMENT',
        payload: { kind: 'insight', content: '记录' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NO_PAGE_CONTEXT' },
    });
  });

  it('读取学习会话时剔除旧版 scoreBreakdown 分析，避免 UI 渲染旧结构', async () => {
    const legacyGuide = {
      ...GUIDE,
      decision: {
        ...GUIDE.decision,
        valueProfile: undefined,
        scoreBreakdown: {
          informationDensity: 70,
          uniqueValue: 65,
          actionability: 55,
          evidenceReliability: 60,
          timeEfficiency: 68,
        },
      },
    } as unknown as LearningGuide;
    const deps = makeDeps({
      getLearningSession: vi.fn().mockResolvedValue({
        ...SESSION,
        guide: legacyGuide,
      }),
    });
    const handler = createLearningReviewHandler(deps);

    await expect(handler({ type: 'GET_LEARNING_SESSION' })).resolves.toEqual({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: SESSION,
    });
  });

  it('空记录被拒绝，不写入存储', async () => {
    const deps = makeDeps();
    const handler = createLearningReviewHandler(deps);
    const request: LearningReviewRequest = {
      type: 'ADD_LEARNING_MOMENT',
      payload: { kind: 'question', content: '   ' },
    };
    expect(await handler(request)).toMatchObject({
      ok: false,
      error: { code: 'EMPTY_LEARNING_MOMENT' },
    });
    expect(deps.appendLearningMoment).not.toHaveBeenCalled();
  });

  it('生成学习笔记不强制依赖时间线，并保存结果', async () => {
    const deps = makeDeps({
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_REVIEW',
      payload: { forceRefresh: true },
    });
    expect(response).toMatchObject({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: { review: REVIEW },
    });
    expect(deps.generateLearningReview).toHaveBeenCalledWith(
      expect.objectContaining({
        analysis: null,
        session: SESSION,
      }),
    );
    expect(deps.saveLearningReview).toHaveBeenCalledWith({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=10',
      review: expect.objectContaining({
        ...REVIEW,
        contextDigest: expect.any(String),
      }),
    });
  });

  it('生成学习笔记失败时返回用户可读错误，不暴露内部结构校验信息', async () => {
    const deps = makeDeps({
      generateLearningReview: vi
        .fn()
        .mockRejectedValue(new Error('[{"code":"invalid_type","path":["finalReflection"]}]')),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_REVIEW',
      payload: { forceRefresh: true },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'LEARNING_REVIEW_GENERATION_FAILED',
        message: '学习笔记生成失败：模型输出不完整或格式异常，请重试。',
      },
    });
    expect(JSON.stringify(response)).not.toContain('invalid_type');
    expect(deps.saveLearningReview).not.toHaveBeenCalled();
  });

  it('生成学习笔记时不把 digest 不匹配的旧观看判断传给模型', async () => {
    const deps = makeDeps({
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
      getOrCreateLearningSession: vi.fn().mockResolvedValue({
        ...SESSION,
        guide: GUIDE,
        review: REVIEW,
      }),
    });
    const handler = createLearningReviewHandler(deps);
    await handler({
      type: 'GENERATE_LEARNING_REVIEW',
      payload: { forceRefresh: true },
    });

    expect(deps.generateLearningReview).toHaveBeenCalledWith(
      expect.objectContaining({
        analysis: null,
        session: expect.not.objectContaining({
          guide: expect.anything(),
        }),
      }),
    );
  });

  it('生成分析不强制依赖导航，并只保存到 session', async () => {
    const deps = makeDeps({
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_GUIDE',
      payload: { forceRefresh: true },
    });
    expect(response).toMatchObject({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: { guide: GUIDE },
    });
    expect(deps.generateLearningGuide).toHaveBeenCalledWith(
      expect.objectContaining({
        analysis: null,
        session: SESSION,
      }),
    );
    expect(deps.saveCachedAnalysis).not.toHaveBeenCalled();
    expect(deps.saveLearningGuide).toHaveBeenCalledWith({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=10',
      guide: expect.objectContaining({
        ...GUIDE,
        contextDigest: expect.any(String),
        generationDurationMs: expect.any(Number),
      }),
    });
  });

  it('guide 来自同一内容底座时复用旧分析', async () => {
    const transcriptCues = [{ start: 0, text: '字幕' }];
    const contextDigest = createContentContextDigest({
      metadata: METADATA,
      transcriptCues,
    });
    const timelineDigest = 'timeline-digest';
    const reusableAnalysis: VideoAnalysis = {
      ...ANALYSIS,
      contextDigest,
      timelineDigest,
    };
    const reusableGuide: LearningGuide = {
      ...GUIDE,
      contextDigest,
      timelineDigest,
    };
    const deps = makeDeps({
      getContentContext: vi.fn().mockResolvedValue({
        metadata: METADATA,
        transcriptCues,
        transcriptSource: 'official',
      }),
      getCachedAnalysis: vi.fn().mockResolvedValue({
        metadata: METADATA,
        analysis: reusableAnalysis,
        subtitleCueCount: 1,
        timings: [],
      }),
      getOrCreateLearningSession: vi.fn().mockResolvedValue({
        ...SESSION,
        guide: reusableGuide,
      }),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_GUIDE',
    });

    expect(response).toMatchObject({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: { guide: reusableGuide },
    });
    expect(deps.generateLearningGuide).not.toHaveBeenCalled();
    expect(deps.saveCachedAnalysis).not.toHaveBeenCalled();
    expect(deps.saveLearningGuide).not.toHaveBeenCalled();
  });

  it('按 outputLocale 读取同一 session 里的 guide/review，不被当前单槽位语言覆盖', async () => {
    const transcriptCues = [{ start: 0, text: 'subtitle' }];
    const contextDigest = createContentContextDigest({
      metadata: METADATA,
      transcriptCues,
    });
    const timelineDigest = 'timeline-locale-map';
    const reusableAnalysis: VideoAnalysis = {
      ...ANALYSIS,
      contextDigest,
      timelineDigest,
      outputLocale: 'en-US',
    };
    const zhGuide: LearningGuide = {
      ...GUIDE,
      outputLocale: 'zh-CN',
      contextDigest,
      timelineDigest,
    };
    const enGuide: LearningGuide = {
      ...GUIDE,
      outputLocale: 'en-US',
      contextDigest,
      timelineDigest,
      contentType: 'Tutorial',
      contentTypeReason: 'It explains a reusable workflow.',
      suggestedStance: 'Watch selectively.',
      decision: {
        ...GUIDE.decision,
        valueProfile: {
          kind: 'learning_tutorial',
          label: 'Tutorial',
          criteria: [
            { label: 'Structure clarity', score: 70, reason: 'The flow is easy to scan.' },
            { label: 'Transferable methods', score: 72, reason: 'The method can be reused.' },
            { label: 'Complete steps', score: 68, reason: 'Most key steps are covered.' },
          ],
        },
        verdict: 'Watch selectively.',
        overallMeaning: 'A compact workflow overview.',
        reason: 'The reusable part is useful, but not every segment is essential.',
        bestFor: ['Viewers who need a workflow overview'],
        notFor: ['Viewers who need a full course'],
        mustWatch: [
          {
            title: 'Workflow setup',
            tag: 'method',
            reason: 'This is the reusable part.',
          },
        ],
        canWatch: [],
        canSkim: [],
        canSkip: [],
        reservations: ['The demo is brief.'],
      },
    };
    const zhReview: LearningReview = {
      ...REVIEW,
      outputLocale: 'zh-CN',
      contextDigest,
      timelineDigest,
      coreSummary: '中文笔记',
    };
    const enReview: LearningReview = {
      ...REVIEW,
      outputLocale: 'en-US',
      contextDigest,
      timelineDigest,
      coreSummary: 'English notes',
    };
    const sessionWithLocaleMaps: LearningSession = {
      ...SESSION,
      guide: zhGuide,
      review: zhReview,
      guidesByLocale: {
        'zh-CN': zhGuide,
        'en-US': enGuide,
      },
      reviewsByLocale: {
        'zh-CN': zhReview,
        'en-US': enReview,
      },
    };
    const deps = makeDeps({
      getContentContext: vi.fn().mockResolvedValue({
        metadata: METADATA,
        transcriptCues,
        transcriptSource: 'official',
      }),
      getCachedAnalysis: vi.fn().mockResolvedValue({
        metadata: METADATA,
        analysis: reusableAnalysis,
        subtitleCueCount: 1,
        timings: [],
      }),
      getOrCreateLearningSession: vi.fn().mockResolvedValue(sessionWithLocaleMaps),
    });
    const handler = createLearningReviewHandler(deps);

    const guideResponse = await handler({
      type: 'GENERATE_LEARNING_GUIDE',
      payload: { outputLocale: 'en-US' },
    });
    const reviewResponse = await handler({
      type: 'GENERATE_LEARNING_REVIEW',
      payload: { outputLocale: 'en-US' },
    });

    expect(guideResponse).toMatchObject({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: { guide: { contentType: 'Tutorial' } },
    });
    expect(reviewResponse).toMatchObject({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: { review: { coreSummary: 'English notes' } },
    });
    expect(deps.generateLearningGuide).not.toHaveBeenCalled();
    expect(deps.generateLearningReview).not.toHaveBeenCalled();
  });

  it('英文请求遇到明显中文的旧 guide 时不复用，避免前端一直显示 generated 空态', async () => {
    const contextDigest = 'digest-visible';
    const timelineDigest = 'timeline-visible';
    const transcriptCues = [{ start: 0, text: '字幕' }];
    const reusableAnalysis = {
      ...ANALYSIS,
      contextDigest,
      timelineDigest,
      outputLocale: 'en-US' as const,
    };
    const mislabeledGuide: LearningGuide = {
      ...GUIDE,
      outputLocale: 'en-US',
      contextDigest,
      timelineDigest,
    };
    const deps = makeDeps({
      getContentContext: vi.fn().mockResolvedValue({
        metadata: METADATA,
        transcriptCues,
        transcriptSource: 'official',
      }),
      getCachedAnalysis: vi.fn().mockResolvedValue({
        metadata: METADATA,
        analysis: reusableAnalysis,
        subtitleCueCount: 1,
        timings: [],
      }),
      getOrCreateLearningSession: vi.fn().mockResolvedValue({
        ...SESSION,
        guide: mislabeledGuide,
      }),
    });
    const handler = createLearningReviewHandler(deps);
    await handler({
      type: 'GENERATE_LEARNING_GUIDE',
      payload: { outputLocale: 'en-US' },
    });

    expect(deps.generateLearningGuide).toHaveBeenCalledTimes(1);
    expect(deps.saveLearningGuide).toHaveBeenCalledTimes(1);
  });

  it('分析生成失败时返回用户可读错误，不保留生成中状态给前端', async () => {
    const deps = makeDeps({
      generateLearningGuide: vi
        .fn()
        .mockRejectedValue(new Error('[{"code":"invalid_type","path":["decision"]}]')),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_GUIDE',
      payload: { forceRefresh: true },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'LEARNING_GUIDE_GENERATION_FAILED',
        message: '分析生成失败：模型输出不完整或格式异常。如已有旧分析，会继续保留；请稍后重试。',
      },
    });
    expect(JSON.stringify(response)).not.toContain('invalid_type');
    expect(deps.saveCachedAnalysis).not.toHaveBeenCalled();
    expect(deps.saveLearningGuide).not.toHaveBeenCalled();
  });

  it('分析生成超时时返回明确错误，旧分析由前端继续展示', async () => {
    const deps = makeDeps({
      generateLearningGuide: vi
        .fn()
        .mockRejectedValue(new LearningGuideGenerationTimeoutError(180_000)),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_GUIDE',
      payload: { forceRefresh: true },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'LEARNING_GUIDE_GENERATION_TIMEOUT',
        message: '分析生成超时：模型这次没有在 3 分钟内完成。旧分析已保留，可以稍后重试。',
      },
    });
    expect(deps.saveCachedAnalysis).not.toHaveBeenCalled();
    expect(deps.saveLearningGuide).not.toHaveBeenCalled();
  });

  it('处理单条记录时调用导师回应并写回对应 moment', async () => {
    const deps = makeDeps();
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'PROCESS_LEARNING_MOMENT',
      payload: { momentId: 'm1' },
    });
    expect(response).toMatchObject({
      ok: true,
      type: 'LEARNING_SESSION',
    });
    expect(deps.generateLearningMomentCoach).toHaveBeenCalledWith(
      expect.objectContaining({
        moment: SESSION.moments[0],
      }),
    );
    expect(deps.saveLearningMomentCoach).toHaveBeenCalledWith({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=10',
      momentId: 'm1',
      coach: MOMENT_COACH,
    });
  });

  it('导师卡设置只更新本地 session，不调用 MiniMax', async () => {
    const deps = makeDeps();
    const handler = createLearningReviewHandler(deps);
    await handler({
      type: 'UPDATE_LEARNING_COACH',
      payload: { enabled: true, intensity: 'deep', customInstruction: '少打扰' },
    });
    expect(deps.updateLearningCoach).toHaveBeenCalledWith({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=10',
      coach: { enabled: true, intensity: 'deep', customInstruction: '少打扰' },
    });
    expect(deps.generateLearningGuide).not.toHaveBeenCalled();
    expect(deps.generateWatchDecisionPackage).not.toHaveBeenCalled();
  });

  it('没有内容底座时返回 CONTENT_CONTEXT_REQUIRED', async () => {
    const deps = makeDeps({
      getContentContext: vi.fn().mockResolvedValue(null),
    });
    const handler = createLearningReviewHandler(deps);
    expect(
      await handler({ type: 'GENERATE_LEARNING_REVIEW' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'CONTENT_CONTEXT_REQUIRED' },
    });
    expect(deps.generateLearningReview).not.toHaveBeenCalled();
  });

  it('旧转写模式不生成学习笔记', async () => {
    const getCachedAnalysis = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      getContentContext: vi.fn().mockResolvedValue(null),
      getCachedAnalysis,
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_REVIEW',
      payload: { forceRefresh: true, analysisMode: 'transcript' },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_ANALYSIS_MODE' },
    });
    expect(getCachedAnalysis).not.toHaveBeenCalled();
    expect(deps.generateLearningReview).not.toHaveBeenCalled();
  });

  it('旧视频理解模式不生成陪看策略和学习笔记', async () => {
    const deps = makeDeps({
      getContentContext: vi.fn().mockResolvedValue(null),
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'GENERATE_LEARNING_GUIDE',
      payload: { analysisMode: 'multimodal' },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_ANALYSIS_MODE' },
    });
    expect(deps.generateLearningGuide).not.toHaveBeenCalled();
  });

  it('旧转写模式处理打点记录时不生成导师回应', async () => {
    const deps = makeDeps({
      getContentContext: vi.fn().mockResolvedValue(null),
      getCachedAnalysis: vi.fn().mockResolvedValue(null),
    });
    const handler = createLearningReviewHandler(deps);
    const response = await handler({
      type: 'PROCESS_LEARNING_MOMENT',
      payload: { momentId: 'm1', analysisMode: 'transcript' },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_ANALYSIS_MODE' },
    });
    expect(deps.generateLearningMomentCoach).not.toHaveBeenCalled();
  });
});
