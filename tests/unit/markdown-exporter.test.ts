import { describe, expect, it } from 'vitest';
import { createVideoMarkdownExport, sanitizeFileName } from '@core/export/markdown-exporter';
import type { LearningSession, VideoAnalysis, VideoMetadata } from '@core/types';

describe('sanitizeFileName', () => {
  it('removes characters that cannot be used in local file names', () => {
    expect(sanitizeFileName('bilibili:BV1/test*video?')).toBe('bilibili-BV1-test-video-');
  });
});

describe('createVideoMarkdownExport', () => {
  it('creates one standardized Markdown note', () => {
    const metadata: VideoMetadata = {
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
      title: '测试视频',
      author: '作者',
    };
    const analysis: VideoAnalysis = {
      overview: '视频核心',
      watchStrategy: ['先看开场'],
      coreTakeaways: ['复盘总结'],
      reviewSummary: '整体总结段落',
      chapters: [
        {
          timestamp: 0,
          endTimestamp: 60,
          title: '第一章',
          summary: '章节摘要',
          importance: 'must-watch',
          watchGuide: '重点看主题',
          segments: [
            {
              timestamp: 0,
              title: '开场',
              summary: '介绍主题',
              importance: 'must-watch',
            },
          ],
        },
      ],
      timeline: [
        {
          timestamp: 0,
          endTimestamp: 60,
          title: '开场',
          summary: '介绍主题',
          importance: 'must-watch',
        },
      ],
      quotes: [],
      keyConcepts: [],
      inspirations: [],
      generatedAt: 1,
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    };

    const output = createVideoMarkdownExport({
      metadata,
      analysis,
      learningSession: {
        id: 'bilibili:BV1xx411c7mD',
        schemaVersion: 2,
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD:p=2',
        goal: {
          mode: 'adaptive',
          focus: '落地到项目',
          guideOptionId: 'ship',
          label: '提炼可落地动作',
          instruction: '按项目行动整理',
        },
        coach: { enabled: true, intensity: 'light', customInstruction: '' },
        guide: {
          contentType: '教程攻略',
          contentTypeReason: '视频在讲方法步骤。',
          suggestedStance: '边看边提炼可执行动作。',
          decision: {
            rating: 'worth_watching',
            score: 86,
            valueProfile: {
              kind: 'learning_tutorial',
              label: '教程攻略',
              criteria: [
                { label: '结构清晰', score: 86, reason: '方法步骤清楚。' },
                { label: '可迁移性', score: 88, reason: '适合落地到项目。' },
                { label: '实践成本', score: 82, reason: '需要自行执行。' },
              ],
            },
            verdict: '值得看，重点看方法步骤。',
            overallMeaning: '视频能帮助用户把问题定义和行动拆开。',
            reason: '中段步骤清楚，适合迁移。',
            bestFor: ['想推进项目的人'],
            notFor: [],
            timePlans: [],
            mustWatch: [
              {
                title: '先定义边界',
                tag: 'method',
                reason: '这里是关键方法。',
                startTimestamp: 12,
              },
            ],
            canWatch: [],
            canSkim: [],
            canSkip: [],
            reservations: ['边界清晰度需要自己验证。'],
            },
          generatedAt: 1,
          modelUsed: 'MiniMax-M2.7-highspeed',
        },
        moments: [
          {
            id: 'm1',
            kind: 'insight',
            content: '我注意到先定义边界更重要',
            timestamp: 12,
            coach: {
              response: '这条可以转成项目里的不做清单。',
              handling: 'apply',
              suggestedQuestions: [],
              nextAction: '写出三个不做项',
              linkedTimestamps: [],
              generatedAt: 1,
              modelUsed: 'MiniMax-M2.7-highspeed',
            },
            createdAt: 1,
          },
        ],
        exchanges: [
          {
            id: 'e1',
            question: '怎么应用？',
            answer: '先做一个最小实验。',
            includedInReview: true,
            createdAt: 1,
          },
          {
            id: 'e2',
            question: '这条只是临时问问吗？',
            answer: '不应该默认进入笔记。',
            createdAt: 2,
          },
        ],
        review: {
          coreSummary: '视频讲清了如何先定义问题再行动。',
          keyIdeas: [
            {
              title: '先定义边界',
              explanation: '边界决定方案是否可验证。',
              evidenceTimestamp: 12,
            },
          ],
          personalInsights: ['我更关注可验证性，这会让我先判断方案能否被验证，而不是急着堆功能。'],
          transferReflection: '我可以把这个判断迁移到自己的项目里：先定义边界，再决定是否进入执行。',
          openQuestions: ['如何衡量边界是否足够清晰？'],
          actionItems: ['在当前项目写出三个不做项。'],
          finalReflection: '这次学习让我把重点从堆功能转向定义边界。',
          generatedAt: 2,
          modelUsed: 'MiniMax-M2.7-highspeed',
        },
        createdAt: 1,
        updatedAt: 2,
      } satisfies LearningSession,
      exportedAt: 2,
    });

    expect(output.fileName).toBe('B站-测试视频.md');
    expect(output.content).toContain('# 测试视频');
    expect(output.content).toContain('## 基本信息');
    expect(output.content).toContain('| 作者 | 作者 |');
    expect(output.content).toContain('| 地址 | https://www.bilibili.com/video/BV1xx411c7mD/ |');
    expect(output.content).toContain('| 观看时间 |');
    expect(output.content).not.toContain('| 导出时间 |');
    expect(output.content).toContain('| 补充关注点 | 落地到项目 |');
    expect(output.content).toContain('## 1. 视频讲了什么');
    expect(output.content).toContain('## 2. 我得到了什么');
    expect(output.content).toContain('### 我得到了什么');
    expect(output.content).toContain('### 我可以根据这个做什么');
    expect(output.content).toContain('### 下一步怎么做');
    expect(output.content).not.toContain('### 可以单独记住的点');
    expect(output.content).not.toContain('### 可以尝试');
    expect(output.content).toContain('**这次学习让我把重点从堆功能转向定义边界。**');
    expect(output.content).toContain(
      '1. 我更关注可验证性，这会让我先判断方案能否被验证，而不是急着堆功能。',
    );
    expect(output.content).toContain(
      '我可以把这个判断迁移到自己的项目里：先定义边界，再决定是否进入执行。',
    );
    expect(output.content).toContain('1. 在当前项目写出三个不做项。');
    expect(output.content).not.toContain('#### 收获 1');
    expect(output.content).toContain('教程攻略');
    expect(output.content).toContain('## 3. 哪些观点值得参考');
    expect(output.content).toContain('### [0:00-1:00] 先定义边界');
    expect(output.content.match(/^### \[[^\]]+\] 先定义边界$/gm)).toHaveLength(1);
    expect(output.content).toContain('补充说明：这条可以转成项目里的不做清单。');
    expect(output.content).toContain('建议下一步：写出三个不做项');
    expect(output.content).not.toContain('导师回应（行动）');
    expect(output.content).toContain('## 5. 我的记录');
    expect(output.content).toContain('#### [0:12] 发现');
    expect(output.content).not.toContain('**发现');
    expect(output.content).not.toContain('**我问');
    expect(output.content).not.toContain('**导师');
    expect(output.content).toContain('### 加入笔记的问答');
    expect(output.content).toContain('怎么应用？');
    expect(output.content).toContain('回答：先做一个最小实验。');
    expect(output.content).not.toContain('这条只是临时问问吗？');
    expect(output.content).not.toContain('## 我的学习收获');
    expect(output.content).not.toContain('## 导航时间线');
    expect(output.content).toContain('## 4. 哪些我需要保留判断');
    expect(output.content).not.toContain('## 待澄清与验证');
  });

  it('escapes metadata inside the Markdown table', () => {
    const output = createVideoMarkdownExport({
      metadata: {
        platform: 'youtube',
        videoId: 'video-1',
        url: 'https://example.com/watch?v=video-1&title=a|b',
        title: '标题 | 带竖线\n第二行',
        author: '作者 | 频道',
      },
      analysis: null,
      learningSession: {
        id: 'youtube:video-1',
        schemaVersion: 2,
        platform: 'youtube',
        videoId: 'video-1',
        goal: { mode: 'adaptive', focus: '目标 | 关注点' },
        coach: { enabled: false, intensity: 'light', customInstruction: '' },
        moments: [],
        exchanges: [],
        review: {
          coreSummary: '核心总结',
          keyIdeas: [{ title: '关键观点', explanation: '解释' }],
          personalInsights: [],
          openQuestions: [],
          actionItems: [],
          finalReflection: '学习总结',
          generatedAt: 1,
          modelUsed: 'model',
        },
        createdAt: 1,
        updatedAt: 1,
      },
      exportedAt: 2,
    });

    expect(output.content).toContain('# 标题 | 带竖线 第二行');
    expect(output.content).toContain('| 视频 | 标题 \\| 带竖线 第二行 |');
    expect(output.content).toContain('| 作者 | 作者 \\| 频道 |');
    expect(output.content).toContain('| 地址 | https://example.com/watch?v=video-1&title=a\\|b |');
    expect(output.content).toContain('| 补充关注点 | 目标 \\| 关注点 |');
    expect(output.content).not.toContain('| 关注点 | 目标 \\| 关注点 |');
    expect(output.content).not.toContain('## 5. 📝 我的记录');
  });
});
