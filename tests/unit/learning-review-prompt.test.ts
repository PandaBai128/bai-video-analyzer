import { describe, expect, it } from 'vitest';
import { buildLearningReviewPrompt } from '@core/prompts/learning-review';
import type { LearningSession, VideoMetadata } from '@core/types';

const metadata: VideoMetadata = {
  platform: 'youtube',
  videoId: 'video-1',
  url: 'https://www.youtube.com/watch?v=video-1',
  title: '问题拆解',
  author: '作者',
  duration: 120,
};

const baseSession: LearningSession = {
  id: 'youtube:video-1',
  schemaVersion: 2,
  platform: 'youtube',
  videoId: 'video-1',
  goal: { mode: 'challenge', focus: '检查论证边界' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('buildLearningReviewPrompt', () => {
  it('生成五块式学习笔记：主动提炼收获但不编造用户经历', () => {
    const prompt = buildLearningReviewPrompt({
      metadata,
      transcriptCues: [{ start: 0, text: '先写出问题边界。' }],
      analysis: null,
      session: baseSession,
    });
    expect(prompt).toContain('用户没有生成导航');
    expect(prompt).toContain('五块式学习笔记');
    expect(prompt).toContain('视频讲了什么');
    expect(prompt).toContain('我得到了什么');
    expect(prompt).toContain('哪些观点值得参考');
    expect(prompt).toContain('哪些我需要保留判断');
    expect(prompt).toContain('我的记录');
    expect(prompt).toContain('基于视频证据主动提炼');
    expect(prompt).toContain('每条用完整句子表达');
    expect(prompt).toContain('transferReflection');
    expect(prompt).toContain('我可以根据这个做什么');
    expect(prompt).toContain('下一步怎么做');
    expect(prompt).toContain('1 个自然段');
    expect(prompt).toContain('不能重复 personalInsights');
    expect(prompt).toContain('只写基于视频证据的谨慎理解');
    expect(prompt).toContain('不要编造用户已经做过、想过或经历过的事情');
    expect(prompt).toContain('我需要保留判断的地方');
    expect(prompt).toContain('检查论证边界');
  });

  it('只把用户手动加入笔记的问答作为学习轨迹输入', () => {
    const prompt = buildLearningReviewPrompt({
      metadata,
      transcriptCues: [{ start: 0, text: '先写出问题边界。' }],
      analysis: null,
      session: {
        ...baseSession,
        moments: [
          {
            id: 'm1',
            kind: 'insight',
            content: '我总是过早选择方案',
            timestamp: 12,
            coach: {
              response: '这条记录适合继续追问边界判断。',
              handling: 'ask',
              suggestedQuestions: ['边界如何验证？'],
              linkedTimestamps: [],
              generatedAt: 4,
              modelUsed: 'model',
            },
            createdAt: 2,
          },
        ],
        exchanges: [
          {
            id: 'e1',
            question: '什么算清晰边界？',
            answer: '能够被明确验证。',
            includedInReview: true,
            createdAt: 3,
          },
          {
            id: 'e2',
            question: '这条只是临时确认吗？',
            answer: '不要默认进入笔记。',
            createdAt: 4,
          },
        ],
      },
    });
    expect(prompt).toContain('[0:12] 发现：我总是过早选择方案');
    expect(prompt).toContain('补充说明处理：ask');
    expect(prompt).toContain('用户：什么算清晰边界？');
    expect(prompt).toContain('bAI：能够被明确验证。');
    expect(prompt).not.toContain('陪练：');
    expect(prompt).not.toContain('这条只是临时确认吗？');
  });
});
