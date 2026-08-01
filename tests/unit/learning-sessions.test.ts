import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@core/storage/db';
import {
  appendLearningMoment,
  cleanupStaleEmptyLearningSessions,
  EMPTY_LEARNING_SESSION_RETENTION_MS,
  getLearningSession,
  getOrCreateLearningSession,
  removeLearningMoment,
  saveLearningGuide,
  saveLearningMomentCoach,
  saveLearningExchange,
  saveLearningReview,
  updateLearningCoach,
  updateLearningGoal,
  updateLearningMoment,
} from '@core/storage/learning-sessions';
import type { LearningSession } from '@core/types';

describe('learning-sessions', () => {
  beforeEach(async () => {
    await db.learningSessions.clear();
  });

  const baseGuideDecision: NonNullable<LearningSession['guide']>['decision'] = {
    rating: 'selective',
    score: 68,
    valueProfile: {
      kind: 'opinion_commentary',
      label: '观点视频',
      criteria: [
        { label: '论点清晰', score: 68, reason: '中段观点明确。' },
        { label: '例子支撑', score: 64, reason: '支撑材料有限。' },
        { label: '表达效率', score: 66, reason: '其余部分价值较低。' },
      ],
    },
    verdict: '选择性看。',
    overallMeaning: '有少量可参考内容。',
    reason: '中段有明确观点，其余信息密度较低。',
    bestFor: ['想快速判断视频价值的人'],
    notFor: [],
    timePlans: [],
    mustWatch: [
      {
        title: '核心片段',
        tag: 'watch',
        reason: '这里有主要信息。',
      },
    ],
    canWatch: [],
    canSkim: [],
    canSkip: [],
    reservations: [],
  };

  function makeGuide(
    overrides: Partial<NonNullable<LearningSession['guide']>> = {},
  ): NonNullable<LearningSession['guide']> {
    return {
      decision: {
        ...baseGuideDecision,
        ...(overrides.decision ?? {}),
      },
      contentType: '观点视频',
      contentTypeReason: '主要是个人观点。',
      suggestedStance: '选择性看。',
      generatedAt: 1,
      modelUsed: 'model',
      ...overrides,
    };
  }

  function makeReview(
    overrides: Partial<NonNullable<LearningSession['review']>> = {},
  ): NonNullable<LearningSession['review']> {
    return {
      coreSummary: '核心',
      keyIdeas: [{ title: '观点', explanation: '解释' }],
      personalInsights: [],
      openQuestions: [],
      actionItems: [],
      finalReflection: '总结',
      generatedAt: 1,
      modelUsed: 'model',
      ...overrides,
    };
  }

  it('读取 v2 旧会话时迁移到 v3，清理派生产物但保留用户记录', async () => {
    const oldSession = {
      id: 'youtube:old-guide',
      schemaVersion: 2,
      platform: 'youtube',
      videoId: 'old-guide',
      goal: { mode: 'adaptive', focus: '' },
      coach: { enabled: false, intensity: 'light', customInstruction: '' },
      guide: {
        contentType: '旧陪看',
        contentTypeReason: '旧结构没有 decision。',
        suggestedStance: '旧建议。',
        cards: [],
        generatedAt: 1,
        modelUsed: 'old-model',
      },
      moments: [
        {
          id: 'm-old',
          kind: 'note',
          content: '这条用户记录应该保留。',
          createdAt: 2,
        },
      ],
      exchanges: [],
      review: {
        coreSummary: '旧笔记依赖旧 guide，应该失效。',
        keyIdeas: [{ title: '旧观点', explanation: '旧解释' }],
        personalInsights: [],
        openQuestions: [],
        actionItems: [],
        finalReflection: '旧总结',
        generatedAt: 3,
        modelUsed: 'old-model',
      },
      createdAt: 1,
      updatedAt: 3,
    } as unknown as LearningSession;
    await db.learningSessions.put(oldSession);

    const session = await getLearningSession({ platform: 'youtube', contentKey: 'old-guide' });

    expect(session?.schemaVersion).toBe(3);
    expect(session?.guide).toBeUndefined();
    expect(session?.review).toBeUndefined();
    expect(session?.moments[0]?.content).toBe('这条用户记录应该保留。');
    const stored = await db.learningSessions.get('youtube:old-guide');
    expect(stored?.schemaVersion).toBe(3);
    expect(stored?.guide).toBeUndefined();
    expect(stored?.review).toBeUndefined();
  });

  it('按 contentKey 隔离 B 站多 P', async () => {
    await appendLearningMoment({
      platform: 'bilibili',
      contentKey: 'BV1:p=1',
      kind: 'insight',
      content: 'P1 记录',
      id: 'm1',
      now: 1,
    });
    await appendLearningMoment({
      platform: 'bilibili',
      contentKey: 'BV1:p=2',
      kind: 'question',
      content: 'P2 记录',
      id: 'm2',
      now: 2,
    });
    expect(
      await getLearningSession({
        platform: 'bilibili',
        contentKey: 'BV1:p=1',
      }),
    ).toMatchObject({
      schemaVersion: 3,
      coach: { enabled: false, intensity: 'light' },
      moments: [{ content: 'P1 记录' }],
    });
    expect(
      (
        await getLearningSession({
          platform: 'bilibili',
          contentKey: 'BV1:p=2',
        })
      )?.moments[0]?.content,
    ).toBe('P2 记录');
  });

  it('同一学习会话按 outputLocale 隔离 guide/review，不让中英文互相覆盖', async () => {
    const identity = { platform: 'bilibili' as const, contentKey: 'BV-locale' };
    await saveLearningGuide({
      ...identity,
      guide: makeGuide({
        outputLocale: 'zh-CN',
        contentType: '中文分析',
        contentTypeReason: '中文理由。',
      }),
      now: 1,
    });
    await saveLearningReview({
      ...identity,
      review: makeReview({
        outputLocale: 'zh-CN',
        coreSummary: '中文笔记',
      }),
      now: 2,
    });
    await saveLearningGuide({
      ...identity,
      guide: makeGuide({
        outputLocale: 'en-US',
        contentType: 'English analysis',
        contentTypeReason: 'English reason.',
      }),
      now: 3,
    });
    await saveLearningReview({
      ...identity,
      review: makeReview({
        outputLocale: 'en-US',
        coreSummary: 'English notes',
      }),
      now: 4,
    });

    const session = await getLearningSession(identity);

    expect(session?.guidesByLocale?.['zh-CN']?.contentType).toBe('中文分析');
    expect(session?.guidesByLocale?.['en-US']?.contentType).toBe('English analysis');
    expect(session?.reviewsByLocale?.['zh-CN']?.coreSummary).toBe('中文笔记');
    expect(session?.reviewsByLocale?.['en-US']?.coreSummary).toBe('English notes');
    expect(session?.guide?.contentType).toBe('English analysis');
    expect(session?.review?.coreSummary).toBe('English notes');
  });

  it('旧单槽 guide/review 没有 outputLocale 时按 zh-CN 迁入 locale map', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'legacy-locale' };
    await db.learningSessions.put({
      id: 'youtube:legacy-locale',
      schemaVersion: 3,
      platform: 'youtube',
      videoId: 'legacy-locale',
      goal: { mode: 'adaptive', focus: '' },
      coach: { enabled: false, intensity: 'light', customInstruction: '' },
      guide: makeGuide({ contentType: '旧中文分析' }),
      moments: [],
      exchanges: [],
      review: makeReview({ coreSummary: '旧中文笔记' }),
      createdAt: 1,
      updatedAt: 1,
    });

    const session = await getLearningSession(identity);

    expect(session?.guidesByLocale?.['zh-CN']?.contentType).toBe('旧中文分析');
    expect(session?.reviewsByLocale?.['zh-CN']?.coreSummary).toBe('旧中文笔记');
  });

  it('目标、记录或加入笔记的问答变化会使旧学习笔记失效', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-1' };
    const base = await updateLearningGoal({
      ...identity,
      goal: { mode: 'understand', focus: '先理解' },
      now: 1,
    });
    const withReview = await saveLearningReview({
      ...identity,
      review: {
        coreSummary: '核心',
        keyIdeas: [{ title: '观点', explanation: '解释' }],
        personalInsights: [],
        openQuestions: [],
        actionItems: [],
        finalReflection: '总结',
        generatedAt: 2,
        modelUsed: 'model',
      },
      now: 2,
    });
    expect(withReview.review).toBeDefined();

    const changed = await saveLearningExchange({
      ...identity,
      exchange: {
        id: 'e1',
        question: '为什么？',
        answer: '因为有证据。',
        includedInReview: true,
        createdAt: 3,
      },
      now: 3,
    });
    expect(changed).not.toBeNull();
    if (!changed) throw new Error('expected included exchange to create session');
    expect(changed.review).toBeUndefined();
    expect(changed.createdAt).toBe(base.createdAt);
  });

  it('未加入笔记的普通问答不会保存，也不使旧学习笔记失效', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-exchange-passive' };
    await saveLearningReview({
      ...identity,
      review: {
        coreSummary: '旧总结',
        keyIdeas: [{ title: '旧观点', explanation: '旧解释' }],
        personalInsights: [],
        openQuestions: [],
        actionItems: [],
        finalReflection: '旧总结',
        generatedAt: 1,
        modelUsed: 'model',
      },
      now: 1,
    });

    const changed = await saveLearningExchange({
      ...identity,
      exchange: {
        id: 'e1',
        question: '临时问一下？',
        answer: '这条先不进笔记。',
        createdAt: 2,
      },
      now: 2,
    });

    expect(changed?.review).toBeDefined();
    expect(changed?.updatedAt).toBe(1);
    expect(changed?.exchanges).toEqual([]);
  });

  it('未标记加入笔记的普通问答不会创建空学习会话', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-exchange-no-session' };
    const ignored = await saveLearningExchange({
      ...identity,
      exchange: {
        id: 'e1',
        question: '临时问一下？',
        answer: '这条先不进笔记。',
        createdAt: 2,
      },
      now: 2,
    });

    expect(ignored).toBeNull();
    expect(await getLearningSession(identity)).toBeNull();
  });

  it('导师策略和打点回应会写入 session，并使旧学习笔记失效', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-guide' };
    await appendLearningMoment({
      ...identity,
      kind: 'insight',
      content: '这个梗我喜欢',
      id: 'm1',
      now: 1,
    });
    await saveLearningReview({
      ...identity,
      review: {
        coreSummary: '旧总结',
        keyIdeas: [{ title: '旧', explanation: '旧' }],
        personalInsights: [],
        openQuestions: [],
        actionItems: [],
        finalReflection: '旧',
        generatedAt: 2,
        modelUsed: 'model',
      },
      now: 2,
    });

    const withGuide = await saveLearningGuide({
      ...identity,
      guide: makeGuide({
        contentType: '娱乐整活',
        contentTypeReason: '重点是梗和反应。',
        suggestedStance: '轻松看，记录喜欢的点即可。',
        generatedAt: 3,
        modelUsed: 'model',
      }),
      now: 3,
    });
    expect(withGuide.review).toBeUndefined();
    expect(withGuide.guide?.contentType).toBe('娱乐整活');

    const withCoach = await saveLearningMomentCoach({
      ...identity,
      momentId: 'm1',
      coach: {
        response: '这是兴趣点，保留就够。',
        handling: 'release',
        suggestedQuestions: [],
        linkedTimestamps: [],
        generatedAt: 4,
        modelUsed: 'model',
      },
      now: 4,
    });
    expect(withCoach.moments[0]?.coach?.handling).toBe('release');
  });

  it('导师卡开关不影响已生成学习笔记', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-coach' };
    await saveLearningReview({
      ...identity,
      review: {
        coreSummary: '总结',
        keyIdeas: [{ title: '观点', explanation: '解释' }],
        personalInsights: [],
        openQuestions: [],
        actionItems: [],
        finalReflection: '总结',
        generatedAt: 1,
        modelUsed: 'model',
      },
      now: 1,
    });
    const changed = await updateLearningCoach({
      ...identity,
      coach: { enabled: true, intensity: 'deep', customInstruction: '少打扰' },
      now: 2,
    });
    expect(changed.review).toBeDefined();
    expect(changed.coach).toEqual({
      enabled: true,
      intensity: 'deep',
      customInstruction: '少打扰',
    });
  });

  it('编辑记录会保留来源标记并清除旧导师回应', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-edit' };
    await appendLearningMoment({
      ...identity,
      kind: 'note',
      content: '原始记录',
      source: 'mentor_card',
      originTitle: '陪看卡标题',
      id: 'm1',
      now: 1,
    });
    await saveLearningMomentCoach({
      ...identity,
      momentId: 'm1',
      coach: {
        response: '旧回应',
        handling: 'keep',
        suggestedQuestions: [],
        linkedTimestamps: [],
        generatedAt: 2,
        modelUsed: 'model',
      },
      now: 2,
    });

    const updated = await updateLearningMoment({
      ...identity,
      momentId: 'm1',
      kind: 'action',
      content: '我补充自己的备注',
      now: 3,
    });

    expect(updated.review).toBeUndefined();
    expect(updated.moments[0]).toMatchObject({
      kind: 'action',
      content: '我补充自己的备注',
      source: 'mentor_card',
      originTitle: '陪看卡标题',
    });
    expect(updated.moments[0]?.coach).toBeUndefined();
  });

  it('首次生成观看判断不再自动开启旧陪看提示，也不覆盖用户已有选择', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-guide-default' };
    const guide = makeGuide({
      contentType: '攻略教程',
      contentTypeReason: '有步骤和可操作细节。',
      suggestedStance: '跟着步骤看。',
      generatedAt: 1,
      modelUsed: 'model',
    });

    const first = await saveLearningGuide({
      ...identity,
      guide,
      now: 1,
    });
    expect(first.coach).toEqual({
      enabled: false,
      intensity: 'light',
      customInstruction: '',
    });

    await updateLearningCoach({
      ...identity,
      coach: { enabled: false, intensity: 'off', customInstruction: '先不要打扰' },
      now: 2,
    });
    const refreshed = await saveLearningGuide({
      ...identity,
      guide: { ...guide, generatedAt: 3 },
      now: 3,
    });
    expect(refreshed.coach).toEqual({
      enabled: false,
      intensity: 'off',
      customInstruction: '先不要打扰',
    });
  });

  it('同一问答 id 去重更新，记录可删除', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-2' };
    await saveLearningExchange({
      ...identity,
      exchange: { id: 'e1', question: 'Q', answer: 'A1', includedInReview: true, createdAt: 1 },
      now: 1,
    });
    const updated = await saveLearningExchange({
      ...identity,
      exchange: { id: 'e1', question: 'Q', answer: 'A2', includedInReview: true, createdAt: 1 },
      now: 2,
    });
    expect(updated).not.toBeNull();
    if (!updated) throw new Error('expected included exchange to update session');
    expect(updated.exchanges).toHaveLength(1);
    expect(updated.exchanges[0]?.answer).toBe('A2');
    expect(updated.exchanges[0]?.includedInReview).toBe(true);

    const withMoment = await appendLearningMoment({
      ...identity,
      kind: 'action',
      content: '去实践',
      id: 'm1',
      now: 3,
    });
    expect(withMoment.moments).toHaveLength(1);
    const removed = await removeLearningMoment({
      ...identity,
      momentId: 'm1',
      now: 4,
    });
    expect(removed.moments).toEqual([]);
  });

  it('移出笔记会删除已保存问答，并使旧学习笔记失效', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-exchange-remove' };
    await saveLearningExchange({
      ...identity,
      exchange: { id: 'e1', question: 'Q', answer: 'A', includedInReview: true, createdAt: 1 },
      now: 1,
    });
    await saveLearningReview({
      ...identity,
      review: {
        coreSummary: '旧总结',
        keyIdeas: [{ title: '旧观点', explanation: '旧解释' }],
        personalInsights: [],
        openQuestions: [],
        actionItems: [],
        finalReflection: '旧总结',
        generatedAt: 2,
        modelUsed: 'model',
      },
      now: 2,
    });

    const changed = await saveLearningExchange({
      ...identity,
      exchange: { id: 'e1', question: 'Q', answer: 'A', includedInReview: false, createdAt: 1 },
      now: 3,
    });

    expect(changed).not.toBeNull();
    if (!changed) throw new Error('expected existing exchange removal to update session');
    expect(changed.exchanges).toEqual([]);
    expect(changed.review).toBeUndefined();
  });

  it('最多只允许 8 条问答加入学习笔记', async () => {
    const identity = { platform: 'youtube' as const, contentKey: 'video-exchange-limit' };
    for (let index = 0; index < 8; index += 1) {
      await saveLearningExchange({
        ...identity,
        exchange: {
          id: `e${index}`,
          question: `Q${index}`,
          answer: `A${index}`,
          includedInReview: true,
          createdAt: index,
        },
        now: index,
      });
    }

    await expect(
      saveLearningExchange({
        ...identity,
        exchange: {
          id: 'e9',
          question: 'Q9',
          answer: 'A9',
          includedInReview: true,
          createdAt: 9,
        },
        now: 9,
      }),
    ).rejects.toThrow('最多只能加入 8 条提问问答到学习笔记');
  });

  it('只清理长期未更新的空壳学习会话，不删除有打点的未完成会话', async () => {
    const old = 1;
    const now = old + EMPTY_LEARNING_SESSION_RETENTION_MS + 1;
    await getOrCreateLearningSession({
      platform: 'youtube',
      contentKey: 'empty-old',
      now: old,
    });
    await appendLearningMoment({
      platform: 'youtube',
      contentKey: 'active-old',
      kind: 'note',
      content: '还没生成笔记，但这条不能删',
      now: old,
    });

    const removed = await cleanupStaleEmptyLearningSessions({ now });

    expect(removed).toBe(1);
    expect(await getLearningSession({ platform: 'youtube', contentKey: 'empty-old' })).toBeNull();
    expect(
      await getLearningSession({ platform: 'youtube', contentKey: 'active-old' }),
    ).not.toBeNull();
  });

  it('清理旧 schema 或不可读学习会话，避免不可恢复记录长期占用缓存', async () => {
    await db.learningSessions.put({
      id: 'youtube:legacy-session',
      schemaVersion: 1,
      platform: 'youtube',
      videoId: 'legacy-session',
      createdAt: 1,
      updatedAt: 1,
    } as unknown as LearningSession);

    const removed = await cleanupStaleEmptyLearningSessions({ now: 2 });

    expect(removed).toBe(1);
    expect(await db.learningSessions.get('youtube:legacy-session')).toBeUndefined();
  });
});
