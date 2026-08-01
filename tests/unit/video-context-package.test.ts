import { describe, expect, it } from 'vitest';
import {
  buildVideoContextPackage,
  isContextPackageValidFor,
  type VideoContextPackage,
} from '@core/followup/video-context-package';
import type {
  SubtitleCue,
  UserAnnotation,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
  TimelineNode,
} from '@core/types';

const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  author: '作者',
  duration: 600,
};

const TIMELINE: readonly TimelineNode[] = [
  { timestamp: 0, title: '开场', summary: '引入主题', importance: 'must-watch' },
  { timestamp: 120, title: '第一段', summary: '展开第一点', importance: 'recommended' },
];

const CHAPTERS: readonly VideoChapter[] = [
  {
    timestamp: 0,
    title: '章节一',
    summary: '概述',
    importance: 'must-watch',
    watchGuide: '快速过',
    segments: [TIMELINE[0]!, TIMELINE[1]!],
  },
];

const ANALYSIS: VideoAnalysis = {
  overview: '视频核心',
  watchStrategy: [],
  coreTakeaways: ['要点 A', '要点 B'],
  reviewSummary: '整体总结段落',
  chapters: CHAPTERS,
  timeline: TIMELINE,
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1700000000000,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

const CUES: readonly SubtitleCue[] = [
  { start: 0, end: 5, text: '第一句' },
  { start: 5, end: 10, text: '第二句' },
];

const ANNOTATIONS: readonly UserAnnotation[] = [
  {
    id: 'a-1',
    platform: 'bilibili',
    videoId: 'BV1xx',
    timestamp: 30,
    content: '记一下',
    createdAt: 1,
  },
];

describe('buildVideoContextPackage (字段对齐)', () => {
  it('把 VideoAnalysis 的核心字段映射到 context package', () => {
    const pkg = buildVideoContextPackage({
      metadata: METADATA,
      analysis: ANALYSIS,
      transcriptCues: CUES,
      annotations: ANNOTATIONS,
    });

    expect(pkg.platform).toBe('bilibili');
    expect(pkg.videoId).toBe('BV1xx');
    expect(pkg.title).toBe('测试视频');
    expect(pkg.author).toBe('作者');
    expect(pkg.duration).toBe(600);
    expect(pkg.analysisMode).toBe('subtitle');
    expect(pkg.transcriptCues).toEqual(CUES);
    expect(pkg.timeline).toBe(TIMELINE);
    expect(pkg.chapters).toBe(CHAPTERS);
    expect(pkg.review.keyPoints).toEqual(['要点 A', '要点 B']);
    expect(pkg.review.summary).toBe('整体总结段落');
    expect(pkg.annotations).toBe(ANNOTATIONS);
  });

  it('createdAt / updatedAt 默认用 analysis.generatedAt', () => {
    const pkg = buildVideoContextPackage({ metadata: METADATA, analysis: ANALYSIS });
    expect(pkg.createdAt).toBe(1700000000000);
    expect(pkg.updatedAt).toBe(1700000000000);
  });

  it('调用方显式传 createdAt / updatedAt 时优先用调用方的值', () => {
    const pkg = buildVideoContextPackage({
      metadata: METADATA,
      analysis: ANALYSIS,
      createdAt: 100,
      updatedAt: 200,
    });
    expect(pkg.createdAt).toBe(100);
    expect(pkg.updatedAt).toBe(200);
  });

  it('metadata 没 duration 时不写入 duration 字段（exactOptionalPropertyTypes 兼容）', () => {
    const metadata: VideoMetadata = { ...METADATA };
    delete (metadata as { duration?: number }).duration;
    const pkg = buildVideoContextPackage({ metadata, analysis: ANALYSIS });
    expect(pkg).not.toHaveProperty('duration');
  });

  it('transcript / annotations 缺省时默认空数组', () => {
    const pkg = buildVideoContextPackage({ metadata: METADATA, analysis: ANALYSIS });
    expect(pkg.transcriptCues).toEqual([]);
    expect(pkg.annotations).toEqual([]);
  });

  it('analysisMode 等于 analysis.sourceMode', () => {
    const pkg = buildVideoContextPackage({
      metadata: METADATA,
      analysis: { ...ANALYSIS, sourceMode: 'multimodal' },
    });
    expect(pkg.analysisMode).toBe('multimodal');
  });
});

describe('isContextPackageValidFor (没有分析结果时不能追问)', () => {
  const pkg: VideoContextPackage = buildVideoContextPackage({
    metadata: METADATA,
    analysis: ANALYSIS,
  });

  it('null 包永远 invalid', () => {
    expect(isContextPackageValidFor(null, { platform: 'bilibili', videoId: 'BV1xx' })).toBe(false);
  });

  it('videoId 不匹配时 invalid', () => {
    expect(isContextPackageValidFor(pkg, { platform: 'bilibili', videoId: 'BV2' })).toBe(false);
  });

  it('platform 不匹配时 invalid', () => {
    expect(isContextPackageValidFor(pkg, { platform: 'youtube', videoId: 'BV1xx' })).toBe(false);
  });

  it('platform + videoId 都匹配时 valid', () => {
    expect(isContextPackageValidFor(pkg, { platform: 'bilibili', videoId: 'BV1xx' })).toBe(true);
  });
});
