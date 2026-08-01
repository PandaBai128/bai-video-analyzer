import { describe, expect, it } from 'vitest';
import { normalizeLearningReview } from '@core/learning/normalize-learning-review';
import type { LearningReview, SubtitleCue, VideoAnalysis } from '@core/types';

const baseReview: LearningReview = {
  coreSummary: '核心',
  keyIdeas: [
    {
      title: '本地 agent 是重点',
      explanation: '作者强调 Mac 变成默认 agent 工作台。',
      evidenceTimestamp: 999,
    },
  ],
  personalInsights: ['用户更关注能不能用到自己的项目里。'],
  transferReflection: '用户可以把这套方法迁移到自己的项目筛选里。',
  openQuestions: [],
  actionItems: [],
  finalReflection: '总结',
  generatedAt: 1,
  modelUsed: 'model',
};

describe('normalizeLearningReview', () => {
  it('把关键观点时间点对齐到真实字幕证据，并把学习痕迹改成第一人称', () => {
    const transcriptCues: SubtitleCue[] = [
      { start: 10, end: 15, text: '开场寒暄。' },
      { start: 180, end: 190, text: '本地 agent 才是这期真正重点。' },
      { start: 191, end: 200, text: '苹果想把 Mac 变成默认 agent 工作台。' },
    ];

    const normalized = normalizeLearningReview({
      review: baseReview,
      transcriptCues,
      analysis: null,
    });

    expect(normalized.keyIdeas[0]?.evidenceTimestamp).toBe(180);
    expect(normalized.personalInsights[0]).toBe('我更关注能不能用到自己的项目里。');
    expect(normalized.transferReflection).toBe('我可以把这套方法迁移到自己的项目筛选里。');
  });

  it('无法从字幕或章节确认时移除模型编造的时间点', () => {
    const normalized = normalizeLearningReview({
      review: baseReview,
      transcriptCues: [{ start: 20, text: '完全无关的内容。' }],
      analysis: null,
    });

    expect(normalized.keyIdeas[0]?.evidenceTimestamp).toBeUndefined();
  });

  it('没有字幕时可用章节摘要对齐时间点', () => {
    const analysis: VideoAnalysis = {
      overview: '概览',
      watchStrategy: [],
      coreTakeaways: [],
      reviewSummary: '总结',
      chapters: [
        {
          timestamp: 240,
          title: '本地 agent',
          summary: 'Mac 变成默认 agent 工作台。',
          importance: 'must-watch',
          watchGuide: '认真看本地 agent 的判断。',
          segments: [],
        },
      ],
      timeline: [],
      quotes: [],
      keyConcepts: [],
      inspirations: [],
      generatedAt: 1,
      modelUsed: 'model',
      sourceMode: 'subtitle',
    };

    const normalized = normalizeLearningReview({
      review: baseReview,
      transcriptCues: [],
      analysis,
    });

    expect(normalized.keyIdeas[0]?.evidenceTimestamp).toBe(240);
  });
});
