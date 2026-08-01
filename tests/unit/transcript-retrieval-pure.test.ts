import { describe, expect, it } from 'vitest';
import {
  applyCharBudgetToCuesWithCore,
  buildCueWindows,
  dedupeHitsBySize,
  hasReliableQueryHit,
  pickQuestionMatchCues,
  scoreHits,
  scoreQuestionMatchHits,
  type ScoredHit,
} from '@core/followup/transcript-retrieval';
import type { SubtitleCue } from '@core/types';
import type { FollowupQueryPlan } from '@core/followup/followup-query-topic';

/**
 * FR-01 + SG-05B 单元测试 —— 普通事实问题全字幕检索的纯函数行为。
 *
 * 文件拆分（FR-01 §3C）：
 * - 端到端（依赖 fixtures / `selectFollowupContext`）→ `transcript-retrieval.test.ts`。
 * - 本文件：**纯函数单元测试**（直接调用 `scoreHits` / `dedupeHitsBySize` /
 *   `buildCueWindows` / `pickQuestionMatchCues` / `applyCharBudgetToCuesWithCore` /
 *   `hasReliableQueryHit`，无需 fixtures）。
 *
 * 不变量：每个 describe 块保护 1 个公开 API + 不锁内部位置，不为每个私有 helper
 * 建 1:1 测例（任务单 §6 "不锁内部位置，也不为每个私有 scorer/tokenizer 写 1:1
 * 测试"）。
 */

// ---------------------------------------------------------------------------
// SG-05B QA1 单元：pickQuestionMatchCues 命中窗口 + 字符预算
// ---------------------------------------------------------------------------

describe('SG-05B QA1: pickQuestionMatchCues 命中窗口 + 字符预算', () => {
  it('验收 1: 最高分命中时间晚于次高分命中时，输出仍包含最高分 cue', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 105, text: '维琳娜一命效果 cue A' },
      { start: 1010, end: 1015, text: '维琳娜一命效果 cue B' },
    ];
    const tokens = ['维琳娜一命效果'];
    const scored = scoreHits(cues, tokens);
    expect(scored.length).toBe(2);
    const picked = pickQuestionMatchCues(scored, cues);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.map((c) => c.start)).toContain(100);
    expect(picked.map((c) => c.start)).toContain(1010);
  });

  it('验收 2: 多个命中相距很远时，分别扩窗并合并，不把二者之间整段塞入', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '维琳娜一命效果相关 cue 1' },
      { start: 60, end: 65, text: '中间无关 cue 1' },
      { start: 200, end: 205, text: '中间无关 cue 2' },
      { start: 400, end: 405, text: '中间无关 cue 3' },
      { start: 600, end: 605, text: '中间无关 cue 4' },
      { start: 800, end: 805, text: '中间无关 cue 5' },
      { start: 1000, end: 1005, text: '维琳娜一命效果相关 cue 2' },
    ];
    const tokens = ['维琳娜一命效果'];
    const scored = scoreHits(cues, tokens);
    const picked = pickQuestionMatchCues(scored, cues);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(1000);
    expect(starts).not.toContain(200);
    expect(starts).not.toContain(400);
    expect(starts).not.toContain(600);
    expect(starts).not.toContain(800);
    expect(starts).toContain(60);
  });

  it('验收 3: 字符预算紧张时仍保留各核心命中', () => {
    const hugeText = '维琳娜一命效果 ' + 'a'.repeat(4985);
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '维琳娜一命效果 cue 1' },
      { start: 100, end: 105, text: '次要 cue 1' },
      { start: 200, end: 205, text: '次要 cue 2' },
      { start: 300, end: 305, text: '次要 cue 3' },
      { start: 1000, end: 1005, text: hugeText },
    ];
    const tokens = ['维琳娜一命效果'];
    const scored = scoreHits(cues, tokens);
    const picked = pickQuestionMatchCues(scored, cues, 6, 12, 20, 1500);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(1000);
    const totalChars = picked.reduce((sum, c) => sum + (c.text ?? '').length, 0);
    expect(totalChars).toBeLessThanOrEqual(1500);
    const coreCue2 = picked.find((c) => c.start === 1000);
    expect(coreCue2?.text.length).toBeLessThan(5000);
    expect(coreCue2?.text.length).toBeGreaterThan(0);
  });

  it('applyCharBudgetToCuesWithCore: 公平份额（QA3 B 修复）', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 105, text: 'core A' },
      { start: 200, end: 205, text: 'other X' },
      { start: 300, end: 305, text: 'coreBBBBBB' },
      { start: 400, end: 405, text: 'other Y' },
    ];
    const coreStarts = new Set([100, 300]);
    const picked = applyCharBudgetToCuesWithCore(cues, coreStarts, 10);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(100);
    expect(starts).toContain(300);
    expect(starts).not.toContain(200);
    expect(starts).not.toContain(400);
    const totalChars = picked.reduce((sum, c) => sum + (c.text ?? '').length, 0);
    expect(totalChars).toBeLessThanOrEqual(10);
    const coreA = picked.find((c) => c.start === 100);
    const coreB = picked.find((c) => c.start === 300);
    expect(coreA?.text.length).toBe(5);
    expect(coreB?.text.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// SG-05B QA2 时间升序单元
// ---------------------------------------------------------------------------

describe('SG-05B QA2: applyCharBudgetToCuesWithCore 时间升序', () => {
  it('验收 1: core 50s / other 60s / core 1000s，结果严格为时间升序', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: 'core 50s 命中 cue 文本' },
      { start: 60, end: 65, text: 'other 60s 邻近 cue' },
      { start: 1000, end: 1005, text: 'core 1000s 命中 cue 文本' },
    ];
    const coreStarts = new Set([50, 1000]);
    const picked = applyCharBudgetToCuesWithCore(cues, coreStarts, 6000);
    expect(picked.map((c) => c.start)).toEqual([50, 60, 1000]);
  });

  it('验收 2: 首个 core 超长且预算极小时，后续 core 仍有非空文本', () => {
    const huge = 'a'.repeat(5000);
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: huge },
      { start: 1000, end: 1005, text: 'core 1000s short' },
    ];
    const coreStarts = new Set([50, 1000]);
    const picked = applyCharBudgetToCuesWithCore(cues, coreStarts, 100);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(1000);
    const totalChars = picked.reduce((sum, c) => sum + (c.text ?? '').length, 0);
    expect(totalChars).toBeLessThanOrEqual(100);
    const core50 = picked.find((c) => c.start === 50);
    expect(core50?.text.length).toBeLessThan(5000);
    expect(core50?.text.length).toBeGreaterThan(0);
    const core1000 = picked.find((c) => c.start === 1000);
    expect(core1000?.text.length).toBeGreaterThan(0);
    expect(starts).toEqual([50, 1000]);
  });

  it('验收 3: 多个 core + neighbours，所有 core 保留 + 升序 + 总预算受控', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: 'core 50' },
      { start: 100, end: 105, text: 'neighbour 100' },
      { start: 200, end: 205, text: 'core 200' },
      { start: 300, end: 305, text: 'core 300' },
      { start: 400, end: 405, text: 'neighbour 400' },
    ];
    const coreStarts = new Set([50, 200, 300]);
    const picked = applyCharBudgetToCuesWithCore(cues, coreStarts, 50);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(200);
    expect(starts).toContain(300);
    const totalChars = picked.reduce((sum, c) => sum + (c.text ?? '').length, 0);
    expect(totalChars).toBeLessThanOrEqual(50);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// SG-05B QA3 公平份额单元
// ---------------------------------------------------------------------------

describe('SG-05B QA3: applyCharBudgetToCuesWithCore 公平份额（验收 5-6）', () => {
  it('验收 5: 两个超长 core + budget 100，两者均获可读片段（后者非 1 字符）', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: 'a'.repeat(5000) },
      { start: 1000, end: 1005, text: 'core 1000s short' },
    ];
    const coreStarts = new Set([50, 1000]);
    const picked = applyCharBudgetToCuesWithCore(cues, coreStarts, 100);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(1000);
    const totalChars = picked.reduce((sum, c) => sum + (c.text ?? '').length, 0);
    expect(totalChars).toBeLessThanOrEqual(100);
    const core50 = picked.find((c) => c.start === 50);
    expect(core50?.text.length).toBeLessThan(5000);
    expect(core50?.text.length).toBeGreaterThan(0);
    const core1000 = picked.find((c) => c.start === 1000);
    expect(core1000?.text.length).toBeGreaterThan(1);
    expect(starts).toEqual([50, 1000]);
  });

  it('验收 6: 3 core + neighbours，core 公平保留 + 总预算受控 + 时间升序', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: 'core 50s' },
      { start: 100, end: 105, text: 'neighbour 100s short' },
      { start: 200, end: 205, text: 'core 200s' },
      { start: 300, end: 305, text: 'core 300s' },
      { start: 400, end: 405, text: 'neighbour 400s short' },
    ];
    const coreStarts = new Set([50, 200, 300]);
    const picked = applyCharBudgetToCuesWithCore(cues, coreStarts, 50);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(200);
    expect(starts).toContain(300);
    const totalChars = picked.reduce((sum, c) => sum + (c.text ?? '').length, 0);
    expect(totalChars).toBeLessThanOrEqual(50);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-01 单元补充：buildCueWindows + scoreHits + dedupeHitsBySize + hasReliableQueryHit
// ---------------------------------------------------------------------------

describe('FR-01 单元补充: buildCueWindows / scoreHits / dedupeHitsBySize / hasReliableQueryHit', () => {
  it('buildCueWindows: 相邻 cue（间隔 ≤ gapS）才合并', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 0, end: 2, text: 'A' },
      { start: 5, end: 7, text: 'B' }, // 间隔 3s 边界
      { start: 8, end: 10, text: 'C' }, // 间隔 1s
      { start: 20, end: 22, text: 'D' }, // 间隔 10s > 3s
    ];
    const windows = buildCueWindows(cues, 3);
    const size1 = windows.filter((w) => w.size === 1);
    const size2 = windows.filter((w) => w.size === 2);
    const size3 = windows.filter((w) => w.size === 3);
    expect(size1.length).toBe(4);
    expect(size2.length).toBe(2); // [A,B], [B,C]
    expect(size3.length).toBe(1); // [A,B,C]
    expect(size3[0]!.cues.map((c) => c.start)).toEqual([0, 5, 8]);
  });

  it('buildCueWindows: 空 cues 返回空数组', () => {
    expect(buildCueWindows([])).toEqual([]);
  });

  it('buildCueWindows: 单条 cue 仅返回 size=1 窗口', () => {
    const windows = buildCueWindows([{ start: 0, end: 5, text: 'A' }]);
    expect(windows.length).toBe(1);
    expect(windows[0]!.size).toBe(1);
  });

  it('scoreHits: 单条 cue 命中（cues 间隔很大）', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: 'AI 模型介绍' },
      { start: 500, end: 510, text: '深度学习入门' },
      { start: 1000, end: 1010, text: 'AI 应用案例' },
    ];
    const tokens = ['ai'];
    const scored = scoreHits(cues, tokens);
    expect(scored.length).toBe(2); // cue 100 + cue 1000
    expect(hasReliableQueryHit(scored)).toBe(true);
  });

  it('scoreHits: 1-3 条窗口都生成（cues 相邻）', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 102, text: 'A' },
      { start: 103, end: 105, text: 'B' },
      { start: 106, end: 108, text: 'C' },
    ];
    const windows = buildCueWindows(cues, 3);
    expect(windows.filter((w) => w.size === 1).length).toBe(3);
    expect(windows.filter((w) => w.size === 2).length).toBe(2);
    expect(windows.filter((w) => w.size === 3).length).toBe(1);
  });

  it('scoreHits: 空 tokens 返回空', () => {
    const cues: readonly SubtitleCue[] = [{ start: 100, end: 110, text: 'A' }];
    expect(scoreHits(cues, [])).toEqual([]);
  });

  it('scoreHits: 空 cues 返回空', () => {
    expect(scoreHits([], ['ai'])).toEqual([]);
  });

  it('dedupeHitsBySize: 优先保留更小窗口', () => {
    const hits: ScoredHit[] = [
      {
        window: {
          cues: [
            { start: 100, end: 102, text: 'A' },
            { start: 103, end: 105, text: 'B' },
            { start: 106, end: 108, text: 'C' },
          ],
          size: 3,
          startMin: 100,
          endMax: 108,
          normalizedText: 'abc',
        },
        cue: { start: 100, end: 102, text: 'A' },
        score: 3,
        reliableScore: 3,
        matchKind: 'exact',
      },
      {
        window: {
          cues: [{ start: 100, end: 102, text: 'A' }],
          size: 1,
          startMin: 100,
          endMax: 102,
          normalizedText: 'a',
        },
        cue: { start: 100, end: 102, text: 'A' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
    ];
    const deduped = dedupeHitsBySize(hits);
    expect(deduped.length).toBe(1);
    expect(deduped[0]!.window.size).toBe(1);
  });

  it('dedupeHitsBySize: 不重叠的多个窗口都保留', () => {
    const hits: ScoredHit[] = [
      {
        window: {
          cues: [{ start: 100, end: 102, text: 'A' }],
          size: 1,
          startMin: 100,
          endMax: 102,
          normalizedText: 'a',
        },
        cue: { start: 100, end: 102, text: 'A' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
      {
        window: {
          cues: [{ start: 500, end: 502, text: 'B' }],
          size: 1,
          startMin: 500,
          endMax: 502,
          normalizedText: 'b',
        },
        cue: { start: 500, end: 502, text: 'B' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
    ];
    const deduped = dedupeHitsBySize(hits);
    expect(deduped.length).toBe(2);
  });

  // FR-01 QA1 验收：去重条件改为"共享同一原始 cue"。
  it('FR-01 QA1 验收 1: 时间区间重叠但 cue 不同 → 两条独立 size=1 命中都保留', () => {
    // 关键 bug 场景（QA1 §1）：cue A (start=10, end=15) 与 cue B (start=14, end=18)
    // 时间轴重叠（14-15 区间重合），但它们是**不同原始字幕**，查询"鲁迅"时
    // 两个 size=1 命中都应保留。旧版按时间区间重叠判断 → 错误只保留 start=10。
    const hits: ScoredHit[] = [
      {
        window: {
          cues: [{ start: 10, end: 15, text: '这里介绍鲁迅' }],
          size: 1,
          startMin: 10,
          endMax: 15,
          normalizedText: '这里介绍鲁迅',
        },
        cue: { start: 10, end: 15, text: '这里介绍鲁迅' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
      {
        window: {
          cues: [{ start: 14, end: 18, text: '再次提到鲁迅作品' }],
          size: 1,
          startMin: 14,
          endMax: 18,
          normalizedText: '再次提到鲁迅作品',
        },
        cue: { start: 14, end: 18, text: '再次提到鲁迅作品' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
    ];
    const deduped = dedupeHitsBySize(hits);
    expect(deduped.length).toBe(2);
    // 时间升序稳定排序：start 10 在前，14 在后
    expect(deduped[0]!.cue.start).toBe(10);
    expect(deduped[1]!.cue.start).toBe(14);
  });

  it('FR-01 QA1 验收 2: 共享 cue 的 size=1 + size=2 → 仍优先保留更小窗口', () => {
    // QA1 §1 第 3 条：共享原始 cue 的大小窗口仍优先保留更小窗口。
    const hits: ScoredHit[] = [
      {
        window: {
          cues: [
            { start: 100, end: 102, text: 'A' },
            { start: 103, end: 105, text: 'B' },
          ],
          size: 2,
          startMin: 100,
          endMax: 105,
          normalizedText: 'ab',
        },
        cue: { start: 100, end: 102, text: 'A' },
        score: 2,
        reliableScore: 2,
        matchKind: 'exact',
      },
      {
        window: {
          cues: [{ start: 100, end: 102, text: 'A' }],
          size: 1,
          startMin: 100,
          endMax: 102,
          normalizedText: 'a',
        },
        cue: { start: 100, end: 102, text: 'A' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
    ];
    const deduped = dedupeHitsBySize(hits);
    // size=1 优先（先排序）→ 接受 → size=2 共享 cue A → 被跳过
    expect(deduped.length).toBe(1);
    expect(deduped[0]!.window.size).toBe(1);
  });

  // FR-01 QA2 验收：去重完成后最终按时间升序（不按 size）。
  it('FR-01 QA2 验收: 早期 size=2 + 后期 size=1 不共享 cue → 结果按 startMin 升序 [10, 100]', () => {
    // 关键 bug 场景（QA2 §1）：早期 size=2 窗口 start=10 与后期 size=1 窗口 start=100
    // 不共享 cue，按"size 优先 + 时间稳定"应都保留。但 QA2 修复前最终返回值不重排
    // → 顺序是 [100, 10]（按 size 排序保留），导致 `slice(0, 6)` 偏向较晚的命中。
    const hits: ScoredHit[] = [
      {
        window: {
          cues: [
            { start: 10, end: 12, text: 'A' },
            { start: 13, end: 15, text: 'B' },
          ],
          size: 2,
          startMin: 10,
          endMax: 15,
          normalizedText: 'ab',
        },
        cue: { start: 10, end: 12, text: 'A' },
        score: 2,
        reliableScore: 2,
        matchKind: 'exact',
      },
      {
        window: {
          cues: [{ start: 100, end: 102, text: 'C' }],
          size: 1,
          startMin: 100,
          endMax: 102,
          normalizedText: 'c',
        },
        cue: { start: 100, end: 102, text: 'C' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
    ];
    const deduped = dedupeHitsBySize(hits);
    expect(deduped.length).toBe(2);
    // 关键验收：按 startMin 升序，不按 size
    expect(deduped.map((h) => h.window.startMin)).toEqual([10, 100]);
    expect(deduped[0]!.window.size).toBe(2);
    expect(deduped[1]!.window.size).toBe(1);
  });

  it('dedupeHitsBySize: 空 hits 返回空', () => {
    expect(dedupeHitsBySize([])).toEqual([]);
  });

  it('pickQuestionMatchCues: 窗口命中 → 所有 cues 属于 core（FR-01 §3A 第 6 条）', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 1049, end: 1054, text: '我们先看维琳娜的' },
      { start: 1054, end: 1059, text: '一命效果和触发逻辑' },
    ];
    const tokens = ['维琳娜一命效果'];
    const scored = scoreHits(cues, tokens);
    expect(scored.filter((h) => h.window.size === 2).length).toBe(1);
    const deduped = dedupeHitsBySize(scored);
    const picked = pickQuestionMatchCues(deduped, cues);
    const starts = picked.map((c) => c.start);
    expect(starts).toContain(1049);
    expect(starts).toContain(1054);
  });

  it('pickQuestionMatchCues: 空输入返回空', () => {
    expect(pickQuestionMatchCues([], [])).toEqual([]);
    expect(
      pickQuestionMatchCues([], [{ start: 100, end: 110, text: 'A' }]),
    ).toEqual([]);
  });

  it('hasReliableQueryHit: 空 scored 返回 false', () => {
    expect(hasReliableQueryHit([])).toBe(false);
  });

  it('hasReliableQueryHit: 可靠分 > 0 返回 true', () => {
    const hits: ScoredHit[] = [
      {
        window: {
          cues: [{ start: 100, end: 110, text: 'A' }],
          size: 1,
          startMin: 100,
          endMax: 110,
          normalizedText: 'a',
        },
        cue: { start: 100, end: 110, text: 'A' },
        score: 1,
        reliableScore: 1,
        matchKind: 'exact',
      },
    ];
    expect(hasReliableQueryHit(hits)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-02 §3 集成负责人: scoreQuestionMatchHits 三层匹配
// ---------------------------------------------------------------------------

describe('FR-02 §3 集成负责人: scoreQuestionMatchHits 三层匹配', () => {
  it('exact: topic 完整 substring 命中 → matchKind=exact', () => {
    // 用无停用词的 cue，确保 exact 路径短路命中。
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 105, text: '维林娜一命效果非常强' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '维林娜一命',
      orderedTopic: '维林娜一命',
      originalQuestion: '维林娜一命好吗',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.matchKind).toBe('exact');
  });

  it('one_edit: "维林娜一命" 字幕 "维琳娜一命" → matchKind=one_edit（plan.orderedTopic="" 跳过 oc 层）', () => {
    // orderedTopic="" → ordered_coverage 层被跳过（plan 字段契约），然后 one_edit 命中
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 105, text: '维琳娜一命效果相关' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '维林娜一命',
      orderedTopic: '',
      originalQuestion: '维林娜一命好吗',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.matchKind).toBe('one_edit');
  });

  it('ordered_coverage: "火电补偿倍率" 字幕 "火电补偿部分倍率" → matchKind=ordered_coverage', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 510, end: 514, text: '火电补偿部分倍率相关' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '火电补偿倍率',
      orderedTopic: '火电补偿倍率',
      originalQuestion: '火电补偿倍率等于什么',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.matchKind).toBe('ordered_coverage');
  });

  it('QA2 §A 验收: 一次返回 matchKind 完全一致（exact 短路 → 不混 one_edit）', () => {
    // QA2 §A 必修修复：scoreQuestionMatchHits 全局停止降级 —— 一次返回集合的
    // matchKind 必须完全一致。本测试即使 cue 200 能 one_edit 命中，因 cue 100
    // 已 exact 命中 → 不会混层返回 cue 200 one_edit。
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 102, text: '维林娜一命效果完整介绍' }, // exact
      { start: 200, end: 202, text: '维琳娜一命效果' }, // 若不短路，可 one_edit
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '维林娜一命',
      orderedTopic: '',
      originalQuestion: '维林娜一命',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBeGreaterThan(0);
    // 全部都是 exact；one_edit 候选被短路排除
    expect(hits.every((h) => h.matchKind === 'exact')).toBe(true);
    expect(hits.some((h) => h.window.startMin === 100)).toBe(true);
  });

  it('边界: 空 cues → 空数组', () => {
    const plan: FollowupQueryPlan = {
      exactTopic: '维林娜一命',
      orderedTopic: '维林娜一命',
      originalQuestion: '维林娜一命',
    };
    expect(scoreQuestionMatchHits([], plan)).toEqual([]);
  });

  it('边界: 空 plan 字段 → 空数组', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 102, text: 'A' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '',
      orderedTopic: '',
      originalQuestion: '',
    };
    expect(scoreQuestionMatchHits(cues, plan)).toEqual([]);
  });

  it('边界: 2 字短主题 < TOLERANT_MIN_TOPIC_LENGTH → 仅 exact 启用，one_edit/ordered_coverage 跳过', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 102, text: 'AI 模型介绍' },
    ];
    // 关键：plan.exactTopic 应该是归一化后的形式（小写），与 window.normalizedText 对齐
    const plan: FollowupQueryPlan = {
      exactTopic: 'ai',
      orderedTopic: 'ai',
      originalQuestion: 'AI',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    // ai 是 substring → exact 命中
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.matchKind).toBe('exact');
    // 但如果是错字 "al" vs "ai"，one_edit 不会启用（topic length=2 < 4）
    const cues2: readonly SubtitleCue[] = [
      { start: 100, end: 102, text: 'Al 模型介绍' },
    ];
    const hits2 = scoreQuestionMatchHits(cues2, plan);
    // 无 exact 命中，无容错命中（topic < 4 不启用）
    expect(hits2.length).toBe(0);
  });

  it('QA2 §A 必修验收: 全局停止降级 — 远处 one_edit 候选不会被 exact 全局命中"复活"', () => {
    // 关键场景（QA2 §A handoff 端到端竞争测试）：
    // - cue 10s "维琳娜一命"（one_edit 候选）
    // - cue 100s "维林娜一命"（exact 候选）
    // 问"维林娜一命好吗"
    //
    // 旧算法：每个 window 各自跑 exact → OC → one_edit，可能把 cue 10s one_edit 也收进来。
    // 新算法：全局 exact 命中 cue 100s → 短路返回，cue 10s one_edit 不会被引入。
    const cues: readonly SubtitleCue[] = [
      { start: 10, end: 12, text: '维琳娜一命' },
      { start: 100, end: 102, text: '维林娜一命' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '维林娜一命',
      orderedTopic: '维林娜一命',
      originalQuestion: '维林娜一命好吗',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    // 只命中 cue 100s exact
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.matchKind === 'exact')).toBe(true);
    const starts = hits.map((h) => h.window.startMin);
    expect(starts).toContain(100);
    expect(starts).not.toContain(10);
  });

  it('QA2 §A 验收: exact 全零 → ordered_coverage 兜底', () => {
    // 没有 exact 命中（cue 无完整 topic），降级到 ordered_coverage。
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 102, text: '火电补偿部分倍率相关' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '火电补偿倍率',
      orderedTopic: '火电补偿倍率',
      originalQuestion: '火电补偿倍率怎么算',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.matchKind === 'ordered_coverage')).toBe(true);
  });

  it('QA2 §A 验收: exact + OC 全零 → one_edit 兜底', () => {
    // cue 只有 1 字不同（林↔琳），且不是 substring 命中。
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 102, text: '维琳娜一命' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '维林娜一命',
      orderedTopic: '',
      originalQuestion: '维林娜一命好吗',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.matchKind === 'one_edit')).toBe(true);
  });

  it('集成验收: 8:30 字幕 1 ordered_coverage 命中（实际 insertedChars ≤ 12）', () => {
    // handoff §2 第 2 条真实场景
    const cues: readonly SubtitleCue[] = [
      { start: 510, end: 514, text: '毕竟火、电、以太的时间补偿部分倍率相关' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '火电补偿倍率',
      orderedTopic: '火电补偿倍率',
      originalQuestion: '火电补偿倍率等于什么',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.matchKind).toBe('ordered_coverage');
  });

  it('集成验收: 9:44 字幕字符顺序断裂 → 不命中', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 584, end: 588, text: '电以太和火的总倍率都是1900%相关' },
    ];
    const plan: FollowupQueryPlan = {
      exactTopic: '火电补偿倍率',
      orderedTopic: '火电补偿倍率',
      originalQuestion: '火电补偿倍率等于什么',
    };
    const hits = scoreQuestionMatchHits(cues, plan);
    expect(hits.length).toBe(0);
  });
});
