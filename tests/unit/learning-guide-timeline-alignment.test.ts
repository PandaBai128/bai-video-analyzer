import { describe, expect, it } from 'vitest';
import { alignLearningGuideWithTimeline } from '@core/learning/align-learning-guide-timeline';
import type { LearningGuide, VideoAnalysis } from '@core/types';

describe('alignLearningGuideWithTimeline', () => {
  it('把观看判断里的同主题片段对齐到时间线小节，避免判断页另起时间点', () => {
    const guide: LearningGuide = {
      decision: {
        rating: 'selective',
        score: 62,
        valueProfile: {
          kind: 'learning_tutorial',
          label: '教程学习',
          criteria: [
            { label: '结构清晰', score: 62, reason: '计划模式段落较集中。' },
            { label: '可迁移性', score: 65, reason: '工作流可参考。' },
            { label: '实践成本', score: 58, reason: '需要跟项目实际验证。' },
          ],
        },
        verdict: '选择性看计划模式相关段落。',
        overallMeaning: '视频讲 Codex 桌面端。',
        reason: '计划模式值得看。',
        bestFor: [],
        notFor: [],
        timePlans: [
          {
            budget: '10min',
            label: '只有 10 分钟',
            instruction: '看计划模式。',
            segments: [
              {
                title: '计划模式（Plan Mode）实战',
                tag: 'method',
                reason: '核心工作流。',
                startTimestamp: 23 * 60 + 18,
                endTimestamp: 25 * 60,
              },
            ],
          },
        ],
        mustWatch: [
          {
            title: '计划模式（Plan Mode）实战',
            tag: 'method',
            reason: '核心工作流。',
            startTimestamp: 23 * 60 + 18,
            endTimestamp: 25 * 60,
          },
        ],
        canWatch: [],
        canSkim: [],
        canSkip: [],
        reservations: [],
      },
      contentType: '教程讲解',
      contentTypeReason: '教程。',
      suggestedStance: '选择性看。',
      generatedAt: 1,
      modelUsed: 'model',
    };
    const analysis: VideoAnalysis = {
      overview: 'Codex 教程。',
      watchStrategy: [],
      coreTakeaways: [],
      reviewSummary: '',
      chapters: [
        {
          timestamp: 20 * 60 + 14,
          endTimestamp: 26 * 60 + 38,
          title: '能力四：生图与个人主页开发',
          summary: '用 Codex 计划模式开发个人主页网站。',
          importance: 'must-watch',
          watchGuide: '看计划模式即可。',
          segments: [
            {
              timestamp: 20 * 60 + 14,
              endTimestamp: 23 * 60 + 26,
              title: '计划模式与需求确认',
              summary: '演示用计划模式让 Codex 输出建站计划并补充 image2 配图要求。',
              importance: 'must-watch',
            },
          ],
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

    const aligned = alignLearningGuideWithTimeline(guide, analysis);

    expect(aligned.decision.mustWatch[0]).toMatchObject({
      title: '计划模式与需求确认',
      startTimestamp: 20 * 60 + 14,
      endTimestamp: 23 * 60 + 26,
    });
    expect(aligned.decision.timePlans[0]?.segments[0]).toMatchObject({
      title: '计划模式与需求确认',
      startTimestamp: 20 * 60 + 14,
      endTimestamp: 23 * 60 + 26,
    });
  });
});
