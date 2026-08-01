import { describe, expect, it } from 'vitest';
import {
  extractTimestampReferences,
  parseTimestampToSeconds,
} from '@core/followup/followup-timestamps';

describe('parseTimestampToSeconds (Round 16 必修 3)', () => {
  it('mm:ss → 秒', () => {
    expect(parseTimestampToSeconds('03:20')).toBe(200);
    expect(parseTimestampToSeconds('12:30')).toBe(750);
    expect(parseTimestampToSeconds('0:05')).toBe(5);
  });

  it('hh:mm:ss → 秒', () => {
    expect(parseTimestampToSeconds('1:02:11')).toBe(3731);
    expect(parseTimestampToSeconds('0:00:30')).toBe(30);
  });

  it('非法格式返回 null', () => {
    expect(parseTimestampToSeconds('99:99')).toBeNull();
    expect(parseTimestampToSeconds('abc')).toBeNull();
    expect(parseTimestampToSeconds('')).toBeNull();
  });
});

describe('extractTimestampReferences', () => {
  it('解析 [03:20] 为单一时间点', () => {
    const refs = extractTimestampReferences('在 [03:20] 这段视频讲过 BM25');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.start).toBe(200);
    expect(refs[0]?.end).toBeUndefined();
    expect(refs[0]?.raw).toBe('[03:20]');
  });

  it('[03:20-04:10] 解析为区间，取开始时间', () => {
    const refs = extractTimestampReferences('看 [03:20-04:10] 这段');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.start).toBe(200);
    expect(refs[0]?.end).toBe(250);
    expect(refs[0]?.raw).toBe('[03:20-04:10]');
  });

  it('[1:02:11] 解析为 hh:mm:ss', () => {
    const refs = extractTimestampReferences('看 [1:02:11] 这段');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.start).toBe(3731);
  });

  it('同一文本多个时间点都能解析', () => {
    const md = '看 [03:20] 和 [05:40-06:00] 段';
    const refs = extractTimestampReferences(md);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.start).toBe(200);
    expect(refs[1]?.start).toBe(340);
    expect(refs[1]?.end).toBe(360);
  });

  it('fenced code block 内的时间点被跳过', () => {
    const md = '```js\nconst t = "[03:20]";\n```\n真正的时间点：[05:40]';
    const refs = extractTimestampReferences(md);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.start).toBe(340);
    expect(refs[0]?.raw).toBe('[05:40]');
  });

  it('inline code 内的时间点被跳过', () => {
    const md = '代码 `[03:20]` 不应该被解析；真正的时间点：[05:40]';
    const refs = extractTimestampReferences(md);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.start).toBe(340);
  });

  it('空字符串返回空数组', () => {
    expect(extractTimestampReferences('')).toEqual([]);
  });

  it('不解析 Markdown 链接 URL 里的数字', () => {
    const md = '[外链](https://example.com/2026/06/12) 这段不该被解析；时间点：[05:40]';
    const refs = extractTimestampReferences(md);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.start).toBe(340);
  });

  it('不解析日期形式 2026-06-12（没有方括号）', () => {
    const md = '今天 2026-06-12 看了视频，没有时间点';
    const refs = extractTimestampReferences(md);
    expect(refs).toEqual([]);
  });
});
