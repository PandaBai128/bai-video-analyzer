import { describe, expect, it } from 'vitest';
import { parseLearningGuideJson } from '@core/learning/learning-guide-schema';

function tutorialValueProfile() {
  return {
    kind: 'learning_tutorial',
    label: '教程学习',
    criteria: [
      { label: '结构清晰', score: 91 },
      { label: '可迁移方法', score: 87 },
      { label: '步骤完整', score: 82 },
      { label: '时效可控', score: 84 },
      { label: '实践成本', score: 80 },
    ],
  };
}

describe('parseLearningGuideJson', () => {
  it('英文输出缺字段时 fallback 不混入中文默认文案', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          score: 45,
          valueProfile: {
            kind: 'learning_tutorial',
            criteria: [],
          },
          timePlans: [
            {
              budget: '10min',
              segments: [{ title: 'Opening segment', tag: 'watch' }],
            },
          ],
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
      }),
      generatedAt: 9,
      modelUsed: 'model',
      outputLocale: 'en-US',
    });

    expect(guide.contentType).toBe('Video content');
    expect(guide.contentTypeReason).toBe(
      'The model did not provide a content-type reason.',
    );
    expect(guide.decision.reason).toBe('The model did not provide a clear reason.');
    expect(guide.decision.verdict).toBe(
      'Quick browse: The model did not provide a clear reason.',
    );
    expect(guide.decision.timePlans[0]).toMatchObject({
      label: 'Only 10 minutes',
      instruction: 'Use the segments above to decide what to watch.',
    });
    expect(
      JSON.stringify({
        contentType: guide.contentType,
        contentTypeReason: guide.contentTypeReason,
        verdict: guide.decision.verdict,
        overallMeaning: guide.decision.overallMeaning,
        timePlans: guide.decision.timePlans,
      }),
    ).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('解析视频级观看决策和四组片段', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'worth_watching',
          score: 88,
          valueProfile: tutorialValueProfile(),
          verdict: '值得看，但只需要重点看方法段。',
          overallMeaning: '这个视频主要讲任务拆解方法，能帮助用户节省摸索流程的时间。',
          reason: '中段给出了可复用步骤，前后铺垫和闲聊信息密度较低。',
          worthReasons: [
            '中段给出了可复用步骤。',
            '案例能帮助用户减少摸索时间。',
            '可以快速判断方法是否适合自己。',
            '第四条应该被裁掉。',
          ],
          bestFor: ['想学习工作流的人'],
          notFor: ['只想看娱乐内容的人'],
          learningValue: [
            '可以参考任务拆解步骤。',
            '可以参考案例复盘方式。',
            '可以参考轻重取舍思路。',
            '第四条应该被裁掉。',
          ],
          timePlans: [
            {
              budget: '10min',
              label: '只有 10 分钟',
              instruction: '直接看方法段。',
              segments: [
                {
                  title: '任务拆解',
                  tag: 'method',
                  reason: '核心方法在这里。',
                  startTimestamp: 522,
                  endTimestamp: 790,
                },
              ],
            },
          ],
          mustWatch: [
            {
              title: '任务拆解',
              tag: 'must_watch',
              reason: '这里进入可复用方法。',
              startTimestamp: 522,
              endTimestamp: 790,
            },
          ],
          canWatch: [
            {
              title: '案例补充',
              tag: 'case',
              reason: '能帮助理解方法，但不是最高优先级。',
              startTimestamp: 800,
            },
          ],
          canSkim: [
            {
              title: '背景铺垫',
              tag: 'skim',
              reason: '信息密度低，可以轻放。',
              startTimestamp: 60,
            },
          ],
          canSkip: [
            {
              title: '片尾广告',
              tag: 'ad',
              reason: '广告内容，不影响理解。',
              startTimestamp: 1100,
              endTimestamp: 1160,
            },
          ],
          reservations: ['作者没有展示失败案例。'],
        },
        contentType: '方法教程',
        contentTypeReason: '讲的是可复用方法。',
        suggestedStance: '值得看，但只需要重点看方法段。',
      }),
      generatedAt: 9,
      modelUsed: 'model',
    });

    expect(guide).toMatchObject({
      contentType: '方法教程',
      suggestedStance: '值得看，但只需要重点看方法段。',
      generatedAt: 9,
      modelUsed: 'model',
    });
    expect(guide.decision).toMatchObject({
      rating: 'worth_watching',
      score: 88,
      valueProfile: {
        kind: 'learning_tutorial',
        label: '教程学习',
        criteria: [
          { label: '结构清晰', score: 91 },
          { label: '可迁移方法', score: 87 },
          { label: '步骤完整', score: 82 },
          { label: '时效可控', score: 84 },
          { label: '实践成本', score: 80 },
        ],
      },
      verdict: '值得看，但只需要重点看方法段。',
      bestFor: ['想学习工作流的人'],
      worthReasons: [
        '中段给出了可复用步骤。',
        '案例能帮助用户减少摸索时间。',
        '可以快速判断方法是否适合自己。',
      ],
      learningValue: ['可以参考任务拆解步骤。', '可以参考案例复盘方式。', '可以参考轻重取舍思路。'],
      reservations: ['作者没有展示失败案例。'],
    });
    expect(guide.decision.timePlans[0]?.segments[0]).toMatchObject({
      title: '任务拆解',
      tag: 'method',
      startTimestamp: 522,
      endTimestamp: 790,
    });
    expect(guide.decision.canWatch[0]?.title).toBe('案例补充');
    expect(guide.decision.canSkim[0]).toMatchObject({
      title: '背景铺垫',
      tag: 'skim',
    });
    expect(guide.decision.canSkip[0]?.tag).toBe('ad');
    expect(guide.decision.valueProfile.criteria[0]?.reason).toContain('目标、顺序和层次');
  });

  it('按视频类型把评分维度规整为对应清单，减少模型格式失败', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'selective',
          score: 62,
          valueProfile: {
            kind: 'interview_qa',
            label: '访谈 Q&A',
            criteria: [
              { label: '回答信息量', score: 52 },
              { label: '真实细节', score: 58 },
            ],
          },
          verdict: '按兴趣挑看。',
          overallMeaning: '这是一条访谈问答。',
          reason: '信息比较零散。',
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
      }),
      generatedAt: 15,
      modelUsed: 'model',
    });

    expect(guide.decision.valueProfile.criteria.map((criterion) => criterion.label)).toEqual([
      '人物/事件稀缺性',
      '回答信息量',
      '真实细节',
      '观点启发',
      '闲聊控制',
    ]);
    expect(guide.decision.valueProfile.criteria.map((criterion) => criterion.score)).toEqual([
      62, 52, 58, 62, 62,
    ]);
    expect(guide.decision.valueProfile.criteria[4]?.reason).toContain('闲聊、粉丝互动');
  });

  it('英文输出时按英文固定评分维度规整，并保留分数匹配', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'quick_browse',
          score: 48,
          valueProfile: {
            kind: 'learning_tutorial',
            label: 'Tutorial',
            criteria: [
              { label: 'Structure clarity', score: 41 },
              { label: 'Complete steps', score: 43 },
              { label: 'Practice cost', score: 45 },
            ],
          },
          verdict: 'Good for a quick first look.',
          overallMeaning: 'A short tutorial-style demo.',
          reason: 'The shown flow is light.',
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
      }),
      generatedAt: 15,
      modelUsed: 'model',
      outputLocale: 'en-US',
    });

    expect(guide.decision.valueProfile.criteria.map((criterion) => criterion.label)).toEqual([
      'Structure clarity',
      'Transferable methods',
      'Complete steps',
      'Time relevance',
      'Practice cost',
    ]);
    expect(guide.decision.valueProfile.criteria[0]?.score).toBe(41);
    expect(guide.decision.valueProfile.criteria[2]?.score).toBe(43);
    expect(guide.decision.valueProfile.criteria[4]?.score).toBe(45);
    expect(guide.decision.valueProfile.criteria[0]?.reason).toContain('clear goal');
  });

  it('旧统一五项 label 不会按位置套用到当前类型维度，避免掩盖 schema drift', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'selective',
          score: 62,
          valueProfile: {
            kind: 'interview_qa',
            label: '访谈 Q&A',
            criteria: [
              { label: '信息密度', score: 91 },
              { label: '独特价值', score: 87 },
              { label: '可操作性', score: 82 },
              { label: '证据可信度', score: 84 },
              { label: '时间成本', score: 80 },
            ],
          },
          verdict: '按兴趣挑看。',
          overallMeaning: '这是一条访谈问答。',
          reason: '信息比较零散。',
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
      }),
      generatedAt: 16,
      modelUsed: 'model',
    });

    expect(guide.decision.valueProfile.criteria.map((criterion) => criterion.label)).toEqual([
      '人物/事件稀缺性',
      '回答信息量',
      '真实细节',
      '观点启发',
      '闲聊控制',
    ]);
    expect(guide.decision.valueProfile.criteria.map((criterion) => criterion.score)).toEqual([
      62, 62, 62, 62, 62,
    ]);
  });

  it('criterion label 缺失时仍允许按位置兼容模型只给分数的输出', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'selective',
          score: 62,
          valueProfile: {
            kind: 'interview_qa',
            label: '访谈 Q&A',
            criteria: [{ score: 71 }, { label: '   ', score: 64 }],
          },
          verdict: '按兴趣挑看。',
          overallMeaning: '这是一条访谈问答。',
          reason: '信息比较零散。',
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
      }),
      generatedAt: 17,
      modelUsed: 'model',
    });

    expect(guide.decision.valueProfile.criteria.map((criterion) => criterion.score)).toEqual([
      71, 64, 62, 62, 62,
    ]);
  });

  it('允许低价值分组为空，但不再兼容旧 cards 结构', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'selective',
          score: 66,
          valueProfile: {
            kind: 'opinion_commentary',
            label: '观点闲聊',
            criteria: [
              { label: '观点启发', score: 66, reason: '中段有明确观点。' },
              { label: '表达效率', score: 58, reason: '前后闲聊较多。' },
              { label: '例子支撑', score: 62, reason: '有少量上下文。' },
            ],
          },
          verdict: '选择性看。',
          overallMeaning: '有少量启发。',
          reason: '只在中段出现明确观点。',
          bestFor: [],
          notFor: [],
          timePlans: [],
          mustWatch: [
            {
              title: '核心观点',
              tag: 'watch',
              reason: '唯一有信息密度的地方。',
            },
          ],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
        contentType: '观点闲聊',
        contentTypeReason: '主要是个人看法。',
        suggestedStance: '选择性看。',
      }),
      generatedAt: 10,
      modelUsed: 'model',
    });

    expect(guide.decision.canWatch).toEqual([]);
    expect(guide.decision.canSkim).toEqual([]);
    expect(guide).not.toHaveProperty('cards');
    expect(guide).not.toHaveProperty('watchStrategy');
  });

  it('缺少 valueProfile 的旧评分格式会解析失败，触发重新生成', () => {
    expect(() =>
      parseLearningGuideJson({
        content: JSON.stringify({
          decision: {
            rating: 'selective',
            score: 66,
            scoreBreakdown: {
              informationDensity: 70,
              uniqueValue: 62,
              actionability: 68,
              evidenceReliability: 60,
              timeEfficiency: 72,
            },
            verdict: '选择性看。',
            overallMeaning: '旧格式分析。',
            reason: '缺少新评分档案。',
            mustWatch: [],
            canWatch: [],
            canSkim: [],
            canSkip: [],
            reservations: [],
          },
        }),
        generatedAt: 10,
        modelUsed: 'model',
      }),
    ).toThrow();
  });

  it('容忍模型漏掉非核心字段，避免一次小格式偏差导致观看判断失败', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'selective',
          score: '62',
          valueProfile: tutorialValueProfile(),
          verdict: '选择性看，重点看中段方法。',
          overallMeaning: '视频主要讲一个工具的使用流程。',
          reason: '有明确方法，但演示偏长。',
          mustWatch: [
            {
              title: '中段方法',
              tag: '重点',
              reason: '这里有主要方法。',
              startTimestamp: '120',
              endTimestamp: '240',
            },
          ],
        },
      }),
      generatedAt: 13,
      modelUsed: 'model',
    });

    expect(guide.contentType).toBe('视频内容');
    expect(guide.contentTypeReason).toBe('模型没有补充内容类型理由。');
    expect(guide.suggestedStance).toBe('选择性看，重点看中段方法。');
    expect(guide.decision.score).toBe(62);
    expect(guide.decision.rating).toBe('selective');
    expect(guide.decision.bestFor).toEqual([]);
    expect(guide.decision.timePlans).toEqual([]);
    expect(guide.decision.mustWatch[0]).toMatchObject({
      title: '中段方法',
      tag: 'must_watch',
      startTimestamp: 120,
      endTimestamp: 240,
    });
  });

  it('支持快速浏览作为视频级判断，并限制列表长度', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'quick_browse',
          score: 42,
          valueProfile: {
            kind: 'news_context',
            label: '背景介绍',
            criteria: [
              { label: '背景完整', score: 45, reason: '能提供基本背景。' },
              { label: '更新价值', score: 40, reason: '缺少新的展开。' },
              { label: '表达效率', score: 42, reason: '大部分是铺垫。' },
            ],
          },
          verdict: '快速浏览即可。',
          overallMeaning: '有一点信息，但不值得投入太多时间。',
          reason: '大部分内容是铺垫。',
          worthReasons: ['有少量背景参考', '可以了解基本概念', '不用完整观看', '多余项'],
          bestFor: ['只想了解背景的人'],
          notFor: ['想学系统方法的人', '已经熟悉基础的人', '只想看实操的人', '多余项'],
          learningValue: ['知道基本概念', '了解常见坑', '判断是否继续查资料', '多余项'],
          timePlans: [],
          mustWatch: [
            {
              title: '基本概念',
              tag: 'watch',
              reason: '唯一有信息密度的地方。',
            },
          ],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: ['缺少实操验证', '观点证据不足', '适用范围不清楚', '多余项'],
        },
        contentType: '背景介绍',
        contentTypeReason: '主要是背景。',
        suggestedStance: '快速浏览即可。',
      }),
      generatedAt: 11,
      modelUsed: 'model',
    });

    expect(guide.decision.rating).toBe('quick_browse');
    expect(guide.decision.worthReasons).toHaveLength(3);
    expect(guide.decision.notFor).toHaveLength(3);
    expect(guide.decision.learningValue).toHaveLength(3);
    expect(guide.decision.reservations).toHaveLength(3);
  });

  it('以判断分派生视频级结论，避免模型输出分数和等级冲突', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'worth_watching',
          score: 42,
          valueProfile: {
            kind: 'news_context',
            label: '背景介绍',
            criteria: [
              { label: '背景完整', score: 42, reason: '只有少量信息。' },
              { label: '观看回报', score: 38, reason: '不值得长时间观看。' },
              { label: '表达效率', score: 44, reason: '只有一个片段有用。' },
            ],
          },
          verdict: '模型给了冲突结论。',
          overallMeaning: '只有少量信息。',
          reason: '分数更接近快速浏览。',
          bestFor: [],
          notFor: [],
          timePlans: [],
          mustWatch: [
            {
              title: '唯一片段',
              tag: 'watch',
              reason: '只有这里有一点信息。',
            },
          ],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
        contentType: '背景介绍',
        contentTypeReason: '主要是背景。',
        suggestedStance: '快速浏览即可。',
      }),
      generatedAt: 12,
      modelUsed: 'model',
    });

    expect(guide.decision.score).toBe(42);
    expect(guide.decision.rating).toBe('quick_browse');
  });

  it('55 分按快速浏览派生，避免落入选择性看', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        decision: {
          rating: 'selective',
          score: 55,
          valueProfile: {
            kind: 'opinion_commentary',
            label: '观点争议',
            criteria: [
              { label: '论点清晰', score: 58, reason: '能看出作者立场。' },
              { label: '例子支撑', score: 50, reason: '支撑材料不够多。' },
              { label: '表达效率', score: 55, reason: '适合快速了解。' },
            ],
          },
          verdict: '观点争议相关片段可以快速了解。',
          overallMeaning: '视频主要表达对角色设计争议的看法。',
          reason: '内容偏观点输出，信息密度不高。',
          bestFor: [],
          notFor: [],
          timePlans: [],
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
        contentType: '观点争议',
        contentTypeReason: '偏观点表达。',
        suggestedStance: '快速浏览即可。',
      }),
      generatedAt: 13,
      modelUsed: 'model',
    });

    expect(guide.decision.score).toBe(55);
    expect(guide.decision.rating).toBe('quick_browse');
  });

  it('容忍模型把学习判断包在 guide 字段里', () => {
    const guide = parseLearningGuideJson({
      content: JSON.stringify({
        guide: {
          decision: {
            rating: 'selective',
            score: 62,
            valueProfile: {
              kind: 'opinion_commentary',
              label: '设计评论',
              criteria: [
                { label: '视角新鲜', score: 65, reason: '提供从业者角度。' },
                { label: '论点清晰', score: 62, reason: '能说明核心看法。' },
                { label: '表达效率', score: 58, reason: '后半段可以略过。' },
              ],
            },
            verdict: '选择性看。',
            overallMeaning: '主要是观点拆解。',
            reason: '前半段有参考价值，后半段可以略过。',
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
          contentType: '设计评论',
          contentTypeReason: '围绕游戏美术设计展开。',
          suggestedStance: '选择性看。',
        },
      }),
      generatedAt: 14,
      modelUsed: 'model',
    });

    expect(guide.contentType).toBe('设计评论');
    expect(guide.decision.score).toBe(62);
    expect(guide.decision.bestFor).toEqual(['想了解美术设计视角的人']);
  });
});
