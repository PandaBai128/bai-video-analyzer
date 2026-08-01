import { describe, expect, it } from 'vitest';
import { normalizeChapterTimelineStructure } from '@core/analysis/timeline-normalize';
import type { VideoChapter } from '@core/types';

const chapter = (input: {
  timestamp: number;
  endTimestamp?: number;
  title: string;
  segments: Array<{ timestamp: number; endTimestamp?: number; title: string; summary?: string }>;
}): VideoChapter => {
  const segments = input.segments.map((s) => {
    const base: {
      timestamp: number;
      title: string;
      summary: string;
      importance: 'recommended';
      endTimestamp?: number;
    } = {
      timestamp: s.timestamp,
      title: s.title,
      summary: s.summary ?? `${s.title} 摘要`,
      importance: 'recommended',
    };
    if (typeof s.endTimestamp === 'number') {
      base.endTimestamp = s.endTimestamp;
    }
    return base;
  });
  const out: {
    timestamp: number;
    title: string;
    summary: string;
    importance: 'recommended';
    watchGuide: string;
    segments: typeof segments;
    endTimestamp?: number;
  } = {
    timestamp: input.timestamp,
    title: input.title,
    summary: `${input.title} 摘要`,
    importance: 'recommended',
    watchGuide: 'wg',
    segments,
  };
  if (typeof input.endTimestamp === 'number') {
    out.endTimestamp = input.endTimestamp;
  }
  return out;
};

describe('normalizeChapterTimelineStructure (Round 22 必修 B2)', () => {
  it('同 BV 不同 p 排序：chapter 1 含 chapter 2 范围的 segment → 移回 chapter 1', () => {
    // 原始输入：chapter 1 范围 [0, 60)，chapter 2 范围 [60, 120)。
    // 但 chapter 2 里含一个 segment timestamp=30（属于 chapter 1 范围），
    // 正常化后该 segment 应归到 chapter 1。
    const chapters = [
      chapter({
        timestamp: 0,
        endTimestamp: 60,
        title: '章 1',
        segments: [{ timestamp: 0, endTimestamp: 30, title: 's1-a' }],
      }),
      chapter({
        timestamp: 60,
        endTimestamp: 120,
        title: '章 2',
        segments: [
          { timestamp: 30, endTimestamp: 45, title: 's2-越界' }, // 越界
          { timestamp: 70, endTimestamp: 90, title: 's2-正常' },
        ],
      }),
    ];

    const { chapters: out, timeline } = normalizeChapterTimelineStructure(chapters);

    // chapter 1 应收 s1-a + 越界的 s2-越界
    const chapter1 = out[0];
    expect(chapter1?.title).toBe('章 1');
    expect(chapter1?.segments.map((s) => s.title)).toEqual(['s1-a', 's2-越界']);

    // chapter 2 应收 s2-正常
    const chapter2 = out[1];
    expect(chapter2?.title).toBe('章 2');
    expect(chapter2?.segments.map((s) => s.title)).toEqual(['s2-正常']);

    // timeline == chapters.flatMap(segments)
    expect(timeline.map((n) => n.title)).toEqual(['s1-a', 's2-越界', 's2-正常']);
  });

  it('segments 乱序 → 排序后展示', () => {
    const chapters = [
      chapter({
        timestamp: 0,
        endTimestamp: 60,
        title: '章 1',
        segments: [
          { timestamp: 40, title: 'c' },
          { timestamp: 10, title: 'a' },
          { timestamp: 25, title: 'b' },
        ],
      }),
    ];

    const { chapters: out, timeline } = normalizeChapterTimelineStructure(chapters);
    expect(out[0]?.segments.map((s) => s.title)).toEqual(['a', 'b', 'c']);
    expect(timeline.map((n) => n.title)).toEqual(['a', 'b', 'c']);
  });

  it('chapter endTimestamp < 最后 segment endTimestamp → endTimestamp 被扩展', () => {
    const chapters = [
      chapter({
        timestamp: 0,
        endTimestamp: 30, // 故意 < 末段 end
        title: '章 1',
        segments: [
          { timestamp: 0, endTimestamp: 20, title: 'a' },
          { timestamp: 25, endTimestamp: 80, title: 'b' }, // 末段 end=80 > 30
        ],
      }),
    ];

    const { chapters: out } = normalizeChapterTimelineStructure(chapters);
    expect(out[0]?.endTimestamp).toBe(80);
  });

  it('chapters 顺序乱序 → 按 timestamp 升序排好', () => {
    const chapters = [
      chapter({ timestamp: 60, endTimestamp: 90, title: '章 2', segments: [] }),
      chapter({ timestamp: 0, endTimestamp: 30, title: '章 1', segments: [] }),
      chapter({ timestamp: 30, endTimestamp: 60, title: '章 1.5', segments: [] }),
    ];

    const { chapters: out } = normalizeChapterTimelineStructure(chapters);
    expect(out.map((c) => c.title)).toEqual(['章 1', '章 1.5', '章 2']);
  });

  it('chapter endTimestamp 不应超过下一 chapter 的 timestamp', () => {
    const chapters = [
      chapter({
        timestamp: 0,
        endTimestamp: 200,
        title: '章 1',
        segments: [{ timestamp: 50, endTimestamp: 90, title: 'a' }],
      }),
      chapter({
        timestamp: 100,
        endTimestamp: 200,
        title: '章 2',
        segments: [{ timestamp: 110, endTimestamp: 130, title: 'b' }],
      }),
    ];

    const { chapters: out } = normalizeChapterTimelineStructure(chapters);
    // chapter 1 的 endTimestamp 应被截到 100（下一个 chapter 起点）
    expect(out[0]?.endTimestamp).toBe(100);
  });

  it('重叠 chapter：下一章起点处的 segment 不应留在上一章', () => {
    const chapters = [
      chapter({
        timestamp: 0,
        endTimestamp: 746,
        title: '章 1',
        segments: [
          { timestamp: 0, endTimestamp: 25, title: 's1-a' },
          { timestamp: 302, endTimestamp: 578, title: '边界小节' },
        ],
      }),
      chapter({
        timestamp: 302,
        endTimestamp: 746,
        title: '章 2',
        segments: [{ timestamp: 303, endTimestamp: 400, title: 's2-a' }],
      }),
    ];

    const { chapters: out, timeline } = normalizeChapterTimelineStructure(chapters);

    expect(out[0]?.endTimestamp).toBe(302);
    expect(out[0]?.segments.map((s) => s.title)).toEqual(['s1-a']);
    expect(out[1]?.segments.map((s) => s.title)).toEqual(['边界小节', 's2-a']);
    expect(timeline.map((s) => s.title)).toEqual(['s1-a', '边界小节', 's2-a']);
  });

  it('修完后 timeline == chapters.flatMap(segments)（不变量）', () => {
    const chapters = [
      chapter({
        timestamp: 0,
        endTimestamp: 60,
        title: '章 1',
        segments: [
          { timestamp: 0, title: 'a' },
          { timestamp: 30, title: 'b' },
        ],
      }),
      chapter({
        timestamp: 60,
        endTimestamp: 120,
        title: '章 2',
        segments: [
          { timestamp: 80, title: 'c' },
          { timestamp: 100, title: 'd' },
        ],
      }),
    ];

    const { chapters: out, timeline } = normalizeChapterTimelineStructure(chapters);
    expect(timeline).toEqual(out.flatMap((c) => c.segments));
  });

  it('duration 已知：超出 duration 的 chapter / segment 被裁掉', () => {
    const chapters = [
      chapter({
        timestamp: 0,
        endTimestamp: 60,
        title: '章 1',
        segments: [
          { timestamp: 0, endTimestamp: 30, title: 'a' },
          { timestamp: 40, endTimestamp: 80, title: 'b' },
        ],
      }),
      chapter({
        timestamp: 60,
        endTimestamp: 200,
        title: '章 2',
        segments: [{ timestamp: 100, endTimestamp: 150, title: 'c' }],
      }),
    ];

    const { chapters: out, timeline } = normalizeChapterTimelineStructure(chapters, 90);
    // chapter 2 timestamp=60 ≤ 90 保留
    expect(out.length).toBe(2);
    // chapter 1 segment b.end=80 > 30 但 ≤90，保留
    // chapter 2 segment c.timestamp=100 > 90 → 裁掉，chapter 2 segments 变空
    expect(out[1]?.segments.length).toBe(0);
    expect(timeline.length).toBe(2);
  });

  it('重点标签保持稀缺：章节最多约 30%，每章小节最多保留 1 个重点', () => {
    const chapters: VideoChapter[] = Array.from({ length: 7 }, (_, index) => ({
      timestamp: index * 300,
      endTimestamp: index * 300 + 300,
      title:
        index === 3
          ? 'AGENTS.md 方法体系'
          : index === 4
            ? '项目实战案例'
            : `普通配置章节 ${index + 1}`,
      summary: index === 3 ? '讲项目约束和方法流程。' : '讲工具配置和普通演示。',
      importance: 'must-watch' as const,
      contentTag: index === 3 ? 'method' : index === 4 ? 'case' : 'setup',
      watchGuide: '看',
      segments: [
        {
          timestamp: index * 300,
          title: `小节 A ${index + 1}`,
          summary: '普通步骤。',
          importance: 'must-watch' as const,
          contentTag: 'setup',
        },
        {
          timestamp: index * 300 + 120,
          title: `小节 B ${index + 1}`,
          summary: '核心方法。',
          importance: 'must-watch' as const,
          contentTag: 'method',
        },
      ],
    }));

    const { chapters: out, timeline } = normalizeChapterTimelineStructure(chapters);

    expect(out.filter((item) => item.importance === 'must-watch')).toHaveLength(2);
    expect(out.find((item) => item.title === 'AGENTS.md 方法体系')?.importance).toBe('must-watch');
    expect(out.find((item) => item.title === '项目实战案例')?.importance).toBe('must-watch');
    for (const item of out) {
      expect(item.segments.filter((segment) => segment.importance === 'must-watch')).toHaveLength(1);
    }
    expect(timeline).toEqual(out.flatMap((item) => item.segments));
  });

  it('空输入 → 空输出', () => {
    const { chapters, timeline } = normalizeChapterTimelineStructure([]);
    expect(chapters).toEqual([]);
    expect(timeline).toEqual([]);
  });
});
