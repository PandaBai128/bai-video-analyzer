import { describe, expect, it } from 'vitest';
import { alignAnalysisToPlatformChapters } from '@core/analysis/platform-chapter-alignment';
import type { VideoAnalysis, VideoPlatformChapter } from '@core/types';

const PLATFORM_CHAPTERS: VideoPlatformChapter[] = [
  { title: '项目开发', start: 1262, end: 1611 },
  { title: '插件使用', start: 1611, end: 1913 },
  { title: 'Skills', start: 1913, end: 2204 },
  { title: '自动化任务', start: 2204, end: 2451 },
];

function makeAnalysis(): VideoAnalysis {
  return {
    overview: 'Codex 教程',
    watchStrategy: [],
    coreTakeaways: [],
    reviewSummary: '',
    quotes: [],
    keyConcepts: [],
    inspirations: [],
    generatedAt: 1,
    modelUsed: 'test-model',
    sourceMode: 'subtitle',
    chapters: [
      {
        timestamp: 1260,
        endTimestamp: 1620,
        title: '能力四：image2 生图与个人主页开发',
        summary: '用计划模式开发个人主页网站。',
        importance: 'recommended',
        contentTag: 'case',
        watchGuide: '可看项目开发。',
        segments: [
          {
            timestamp: 1260,
            endTimestamp: 1611,
            title: '个人主页开发',
            summary: '计划模式与 image2。',
            importance: 'recommended',
            contentTag: 'case',
          },
        ],
      },
      {
        timestamp: 1620,
        endTimestamp: 1866,
        title: '能力五：插件与 Netlify 部署',
        summary: '讲解插件并部署。',
        importance: 'recommended',
        contentTag: 'tool',
        watchGuide: '看插件部署。',
        segments: [
          {
            timestamp: 1620,
            endTimestamp: 1866,
            title: '插件与部署',
            summary: 'Netlify、Browser Use 等。',
            importance: 'recommended',
            contentTag: 'tool',
          },
          {
            timestamp: 1866,
            endTimestamp: 2104,
            title: 'Computer Use 奇技淫巧',
            summary: '模型误把 Computer Use 拉长到 Skills 段。',
            importance: 'recommended',
            contentTag: 'demo',
          },
        ],
      },
      {
        timestamp: 2104,
        endTimestamp: 2309,
        title: '能力六：Skill 的安装与创建',
        summary: '演示安装和创建 Skill。',
        importance: 'must-watch',
        contentTag: 'method',
        watchGuide: '重点理解 Skill 沉淀。',
        segments: [
          {
            timestamp: 2104,
            endTimestamp: 2309,
            title: 'Skill 的安装与创建',
            summary: '比平台章节晚了三分钟才开始。',
            importance: 'must-watch',
            contentTag: 'method',
          },
        ],
      },
    ],
    timeline: [
      {
        timestamp: 1260,
        endTimestamp: 1611,
        title: '个人主页开发',
        summary: '计划模式与 image2。',
        importance: 'recommended',
        contentTag: 'case',
      },
      {
        timestamp: 1620,
        endTimestamp: 1866,
        title: '插件与部署',
        summary: 'Netlify、Browser Use 等。',
        importance: 'recommended',
        contentTag: 'tool',
      },
      {
        timestamp: 1866,
        endTimestamp: 2104,
        title: 'Computer Use 奇技淫巧',
        summary: '模型误把 Computer Use 拉长到 Skills 段。',
        importance: 'recommended',
        contentTag: 'demo',
      },
      {
        timestamp: 2104,
        endTimestamp: 2309,
        title: 'Skill 的安装与创建',
        summary: '比平台章节晚了三分钟才开始。',
        importance: 'must-watch',
        contentTag: 'method',
      },
    ],
  };
}

describe('alignAnalysisToPlatformChapters', () => {
  it('用 B 站平台章节锚住后半段边界，避免 Skills 被模型延后到 35 分钟', () => {
    const aligned = alignAnalysisToPlatformChapters({
      analysis: makeAnalysis(),
      platformChapters: PLATFORM_CHAPTERS,
      duration: 2451,
    });

    expect(aligned.chapters.map((chapter) => [chapter.title, chapter.timestamp, chapter.endTimestamp])).toEqual([
      ['项目开发', 1262, 1611],
      ['插件使用', 1611, 1913],
      ['Skills', 1913, 2204],
      ['自动化任务', 2204, 2451],
    ]);
    expect(aligned.chapters[2]?.segments[0]?.timestamp).toBe(1913);
    expect(aligned.chapters[2]?.segments[0]?.title).toBe('Skills');
    expect(aligned.chapters[2]?.segments.some((segment) => segment.title.includes('Skill'))).toBe(true);
  });
});
