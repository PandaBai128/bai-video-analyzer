import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import type { VideoContextPackage } from '@core/followup/video-context-package';
import { buildPackage } from './_fixtures/select-followup-context-fixtures';
import type { SubtitleCue } from '@core/types';

/**
 * selectFollowupContext 防御性 + Round 16 字幕窗口兜底（current_segment /
 * explicit_time / selected_segment 主窗口 0 命中时退回 3-8 条最近 cue）。
 *
 * 拆自 `select-followup-context.test.ts`（原 943 行 → 按职责拆到多文件 < 800 行）。
 */

describe('selectFollowupContext 没有上下文时（防御性）', () => {
  it('空字幕 / 空时间线 / 空章节不报错，输出空 selection', () => {
    const empty: VideoContextPackage = {
      ...buildPackage(),
      transcriptCues: [],
      timeline: [],
      chapters: [],
    };
    const result = selectFollowupContext({
      question: '5:05 这段在讲什么',
      contextPackage: empty,
    });
    expect(result.primaryScope).toBe('explicit_time');
    expect(result.selectedTranscriptCues).toEqual([]);
    expect(result.selectedTimelineItems).toEqual([]);
    expect(result.selectedChapters).toEqual([]);
  });
});

describe('selectFollowupContext Round 16 必修 1：字幕窗口兜底', () => {
  it('current_segment 主窗口 0 命中但全视频有字幕 → 取最近的 3-8 条 cue', () => {
    const sparseCues: readonly SubtitleCue[] = [
      { start: 0, end: 5, text: 'cue-0' },
      { start: 10, end: 15, text: 'cue-10' },
      { start: 20, end: 25, text: 'cue-20' },
      { start: 30, end: 35, text: 'cue-30' },
      { start: 40, end: 45, text: 'cue-40' },
      { start: 50, end: 55, text: 'cue-50' },
      { start: 60, end: 65, text: 'cue-60' },
      { start: 70, end: 75, text: 'cue-70' },
    ];
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: buildPackage({ transcriptCues: sparseCues }),
      currentTime: 500,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.transcriptFallback).toBe(true);
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(0);
    expect(result.selectedTranscriptCues.length).toBeLessThanOrEqual(8);
  });

  it('explicit_time 窗口 0 命中但全视频有字幕 → 也走兜底', () => {
    const sparseCues: readonly SubtitleCue[] = [
      { start: 0, end: 5, text: 'cue-0' },
      { start: 10, end: 15, text: 'cue-10' },
      { start: 20, end: 25, text: 'cue-20' },
    ];
    const result = selectFollowupContext({
      question: '5:05 这段在讲什么',
      contextPackage: buildPackage({ transcriptCues: sparseCues }),
    });
    expect(result.primaryScope).toBe('explicit_time');
    expect(result.transcriptFallback).toBe(true);
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(0);
  });

  it('selected_segment 窗口 0 命中但全视频有字幕 → 也走兜底', () => {
    const sparseCues: readonly SubtitleCue[] = [
      { start: 0, end: 5, text: 'cue-0' },
      { start: 10, end: 15, text: 'cue-10' },
    ];
    const result = selectFollowupContext({
      question: '随便问',
      contextPackage: buildPackage({ transcriptCues: sparseCues }),
      currentTime: 50,
      selectedTimestamp: 999,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.transcriptFallback).toBe(true);
  });

  it('主窗口能命中 → 不算兜底', () => {
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.transcriptFallback).toBeFalsy();
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(0);
  });

  it('全视频 0 cue → 不算兜底（精准分析 / 无字幕视频）', () => {
    const empty: VideoContextPackage = {
      ...buildPackage(),
      transcriptCues: [],
    };
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: empty,
      currentTime: 50,
    });
    expect(result.transcriptFallback).toBeFalsy();
    expect(result.selectedTranscriptCues).toEqual([]);
  });
});
