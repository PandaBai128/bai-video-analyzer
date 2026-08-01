import { describe, expect, it } from 'vitest';
import { mapCueIdsToTimestamps } from '@core/analysis/timeline-cue-mapping';
import type { SubtitleCue } from '@core/types';

const SAMPLE_SUBTITLES: SubtitleCue[] = [
  { start: 0, end: 6, text: 'cue 0' },
  { start: 6, end: 12, text: 'cue 1' },
  { start: 39, end: 45, text: 'cue 2 (铺垫)' },
  { start: 50, end: 58, text: 'cue 3 (主题)' },
  { start: 100, end: 110, text: 'cue 4' },
];

describe('mapCueIdsToTimestamps (Round 23 必修 B2)', () => {
  it('startCueId 优先于 timestamp：模型自报 39 但 cue 2=39s → 实际用 39', () => {
    const result = mapCueIdsToTimestamps({
      subtitles: SAMPLE_SUBTITLES,
      chapters: [
        {
          timestamp: 99, // 模型自报错的 timestamp
          startCueId: 2, // 实际指向 cue 2 (39-45s)
          endCueId: 3, // 实际指向 cue 3 (50-58s, end=58)
          title: '章 A',
          summary: 'A',
          importance: 'recommended',
          watchGuide: '',
          segments: [
            {
              timestamp: 99,
              startCueId: 2,
              endCueId: 3,
              title: 's1',
              summary: 's1',
              importance: 'recommended',
            },
          ],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(39); // 来自 cue 2.start
    expect(result[0]?.endTimestamp).toBe(58); // 来自 cue 3.end
    expect(result[0]?.segments[0]?.timestamp).toBe(39);
    expect(result[0]?.segments[0]?.endTimestamp).toBe(58);
  });

  it('用户场景：0:39 标成 0:50 主题 → 实际 50s（cue 3）', () => {
    // 真实 bug 场景：模型把 0:39-0:52 写成"总结市场失望的原因"，但实际 50s 才开始
    // 用户用 startCueId=3 修正后，最终 timestamp=50
    const result = mapCueIdsToTimestamps({
      subtitles: SAMPLE_SUBTITLES,
      chapters: [
        {
          timestamp: 39, // 模型自报错的 timestamp（提前归纳）
          endTimestamp: 52,
          startCueId: 3, // 修正后用 50s 字幕
          endCueId: 3,
          title: '总结市场失望的原因',
          summary: '这一段才真正开始讲主题',
          importance: 'recommended',
          watchGuide: '',
          segments: [
            {
              timestamp: 39,
              endTimestamp: 52,
              startCueId: 3,
              endCueId: 3,
              title: '主题段',
              summary: 's',
              importance: 'recommended',
            },
          ],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(50);
    expect(result[0]?.endTimestamp).toBe(58); // cue 3.end=58（>= 50）
    expect(result[0]?.segments[0]?.timestamp).toBe(50);
  });

  it('缺 cue id 时 fallback 到模型自报 timestamp（旧 schema 兼容）', () => {
    const result = mapCueIdsToTimestamps({
      subtitles: SAMPLE_SUBTITLES,
      chapters: [
        {
          timestamp: 20, // 旧 schema 只给 timestamp
          endTimestamp: 30,
          title: '章 A',
          summary: 'A',
          importance: 'recommended',
          watchGuide: '',
          segments: [
            {
              timestamp: 22,
              endTimestamp: 28,
              title: 's1',
              summary: 's1',
              importance: 'recommended',
            },
          ],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(20);
    expect(result[0]?.endTimestamp).toBe(30);
    expect(result[0]?.segments[0]?.timestamp).toBe(22);
  });

  it('subtitles 为空时跳过映射，全部用 timestamp', () => {
    const result = mapCueIdsToTimestamps({
      subtitles: [],
      chapters: [
        {
          timestamp: 20,
          startCueId: 3, // 缺字幕时不应生效
          endCueId: 4,
          title: '章 A',
          summary: 'A',
          importance: 'recommended',
          watchGuide: '',
          segments: [],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(20);
    expect(result[0]?.endTimestamp).toBeUndefined();
  });

  it('cue id 越界（>= subtitles.length）→ fallback 到 timestamp', () => {
    const result = mapCueIdsToTimestamps({
      subtitles: SAMPLE_SUBTITLES, // length=5
      chapters: [
        {
          timestamp: 20,
          startCueId: 99, // 越界
          endCueId: 100,
          title: '章 A',
          summary: 'A',
          importance: 'recommended',
          watchGuide: '',
          segments: [
            {
              timestamp: 22,
              startCueId: 999, // 越界
              title: 's1',
              summary: 's1',
              importance: 'recommended',
            },
          ],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(20);
    expect(result[0]?.endTimestamp).toBeUndefined();
    expect(result[0]?.segments[0]?.timestamp).toBe(22);
  });

  it('cue id 负数 → fallback 到 timestamp', () => {
    const result = mapCueIdsToTimestamps({
      subtitles: SAMPLE_SUBTITLES,
      chapters: [
        {
          timestamp: 20,
          startCueId: -1,
          endCueId: -5,
          title: 'A',
          summary: 'A',
          importance: 'recommended',
          watchGuide: '',
          segments: [],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(20);
  });

  it('cue 缺 end 字段时，endCueId 映射回落为 cue.start（不返回 undefined）', () => {
    const subtitlesNoEnd: SubtitleCue[] = [
      { start: 0, text: 'no end' }, // 没有 end
      { start: 100, text: 'no end 2' },
    ];
    const result = mapCueIdsToTimestamps({
      subtitles: subtitlesNoEnd,
      chapters: [
        {
          timestamp: 0,
          startCueId: 0,
          endCueId: 1,
          title: 'A',
          summary: 'A',
          importance: 'recommended',
          watchGuide: '',
          segments: [],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(0);
    expect(result[0]?.endTimestamp).toBe(100); // 回落为 cue 1.start
  });

  it('cue id 非整数 → fallback', () => {
    const result = mapCueIdsToTimestamps({
      subtitles: SAMPLE_SUBTITLES,
      chapters: [
        {
          timestamp: 20,
          startCueId: 1.5, // 非整数
          title: 'A',
          summary: 'A',
          importance: 'recommended',
          watchGuide: '',
          segments: [],
        },
      ],
    });

    expect(result[0]?.timestamp).toBe(20);
  });
});
