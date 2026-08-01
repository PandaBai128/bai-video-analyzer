import { describe, expect, it } from 'vitest';
import { alignAnalysisToTranscriptEvidence } from '@core/analysis/transcript-evidence-alignment';
import type { SubtitleCue, VideoAnalysis } from '@core/types';

const SUBTITLES: SubtitleCue[] = [
  { start: 1866, end: 1872, text: 'Computer Use 可以操作 Mac 桌面应用' },
  { start: 1908, end: 1912, text: '这一段 Computer Use 的演示就先到这里' },
  { start: 1913, end: 1920, text: '那 Skills 本质上是把人的工作流人为沉淀下来' },
  { start: 1920, end: 1930, text: 'Skill 可以被重复调用，也可以做成团队规范' },
  { start: 2104, end: 2112, text: '接下来演示 Skill 的安装与创建流程' },
  { start: 2204, end: 2212, text: '后面进入自动化任务和 Schedule' },
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
        timestamp: 1866,
        endTimestamp: 2104,
        title: 'Computer Use 奇技淫巧',
        summary: '演示 Computer Use 操控桌面应用。',
        importance: 'recommended',
        contentTag: 'demo',
        watchGuide: '可轻放。',
        segments: [
          {
            timestamp: 1866,
            endTimestamp: 2104,
            title: 'Computer Use 奇技淫巧',
            summary: '演示 Computer Use 操控桌面应用。',
            importance: 'recommended',
            contentTag: 'demo',
          },
        ],
      },
      {
        timestamp: 2104,
        endTimestamp: 2309,
        title: '能力六：Skill 的安装与创建',
        summary: '演示 Skill 的安装、创建和沉淀。',
        importance: 'must-watch',
        contentTag: 'method',
        watchGuide: '理解 Skill 沉淀。',
        segments: [
          {
            timestamp: 2104,
            endTimestamp: 2309,
            title: 'Skill 的安装与创建',
            summary: '比字幕里 Skills 真实开始处晚了三分钟。',
            importance: 'must-watch',
            contentTag: 'method',
          },
        ],
      },
    ],
    timeline: [],
  };
}

describe('alignAnalysisToTranscriptEvidence', () => {
  it('无平台章节时，用字幕证据把分钟级后移的主题拉回真实开始 cue', () => {
    const aligned = alignAnalysisToTranscriptEvidence({
      analysis: makeAnalysis(),
      subtitles: SUBTITLES,
      duration: 2451,
    });

    expect(aligned.chapters[1]?.timestamp).toBe(1913);
    expect(aligned.chapters[1]?.segments[0]?.timestamp).toBe(1913);
    expect(aligned.chapters[0]?.endTimestamp).toBe(1913);
    expect(aligned.chapters[0]?.segments[0]?.endTimestamp).toBe(1913);
    expect(aligned.timeline).toEqual(aligned.chapters.flatMap((chapter) => chapter.segments));
  });

  it('偏差在 15 秒容忍范围内时不移动，避免过度追求绝对精度', () => {
    const analysis = makeAnalysis();
    const nearEnough: VideoAnalysis = {
      ...analysis,
      chapters: analysis.chapters.map((chapter) =>
        chapter.title.includes('Skill')
          ? {
              ...chapter,
              timestamp: 1922,
              segments: chapter.segments.map((segment) => ({ ...segment, timestamp: 1922 })),
            }
          : chapter,
      ),
    };

    const aligned = alignAnalysisToTranscriptEvidence({
      analysis: nearEnough,
      subtitles: SUBTITLES,
      duration: 2451,
    });

    expect(aligned.chapters[1]?.timestamp).toBe(1922);
    expect(aligned.chapters[1]?.segments[0]?.timestamp).toBe(1922);
  });

  it('字幕里找不到明确标题证据时不移动', () => {
    const analysis = makeAnalysis();
    const unrelated: VideoAnalysis = {
      ...analysis,
      chapters: analysis.chapters.map((chapter) =>
        chapter.title.includes('Skill')
          ? {
              ...chapter,
              title: '深度效率框架',
              summary: '字幕中没有明确重复这个标题。',
              segments: chapter.segments.map((segment) => ({
                ...segment,
                title: '深度效率框架',
                summary: '字幕中没有明确重复这个标题。',
              })),
            }
          : chapter,
      ),
    };

    const aligned = alignAnalysisToTranscriptEvidence({
      analysis: unrelated,
      subtitles: SUBTITLES,
      duration: 2451,
    });

    expect(aligned.chapters[1]?.timestamp).toBe(2104);
    expect(aligned.chapters[1]?.segments[0]?.timestamp).toBe(2104);
  });
});
