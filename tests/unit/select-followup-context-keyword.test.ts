import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import { buildPackage } from './_fixtures/select-followup-context-fixtures';
import type { SubtitleCue } from '@core/types';

/**
 * selectFollowupContext 关键词命中（"有没有提到 X"）+ 显式时间点（cue 切片）。
 *
 * 拆自 `select-followup-context.test.ts`（原 943 行 → 按职责拆到多文件 < 800 行）。
 */

describe('selectFollowupContext 关键词命中', () => {
  it('"有没有提到 X" 命中时给命中片段 + 命中时间点', () => {
    const result = selectFollowupContext({
      question: '有没有提到 BM25？',
      contextPackage: buildPackage(),
    });
    expect(result.primaryScope).toBe('keyword_match');
    expect(result.matchInfo?.keyword).toBe('BM25');
    expect(result.matchInfo?.hitCount).toBeGreaterThan(0);
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(0);
    expect(result.selectedTranscriptCues.some((c) => c.text.includes('BM25'))).toBe(true);
  });

  it('"有没有提到 X" 未命中时返回 hitCount=0', () => {
    const result = selectFollowupContext({
      question: '有没有提到 transformer？',
      contextPackage: buildPackage(),
    });
    expect(result.primaryScope).toBe('keyword_match');
    expect(result.matchInfo?.hitCount).toBe(0);
    expect(result.matchInfo?.hitTimestamps).toEqual([]);
  });

  it('自然问法剥掉"吗 / 在哪里"后，用完整字幕命中采样之外的内容', () => {
    const cues: SubtitleCue[] = Array.from({ length: 469 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
      text: index === 420 ? '这里提到了徐州老味菜和买单活动。' : `普通字幕 ${index}`,
    }));
    const result = selectFollowupContext({
      question: '有提到徐州吗，在哪里',
      contextPackage: buildPackage({ transcriptCues: cues }),
    });

    expect(result.primaryScope).toBe('keyword_match');
    expect(result.matchInfo).toMatchObject({
      keyword: '徐州',
      hitCount: 1,
    });
    expect(result.matchInfo?.hitTimestamps).toEqual([840]);
    expect(result.selectedTranscriptCues.some((cue) => cue.text.includes('徐州老味菜'))).toBe(true);
  });

  it('显式是否提到问法支持单字中文主题，用完整字幕定位"吃"相关片段', () => {
    const result = selectFollowupContext({
      question: '有没有提到吃什么吗',
      contextPackage: buildPackage({
        transcriptCues: [
          { start: 10, end: 13, text: '开场聊公司近况。' },
          { start: 480, end: 484, text: '这段说到吃进去之后的反应，以及地锅鸡。' },
          { start: 900, end: 904, text: '结尾做活动预告。' },
        ],
      }),
    });

    expect(result.primaryScope).toBe('keyword_match');
    expect(result.matchInfo).toMatchObject({
      keyword: '吃',
      hitCount: 1,
    });
    expect(result.matchInfo?.hitTimestamps).toEqual([480]);
    expect(result.selectedTranscriptCues.some((cue) => cue.text.includes('吃进去'))).toBe(true);
  });
});

describe('selectFollowupContext 显式时间点 (cue 切片)', () => {
  it('取时间点前后 -30s ~ +90s 的字幕', () => {
    const result = selectFollowupContext({
      question: '5:05 这段在讲什么',
      contextPackage: buildPackage(),
    });
    expect(result.primaryScope).toBe('explicit_time');
    const startTimes = result.selectedTranscriptCues.map((c) => c.start);
    expect(startTimes.some((s) => s >= 300 && s <= 320)).toBe(true);
  });

  it('包含覆盖该时间点的章节', () => {
    const result = selectFollowupContext({
      question: '1:30 这段',
      contextPackage: buildPackage(),
    });
    expect(result.selectedChapters.length).toBeGreaterThan(0);
    expect(result.selectedChapters[0]?.timestamp).toBe(0);
  });
});
