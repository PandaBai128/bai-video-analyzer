import { describe, expect, it } from 'vitest';
import { buildVideoContextPackage } from '@core/followup/video-context-package';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import { buildFollowupChatPrompt } from '@core/prompts/video-followup-chat';
import type { SubtitleCue, VideoAnalysis, VideoMetadata } from '@core/types';

const METADATA: VideoMetadata = {
  platform: 'youtube',
  videoId: 'yt-1',
  url: 'https://www.youtube.com/watch?v=yt-1',
  title: 'AI 视频',
  author: '作者',
  duration: 300,
};

const CUES: readonly SubtitleCue[] = [
  { start: 0, end: 8, text: '今天讨论 AI 产品策略。' },
  { start: 120, end: 130, text: '这里提到苹果对端侧 AI 的判断。' },
];

const ANALYSIS: VideoAnalysis = {
  overview: '视频核心',
  watchStrategy: [],
  coreTakeaways: ['端侧 AI 是重点'],
  reviewSummary: '整体总结',
  chapters: [],
  timeline: [],
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

describe('buildFollowupChatPrompt (联网回答依据)', () => {
  it('video_plus_web 渲染联网规则和搜索结果块', () => {
    const pkg = buildVideoContextPackage({
      metadata: METADATA,
      analysis: ANALYSIS,
      transcriptCues: CUES,
      annotations: [],
    });
    const selectedContext = selectFollowupContext({
      question: '苹果 AI 最新背景是什么？',
      contextPackage: pkg,
    });

    const prompt = buildFollowupChatPrompt({
      question: '苹果 AI 最新背景是什么？',
      contextPackage: pkg,
      selectedContext,
      answerBasis: 'video_plus_web',
      webSearchContext: {
        query: 'Apple Intelligence 最新消息',
        queries: ['Apple Intelligence 最新消息', '苹果 AI 官方公告'],
        plan: {
          intent: 'fresh_fact',
          topicHint: 'AI 视频',
          queries: ['Apple Intelligence 最新消息', '苹果 AI 官方公告'],
          requiredEvidence: '需要近期来源或明确发布时间，过期来源只能作为背景。',
        },
        results: [
          {
            title: 'Apple Intelligence 最新消息',
            url: 'https://example.com/apple-intelligence',
            snippet: '苹果发布端侧 AI 功能。',
            sourceQuery: 'Apple Intelligence 最新消息',
            sourceType: 'media',
            relevanceScore: 70,
          },
        ],
      },
    });

    expect(prompt.system).toContain('MiniMax 联网搜索结果');
    expect(prompt.system).toMatch(/不要.*把联网搜索结果写成"视频里说"/);
    expect(prompt.system).toMatch(/外部事实|实时信息/);
    expect(prompt.system).toMatch(/不要.*机械地先说"视频里没讲|不要.*机械地先说"这个问题和当前视频没有直接关系"/);
    expect(prompt.system).toMatch(/什么时候|日期|目前|最新|最高|排名|人气|第一/);
    expect(prompt.system).toMatch(/直接支持日期、榜单、投票或排名/);
    expect(prompt.system).toMatch(/联网模式不是通识模式/);
    expect(prompt.system).toMatch(/不得.*模型训练知识、游戏内通识/);
    expect(prompt.system).toMatch(/不要写"来源：游戏内通识背景"/);
    expect(prompt.system).toMatch(/不要用通识兜底/);
    expect(prompt.system).toMatch(/不要只看第一条结果/);
    expect(prompt.user).toContain('<web_search_results>');
    expect(prompt.user).toContain('<web_search_plan>');
    expect(prompt.user).toContain('意图：fresh_fact');
    expect(prompt.user).toContain('查询词：');
    expect(prompt.user).toContain('- Apple Intelligence 最新消息');
    expect(prompt.user).toContain('来源类型：媒体 / 攻略站');
    expect(prompt.user).toContain('命中查询：Apple Intelligence 最新消息');
    expect(prompt.user).toContain('[来源 1] Apple Intelligence 最新消息');
    expect(prompt.user).toContain('https://example.com/apple-intelligence');
    expect(prompt.user).toContain('</web_search_results>');
  });
});
