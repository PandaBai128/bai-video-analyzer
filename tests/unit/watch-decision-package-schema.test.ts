import { describe, expect, it } from 'vitest';
import { parseWatchDecisionPackageJson } from '@core/learning/watch-decision-package-schema';
import type { SubtitleCue, VideoMetadata } from '@core/types';

const metadata: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: 'Codex 教程',
  author: '作者',
  duration: 40,
};

const cues: readonly SubtitleCue[] = [
  { start: 0, end: 8, text: '开场介绍 Codex 和 Claude Code 的区别' },
  { start: 8, end: 16, text: '安装和界面速览' },
  { start: 16, end: 26, text: '讲解 MCP 外挂知识库的配置和读取过程' },
  { start: 26, end: 38, text: '总结自动化任务' },
];

function tutorialValueProfile() {
  return {
    kind: 'learning_tutorial',
    label: '教程学习',
    criteria: [
      { label: '结构清晰', score: 70 },
      { label: '可迁移方法', score: 68 },
      { label: '步骤完整', score: 72 },
      { label: '时效可控', score: 66 },
      { label: '实践成本', score: 64 },
    ],
  };
}

describe('parseWatchDecisionPackageJson', () => {
  it('英文输出缺字段时 fallback 不混入中文默认文案', () => {
    const parsed = parseWatchDecisionPackageJson({
      content: JSON.stringify({
        timeline: [
          {
            startCueId: 0,
            endCueId: 0,
            importance: 'recommended',
          },
        ],
        decision: {
          score: 45,
          valueProfile: {
            kind: 'learning_tutorial',
            criteria: [],
          },
          mustWatch: [{ title: 'Opening segment', tag: 'watch' }],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
      }),
      metadata,
      transcriptCues: cues,
      generatedAt: 100,
      modelUsed: 'MiniMax-M3',
      contextDigest: 'ctx-en-fallback',
      outputLocale: 'en-US',
    });

    expect(parsed.analysis.overview).toBe(
      'Generated a watch decision and timeline for this video.',
    );
    expect(parsed.analysis.reviewSummary).toBe(
      'A watch decision is ready. Use questions and notes to build your summary.',
    );
    expect(parsed.analysis.chapters[0]).toMatchObject({
      title: 'Video Timeline',
      summary: 'The model returned a flat timeline, so it has been grouped into one chapter.',
      watchGuide: 'Choose what to watch from the segments below.',
    });
    expect(parsed.analysis.timeline[0]).toMatchObject({
      title: 'Untitled Segment',
      summary: 'The model did not provide a summary for this segment.',
    });
    expect(parsed.guide.contentType).toBe('Video content');
    expect(parsed.guide.contentTypeReason).toBe(
      'The model did not provide a content-type reason.',
    );
    expect(parsed.guide.decision.reason).toBe('The model did not provide a clear reason.');
    expect(parsed.guide.decision.verdict).toBe(
      'Quick browse: The model did not provide a clear reason.',
    );
    expect(
      JSON.stringify({
        analysis: parsed.analysis,
        guide: parsed.guide,
      }),
    ).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('用同一包里的 nodeId 连接判断和时间线，无效引用不生成可点击伪时间点', () => {
    const parsed = parseWatchDecisionPackageJson({
      content: JSON.stringify({
        overview: '视频介绍 Codex 桌面端的核心能力。',
        coreTakeaways: ['可以根据目标选择性观看。'],
        reviewSummary: '重点看 MCP 外挂知识库即可。',
        chapters: [
          {
            id: 'c1',
            startCueId: 0,
            endCueId: 3,
            importance: 'recommended',
            contentTag: 'tool',
            title: 'Codex 功能地图',
            summary: '从对比、安装到 MCP 能力做概览。',
            watchGuide: '按需要挑片段看。',
            segments: [
              {
                id: 's-compare',
                startCueId: 0,
                endCueId: 0,
                importance: 'recommended',
                contentTag: 'comparison',
                title: '工具对比',
                summary: '对比 Codex 和 Claude Code。',
              },
              {
                id: 's-mcp',
                startCueId: 2,
                endCueId: 2,
                importance: 'must-watch',
                contentTag: 'tool',
                title: 'MCP 外挂知识库',
                summary: '演示 MCP 外挂知识库配置和读取。',
              },
              {
                id: 's-invalid-tail',
                startCueId: 2,
                endCueId: 99,
                importance: 'recommended',
                contentTag: 'summary',
                title: '越界片段',
                summary: '这个片段不应该被 clamp 到视频尾部。',
              },
            ],
          },
        ],
        decision: {
          rating: 'selective',
          score: 64,
          valueProfile: tutorialValueProfile(),
          verdict: '只看 MCP 外挂知识库这一段即可。',
          overallMeaning: '这是 Codex 功能概览，不必完整看完。',
          reason: '重点能力集中在 MCP 片段。',
          worthReasons: ['MCP 片段有明确操作价值'],
          bestFor: ['想了解 Codex 能力边界的人'],
          notFor: [],
          learningValue: ['知道如何把外部知识库接进工作流'],
          mustWatch: [
            {
              nodeId: 's-mcp',
              title: 'MCP 外挂知识库',
              tag: 'must_watch',
              reason: '直接对应高价值能力。',
            },
          ],
          canWatch: [
            {
              nodeId: 's-invalid-tail',
              title: '越界片段',
              tag: 'watch',
              reason: '越界 cue 不能生成可点击时间点。',
            },
          ],
          canSkim: [
            {
              nodeId: 'missing-node',
              title: '不存在的片段',
              tag: 'skim',
              reason: '这个引用不能变成可点击时间点。',
              startTimestamp: 999,
            },
          ],
          canSkip: [],
          timePlans: [
            {
              budget: '10min',
              label: '只有 10 分钟',
              instruction: '直接看 MCP。',
              segments: [
                {
                  nodeId: 's-mcp',
                  title: 'MCP 外挂知识库',
                  tag: 'must_watch',
                  reason: '高价值片段。',
                },
              ],
            },
          ],
          reservations: ['其余片段的参考价值取决于是否已经熟悉 Codex。'],
        },
        contentType: '课程讲解',
        contentTypeReason: '按功能模块讲解工具。',
        suggestedStance: '选择性看。',
      }),
      metadata,
      transcriptCues: cues,
      generatedAt: 100,
      modelUsed: 'MiniMax-M3',
      contextDigest: 'ctx-1',
    });

    expect(parsed.analysis.timeline).toHaveLength(2);
    expect(parsed.analysis.timeline[1]).toMatchObject({
      id: 's-mcp',
      timestamp: 16,
      endTimestamp: 26,
      sourceCueRange: { startCueId: 2, endCueId: 2 },
    });
    expect(parsed.analysis.timeline.some((node) => node.id === 's-invalid-tail')).toBe(false);
    expect(parsed.guide.decision.mustWatch[0]).toMatchObject({
      nodeId: 's-mcp',
      startTimestamp: 16,
      endTimestamp: 26,
    });
    expect(parsed.guide.decision.valueProfile.criteria[0]).toMatchObject({
      label: '结构清晰',
      score: 70,
    });
    expect(parsed.guide.decision.valueProfile.criteria).toHaveLength(5);
    expect(parsed.guide.decision.valueProfile.criteria[0]?.reason).toContain('目标、顺序和层次');
    expect(parsed.guide.decision.learningValue).toEqual([]);
    expect(parsed.guide.decision.timePlans).toEqual([]);
    expect(parsed.guide.decision.canWatch[0]).toMatchObject({
      title: '越界片段',
    });
    expect(parsed.guide.decision.canWatch[0]).not.toHaveProperty('nodeId');
    expect(parsed.guide.decision.canWatch[0]).not.toHaveProperty('startTimestamp');
    expect(parsed.guide.decision.canSkim[0]).toMatchObject({
      title: '不存在的片段',
    });
    expect(parsed.guide.decision.canSkim[0]).not.toHaveProperty('nodeId');
    expect(parsed.guide.decision.canSkim[0]).not.toHaveProperty('startTimestamp');
    expect(parsed.guide.contextDigest).toBe('ctx-1');
    expect(parsed.guide.timelineDigest).toBe(parsed.analysis.timelineDigest);
  });

  it('旧统一五项 label 不会按位置套用到观看决策包的当前类型维度', () => {
    const parsed = parseWatchDecisionPackageJson({
      content: JSON.stringify({
        overview: '这是一条粉丝 Q&A。',
        coreTakeaways: [],
        reviewSummary: '按问题挑重点看即可。',
        chapters: [],
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
          worthReasons: [],
          bestFor: [],
          notFor: [],
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
        contentType: '访谈 Q&A',
        contentTypeReason: '主要是问答。',
        suggestedStance: '按兴趣挑看。',
      }),
      metadata,
      transcriptCues: cues,
      generatedAt: 105,
      modelUsed: 'MiniMax-M3',
      contextDigest: 'ctx-drift',
    });

    expect(parsed.guide.decision.valueProfile.criteria.map((criterion) => criterion.label)).toEqual(
      ['人物/事件稀缺性', '回答信息量', '真实细节', '观点启发', '闲聊控制'],
    );
    expect(parsed.guide.decision.valueProfile.criteria.map((criterion) => criterion.score)).toEqual(
      [62, 62, 62, 62, 62],
    );
  });

  it('兼容模型用 timestamp 锚定时间线，并仍通过 nodeId 保持判断同源', () => {
    const parsed = parseWatchDecisionPackageJson({
      content: JSON.stringify({
        overview: '视频介绍 Codex 桌面端能力。',
        coreTakeaways: [],
        reviewSummary: '重点看 MCP 配置。',
        chapters: [
          {
            id: 'c-time',
            startTimestamp: '0:08',
            endTimestamp: '0:38',
            importance: 'recommended',
            contentTag: 'tool',
            title: '能力演示',
            summary: '按时间锚点输出的能力演示。',
            watchGuide: '按需跳转。',
            segments: [
              {
                id: 's-install',
                timestamp: '0:08',
                endTimestamp: '0:16',
                importance: 'optional',
                contentTag: 'setup',
                title: '安装速览',
                summary: '快速看安装界面。',
              },
              {
                id: 's-mcp',
                startTime: '0:16',
                endTime: '0:26',
                importance: 'must-watch',
                contentTag: 'tool',
                title: 'MCP 配置',
                summary: '配置外部知识库。',
              },
            ],
          },
        ],
        decision: {
          rating: 'selective',
          score: 66,
          valueProfile: tutorialValueProfile(),
          verdict: '重点看 MCP 配置。',
          overallMeaning: '这是 Codex 能力演示。',
          reason: 'MCP 配置片段最有价值。',
          worthReasons: ['MCP 配置可复用'],
          bestFor: [],
          notFor: [],
          mustWatch: [
            {
              nodeId: 's-mcp',
              title: 'MCP 配置',
              tag: 'must_watch',
              reason: '最有操作价值。',
            },
          ],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
        contentType: '课程讲解',
        contentTypeReason: '能力演示。',
        suggestedStance: '选择性看。',
      }),
      metadata,
      transcriptCues: cues,
      generatedAt: 103,
      modelUsed: 'MiniMax-M3',
      contextDigest: 'ctx-4',
    });

    expect(parsed.analysis.chapters[0]).toMatchObject({
      id: 'c-time',
      timestamp: 8,
      endTimestamp: 38,
      sourceCueRange: { startCueId: 1, endCueId: 3 },
    });
    expect(parsed.analysis.timeline[1]).toMatchObject({
      id: 's-mcp',
      timestamp: 16,
      endTimestamp: 26,
      sourceCueRange: { startCueId: 2, endCueId: 2 },
    });
    expect(parsed.guide.decision.mustWatch[0]).toMatchObject({
      nodeId: 's-mcp',
      startTimestamp: 16,
      endTimestamp: 26,
    });
    expect(parsed.guide.timelineDigest).toBe(parsed.analysis.timelineDigest);
  });

  it('nodeId 命中同源时间线时，判断片段文案优先跟随被引用节点，避免时间和理由错位', () => {
    const parsed = parseWatchDecisionPackageJson({
      content: JSON.stringify({
        overview: '视频演示 Cursor Composer 的基本用法。',
        coreTakeaways: [],
        reviewSummary: '重点看 Composer 操作即可。',
        chapters: [
          {
            id: 'c-cursor',
            startCueId: 0,
            endCueId: 3,
            importance: 'recommended',
            contentTag: 'tool',
            title: 'Cursor 实操流程',
            summary: '按步骤演示 Cursor。',
            watchGuide: '按需跟做。',
            segments: [
              {
                id: 's-composer',
                startCueId: 1,
                endCueId: 1,
                importance: 'must-watch',
                contentTag: 'demo',
                title: '开启 Composer',
                summary: '演示如何打开 Composer 并准备输入需求。',
              },
            ],
          },
        ],
        decision: {
          rating: 'selective',
          score: 68,
          valueProfile: tutorialValueProfile(),
          verdict: '选择性看 Composer 操作。',
          overallMeaning: '视频主要演示 Cursor 入门。',
          reason: '适合看一次工具操作。',
          worthReasons: [],
          bestFor: [],
          notFor: [],
          mustWatch: [
            {
              nodeId: 's-composer',
              title: '免费部署完整流程',
              tag: 'method',
              reason: '没有自己的服务器也能让网站对外可访问。',
            },
          ],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          reservations: [],
        },
        contentType: '工具实操教程',
        contentTypeReason: '以操作演示为主。',
        suggestedStance: '选择性看。',
      }),
      metadata,
      transcriptCues: cues,
      generatedAt: 104,
      modelUsed: 'MiniMax-M3',
      contextDigest: 'ctx-5',
    });

    expect(parsed.guide.decision.mustWatch[0]).toMatchObject({
      nodeId: 's-composer',
      title: '开启 Composer',
      reason: '演示如何打开 Composer 并准备输入需求。',
      startTimestamp: 8,
      endTimestamp: 16,
    });
  });

  it('55 分按快速浏览派生，避免模型 rating 和 score 冲突', () => {
    const parsed = parseWatchDecisionPackageJson({
      content: JSON.stringify({
        overview: '视频围绕游戏角色设计争议表达观点。',
        coreTakeaways: [],
        reviewSummary: '只适合快速了解争议观点。',
        chapters: [
          {
            id: 'c1',
            startCueId: 0,
            endCueId: 3,
            importance: 'recommended',
            contentTag: 'experience',
            title: '角色争议观点',
            summary: '围绕角色设计争议表达看法。',
            watchGuide: '快速了解即可。',
            segments: [],
          },
        ],
        decision: {
          rating: 'selective',
          score: 55,
          valueProfile: tutorialValueProfile(),
          verdict: '对角色设计争议感兴趣可以快速了解。',
          overallMeaning: '视频主要表达角色设计争议观点。',
          reason: '内容偏观点输出，信息密度不高。',
          worthReasons: [],
          bestFor: [],
          notFor: [],
          learningValue: [],
          mustWatch: [],
          canWatch: [],
          canSkim: [],
          canSkip: [],
          timePlans: [],
          reservations: [],
        },
        contentType: '观点争议',
        contentTypeReason: '偏观点输出。',
        suggestedStance: '快速浏览即可。',
      }),
      metadata,
      transcriptCues: cues,
      generatedAt: 101,
      modelUsed: 'MiniMax-M3',
      contextDigest: 'ctx-2',
    });

    expect(parsed.guide.decision.score).toBe(55);
    expect(parsed.guide.decision.rating).toBe('quick_browse');
  });

  it('兼容模型把同源包包成 analysis + guide 的结构', () => {
    const parsed = parseWatchDecisionPackageJson({
      content: JSON.stringify({
        analysis: {
          overview: '视频介绍 Codex 桌面端的核心能力。',
          coreTakeaways: ['用同一套工具完成项目开发。'],
          reviewSummary: '重点是项目开发和 Skills。',
          chapters: [
            {
              id: 'c-project',
              startCueId: 1,
              endCueId: 3,
              importance: 'recommended',
              contentTag: 'demo',
              title: '项目开发演示',
              summary: '演示如何用 Codex 开发项目。',
              watchGuide: '按需看演示。',
              segments: [
                {
                  id: 's-project',
                  startCueId: 1,
                  endCueId: 2,
                  importance: 'must-watch',
                  contentTag: 'demo',
                  title: '项目开发流程',
                  summary: '展示项目开发流程。',
                },
              ],
            },
          ],
        },
        guide: {
          decision: {
            rating: 'selective',
            score: 66,
            valueProfile: tutorialValueProfile(),
            verdict: '重点看项目开发流程即可。',
            overallMeaning: '这是 Codex 功能演示型教程。',
            reason: '项目开发片段最有参考价值。',
            worthReasons: ['能看到实际开发流程'],
            bestFor: ['想看 Codex 实操的人'],
            notFor: [],
            learningValue: ['理解项目开发流程'],
            mustWatch: [
              {
                nodeId: 's-project',
                title: '项目开发流程',
                tag: 'must_watch',
                reason: '最有实操价值。',
              },
            ],
            canWatch: [],
            canSkim: [],
            canSkip: [],
            timePlans: [],
            reservations: [],
          },
          contentType: '课程讲解',
          contentTypeReason: '以功能演示为主。',
          suggestedStance: '选择性看。',
        },
      }),
      metadata,
      transcriptCues: cues,
      generatedAt: 102,
      modelUsed: 'MiniMax-M3',
      contextDigest: 'ctx-3',
    });

    expect(parsed.analysis.overview).toBe('视频介绍 Codex 桌面端的核心能力。');
    expect(parsed.analysis.timeline[0]).toMatchObject({
      id: 's-project',
      timestamp: 8,
      endTimestamp: 26,
    });
    expect(parsed.guide.contentType).toBe('课程讲解');
    expect(parsed.guide.decision.mustWatch[0]).toMatchObject({
      nodeId: 's-project',
      startTimestamp: 8,
      endTimestamp: 26,
    });
  });
});
