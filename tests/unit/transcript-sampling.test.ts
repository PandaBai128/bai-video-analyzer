import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import { pickRepresentativeCues } from '@core/followup/transcript-sampling';
import {
  buildVideoContextPackage,
  type VideoContextPackage,
} from '@core/followup/video-context-package';
import type {
  SubtitleCue,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
} from '@core/types';

/**
 * 全片均匀采样（transcript-only global）+ 字符预算 + globalContextMode 行为测例。
 *
 * SG-05B §4：删除"有派生分析就只取前 8 条字幕"行为 —— 那是 §1 真实用户 bug。
 * 现在 global 统一走 transcript_only 全片均匀采样，**无论** timeline / chapters /
 * review 是否存在。
 *
 * 测试**端到端**通过 selectFollowupContext / 直接调用 pickRepresentativeCues 验证，
 * 不锁内部模块位置（任务单 §5 "尽量保持公开入口"）。
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  author: '作者',
  duration: 1800,
};

const TIMELINE: readonly TimelineNode[] = [
  { timestamp: 0, title: '开场', summary: '引入主题', importance: 'must-watch' },
  { timestamp: 1050, title: '17:29 段落', summary: '维琳娜一命效果相关', importance: 'must-watch' },
];

const CHAPTERS: readonly VideoChapter[] = [
  {
    timestamp: 0,
    endTimestamp: 1000,
    title: '章节一',
    summary: '基础介绍',
    importance: 'must-watch',
    watchGuide: '看',
    segments: [TIMELINE[0]!],
  },
  {
    timestamp: 1000,
    endTimestamp: 1800,
    title: '章节二',
    summary: '包含维琳娜段落',
    importance: 'must-watch',
    watchGuide: '看',
    segments: [TIMELINE[1]!],
  },
];

const ANALYSIS: VideoAnalysis = {
  overview: '视频核心',
  watchStrategy: [],
  coreTakeaways: ['要点 A', '要点 B'],
  reviewSummary: '整体总结',
  chapters: CHAPTERS,
  timeline: TIMELINE,
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

function buildTranscriptOnlyPackage(
  transcriptCues: readonly SubtitleCue[],
  duration = 600,
  analysis: VideoAnalysis | null = null,
): VideoContextPackage {
  if (analysis) {
    const base = buildVideoContextPackage({
      metadata: METADATA,
      analysis,
      transcriptCues,
      annotations: [],
    });
    return {
      ...base,
      timeline: analysis.timeline,
      chapters: analysis.chapters,
      review: { keyPoints: analysis.coreTakeaways, summary: analysis.reviewSummary || '' },
      duration,
    };
  }
  // 无派生分析：手搓 minimal pkg（buildVideoContextPackage 要求 non-null analysis）
  return {
    platform: METADATA.platform,
    videoId: METADATA.videoId,
    contentKey: 'bilibili:BV1xx',
    url: METADATA.url,
    title: METADATA.title,
    author: METADATA.author,
    analysisMode: 'subtitle',
    overview: '',
    transcriptCues,
    timeline: [],
    chapters: [],
    review: { keyPoints: [], summary: '' },
    annotations: [],
    createdAt: 0,
    updatedAt: 0,
    duration,
  };
}

// ---------------------------------------------------------------------------
// pickRepresentativeCues 字符预算 / 排序（直接单元）
// ---------------------------------------------------------------------------

describe('pickRepresentativeCues 字符预算保护', () => {
  it('必修 A-6: 单条极长 cue 截断到剩余预算（不爆 prompt）', () => {
    // 模拟单条 cue 文本远超过 TRANSCRIPT_ONLY_MAX_CHARS (8000)
    const longCues: readonly SubtitleCue[] = [
      { start: 0, end: 5, text: 'a'.repeat(10000) },
    ];
    const sampled = pickRepresentativeCues(longCues, 600);
    expect(sampled.length).toBe(1);
    // 文本被截到 8000 字符（TRANSCRIPT_ONLY_MAX_CHARS）
    expect(sampled[0]?.text.length).toBeLessThanOrEqual(8000);
    expect(sampled[0]?.text.length).toBeGreaterThan(0);
  });

  it('必修 A-7: 多条超长 cue 累计 ≤ TRANSCRIPT_ONLY_MAX_CHARS', () => {
    const huge = 'a'.repeat(3000);
    const cues: readonly SubtitleCue[] = Array.from({ length: 5 }, (_, i) => ({
      start: i * 120,
      end: i * 120 + 5,
      text: huge,
    }));
    const sampled = pickRepresentativeCues(cues, 600);
    const totalChars = sampled.reduce((sum, c) => sum + c.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(8000);
  });

  it('必修 A-8: cues 为空时返回 []', () => {
    expect(pickRepresentativeCues([], 600)).toEqual([]);
  });

  it('必修 A-10: 输入乱序也输出按 start 升序', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 590, end: 595, text: '结尾' },
      { start: 0, end: 5, text: '开头' },
      { start: 300, end: 305, text: '中段' },
    ];
    const sampled = pickRepresentativeCues(cues, 600);
    const starts = sampled.map((c) => c.start);
    expect(starts).toContain(0);
    expect(starts).toContain(300);
    expect(starts).toContain(590);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// global 端到端：全片均匀采样 + globalContextMode 总是 transcript_only
// ---------------------------------------------------------------------------

describe('SG-05B §4: global 全片均匀采样（删除"少量代表性字幕"分流）', () => {
  it('必修 A-1: 60 条 cue / 600s 视频：global 返回 > 8 条（不再只前 8 条）', () => {
    const cues: readonly SubtitleCue[] = Array.from({ length: 60 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 5,
      text: `cue-${i}`,
    }));
    const pkg = buildTranscriptOnlyPackage(cues, 600);
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(8);
  });

  it('必修 A-2: 全片均匀采样覆盖中段（>= 300）+ 后段（>= 500）', () => {
    const cues: readonly SubtitleCue[] = Array.from({ length: 60 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 5,
      text: `cue-${i}`,
    }));
    const pkg = buildTranscriptOnlyPackage(cues, 600);
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    // 60 cues / 600s 视频，桶中心在 0-600 间分布；要求覆盖中段和后段
    expect(starts.some((s) => s >= 300)).toBe(true);
    expect(starts.some((s) => s >= 500)).toBe(true);
  });

  it('必修 A-3: 结果按 start 升序（不是采样顺序）', () => {
    const cues: readonly SubtitleCue[] = Array.from({ length: 60 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 5,
      text: `cue-${i}`,
    }));
    const pkg = buildTranscriptOnlyPackage(cues, 600);
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]!);
    }
  });

  it('必修 B-1: 稀疏字幕（4 条 cues）下 globalContextMode 仍 transcript_only', () => {
    // 旧 24 阈值启发式会漏判；显式字段必须永远正确
    const cues: readonly SubtitleCue[] = [
      { start: 0, end: 5, text: 'cue-0' },
      { start: 200, end: 205, text: 'cue-200' },
      { start: 400, end: 405, text: 'cue-400' },
      { start: 590, end: 595, text: 'cue-590' },
    ];
    const pkg = buildTranscriptOnlyPackage(cues, 600);
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.globalContextMode).toBe('transcript_only');
  });

  it('必修 B-2: 有派生分析（timeline + chapters + review）时 global 仍 transcript_only（删除"少量代表性字幕"分流）', () => {
    const cues: readonly SubtitleCue[] = Array.from({ length: 60 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 5,
      text: `cue-${i}`,
    }));
    const pkg = buildTranscriptOnlyPackage(cues, 600, ANALYSIS);
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.globalContextMode).toBe('transcript_only');
    // 派生分析存在时仍走全片均匀采样（> 8 条）
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(8);
  });

  it('必修 B-4: coreTakeaways 单字段非空时 global 仍 transcript_only', () => {
    const cues: readonly SubtitleCue[] = Array.from({ length: 30 }, (_, i) => ({
      start: i * 20,
      end: i * 20 + 5,
      text: `cue-${i}`,
    }));
    const partialAnalysis: VideoAnalysis = {
      ...ANALYSIS,
      timeline: [],
      chapters: [],
      coreTakeaways: ['要点 A'],
      reviewSummary: '',
    };
    const pkg = buildTranscriptOnlyPackage(cues, 600, partialAnalysis);
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.globalContextMode).toBe('transcript_only');
  });

  it('必修 B-5: reviewSummary 单字段非空时 global 仍 transcript_only', () => {
    const cues: readonly SubtitleCue[] = Array.from({ length: 30 }, (_, i) => ({
      start: i * 20,
      end: i * 20 + 5,
      text: `cue-${i}`,
    }));
    const partialAnalysis: VideoAnalysis = {
      ...ANALYSIS,
      timeline: [],
      chapters: [],
      coreTakeaways: [],
      reviewSummary: '整体总结',
    };
    const pkg = buildTranscriptOnlyPackage(cues, 600, partialAnalysis);
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.globalContextMode).toBe('transcript_only');
  });
});
