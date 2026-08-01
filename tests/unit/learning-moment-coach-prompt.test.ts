import { describe, expect, it } from 'vitest';
import { buildLearningMomentCoachPrompt } from '@core/prompts/learning-moment-coach';
import type { LearningMoment, LearningSession, VideoMetadata } from '@core/types';

const metadata: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1fun',
  url: 'https://www.bilibili.com/video/BV1fun',
  title: '整活视频',
  author: 'UP 主',
};

const session: LearningSession = {
  id: 'bilibili:BV1fun',
  schemaVersion: 2,
  platform: 'bilibili',
  videoId: 'BV1fun',
  goal: { mode: 'adaptive', focus: '', label: '收集喜欢的梗' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  guide: {
    contentType: '娱乐整活',
    contentTypeReason: '视频以梗为主。',
    suggestedStance: '轻松看。',
    decision: {
      rating: 'selective',
      score: 62,
      valueProfile: {
        kind: 'entertainment_reaction',
        label: '娱乐整活',
        criteria: [
          { label: '情绪价值', score: 68, reason: '粉色特效有笑点。' },
          { label: '节目效果', score: 62, reason: '视觉反差明确。' },
          { label: '放松观看', score: 58, reason: '适合轻松看，不适合系统学习。' },
        ],
      },
      verdict: '可以轻松看，喜欢的片段再记录。',
      overallMeaning: '主要是娱乐和视觉反差，学习价值较轻。',
      reason: '有审美和节奏参考，但没有完整方法论。',
      bestFor: ['想放松或收集灵感的人'],
      notFor: ['想学系统方法的人'],
      timePlans: [],
      mustWatch: [
        {
          title: '粉色特效',
          tag: 'case',
          reason: '这里体现了视觉反差。',
          startTimestamp: 10,
        },
      ],
      canWatch: [],
      canSkim: [],
      canSkip: [],
      reservations: ['不要把娱乐效果当成通用方法。'],
    },
    generatedAt: 1,
    modelUsed: 'model',
  },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

const moment: LearningMoment = {
  id: 'm1',
  kind: 'insight',
  content: '这个粉色特效很好笑',
  timestamp: 12,
  createdAt: 2,
};

describe('buildLearningMomentCoachPrompt', () => {
  it('允许补充说明把娱乐记录处理为保留或放下，而不是强行追问', () => {
    const prompt = buildLearningMomentCoachPrompt({
      metadata,
      transcriptCues: [{ start: 10, text: '粉色特效来了。' }],
      analysis: null,
      session,
      moment,
    });
    expect(prompt).toContain('keep / ask / verify / apply / release');
    expect(prompt).toContain('bAI 视频分析助手');
    expect(prompt).toContain('内容概括：主要是娱乐和视觉反差，学习价值较轻。');
    expect(prompt).toContain('信息边界：不要把娱乐效果当成通用方法。');
    expect(prompt).toContain('不必过度分析');
    expect(prompt).toContain('娱乐/整活/审美类记录');
    expect(prompt).toContain('这个粉色特效很好笑');
  });
});
