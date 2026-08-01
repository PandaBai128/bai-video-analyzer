import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import type { VideoContextPackage } from '@core/followup/video-context-package';
import { buildPackage } from './_fixtures/select-followup-context-fixtures';
import type { SubtitleCue } from '@core/types';

/**
 * selectFollowupContext Round 29B QA 必修 B：globalContextMode 显式字段
 * （替代 cue 数量阈值启发式）—— 只对 global 有意义，其它 scope 不设值。
 *
 * 拆自 `select-followup-context.test.ts`（原 943 行 → 按职责拆到多文件 < 800 行）。
 */

describe('selectFollowupContext Round 29B QA 必修 B：globalContextMode 显式字段', () => {
  it('必修 B-1: 无派生分析时 global 写 globalContextMode=transcript_only（即使 cues < 24）', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 0, end: 5, text: 'cue-0' },
      { start: 200, end: 205, text: 'cue-200' },
      { start: 400, end: 405, text: 'cue-400' },
      { start: 590, end: 595, text: 'cue-590' },
    ];
    const base = buildPackage();
    const pkg: VideoContextPackage = {
      ...base,
      timeline: [],
      chapters: [],
      review: { keyPoints: [], summary: '' },
      duration: 600,
      transcriptCues: cues,
    };
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.globalContextMode).toBe('transcript_only');
  });

  it('必修 B-3: 非 global scope 时 globalContextMode **不**设值', () => {
    const explicit = selectFollowupContext({
      question: '12:30 这段',
      contextPackage: buildPackage(),
    });
    expect(explicit.primaryScope).toBe('explicit_time');
    expect(explicit.globalContextMode).toBeUndefined();

    const kw = selectFollowupContext({
      question: '有没有提到 BM25？',
      contextPackage: buildPackage(),
    });
    expect(kw.primaryScope).toBe('keyword_match');
    expect(kw.globalContextMode).toBeUndefined();

    const cur = selectFollowupContext({
      question: '这段在讲什么',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(cur.primaryScope).toBe('current_segment');
    expect(cur.globalContextMode).toBeUndefined();

    const sel = selectFollowupContext({
      question: '我选的这个节点',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 120,
    });
    expect(sel.primaryScope).toBe('selected_segment');
    expect(sel.globalContextMode).toBeUndefined();
  });
});
