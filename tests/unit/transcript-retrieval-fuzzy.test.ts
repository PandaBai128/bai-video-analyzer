import { describe, expect, it } from 'vitest';
import {
  isOneEditMatch,
  isOrderedCoverageMatch,
  orderedCoverageInsertionBudget,
  TOLERANT_MIN_TOPIC_LENGTH,
} from '@core/followup/transcript-retrieval-fuzzy';

/**
 * 容错匹配纯函数测试 —— ordered_coverage / one_edit / 预算 / 阈值。
 *
 * 不覆盖 `scoreQuestionMatchHits`（主 retrieval 模块负责）和 `buildCueWindows` /
 * `dedupeHitsBySize`（同模块）。本文件只测字符级 fuzzy 算法本身的可观察行为。
 */

describe('isOrderedCoverageMatch: 字符按序插入匹配', () => {
  it('"火电补偿部分倍率" 对 "火电补偿倍率" → matched=true, insertedChars=2', () => {
    const result = isOrderedCoverageMatch('火电补偿部分倍率', '火电补偿倍率');
    expect(result.matched).toBe(true);
    expect(result.insertedChars).toBe(2);
  });

  it('8:30 字幕 1 "毕竟火、电、以太的时间补偿部分倍率" → insertedChars ≤ 12', () => {
    // 经 normalizeForMatching：标点 → 空格、停用词 → 空格、折叠空白。
    const normalized = '毕竟火电以太时间补偿部分倍率';
    const result = isOrderedCoverageMatch(normalized, '火电补偿倍率');
    expect(result.matched).toBe(true);
    expect(result.insertedChars).toBeLessThanOrEqual(12);
    expect(result.insertedChars).toBeGreaterThanOrEqual(2);
  });

  it('9:44 字幕 "电以太和火的总倍率都是1900%" 字符顺序断裂 → 不命中', () => {
    const normalized = '电以太和火的总倍率都是1900';
    const result = isOrderedCoverageMatch(normalized, '火电补偿倍率');
    expect(result.matched).toBe(false);
  });

  it('边界: 空字符串 → 不命中', () => {
    expect(isOrderedCoverageMatch('', '火电补偿倍率')).toEqual({
      matched: false,
      insertedChars: 0,
    });
    expect(isOrderedCoverageMatch('火电补偿倍率', '')).toEqual({
      matched: false,
      insertedChars: 0,
    });
    expect(isOrderedCoverageMatch('', '')).toEqual({
      matched: false,
      insertedChars: 0,
    });
  });

  it('完全乱序（topic 字符全在 text 中但顺序错） → 不命中', () => {
    const result = isOrderedCoverageMatch('倍率补偿电火', '火电补偿倍率');
    expect(result.matched).toBe(false);
  });

  it('topic 字符部分缺失 → 不命中', () => {
    const result = isOrderedCoverageMatch('火电补倍率', '火电补偿倍率');
    expect(result.matched).toBe(false);
  });

  it('预算强制为 0 → 不允许任何插入扰动 → 不命中', () => {
    const result = isOrderedCoverageMatch('火电XYZ补偿倍率', '火电补偿倍率', 0);
    expect(result.matched).toBe(false);
  });

  it('增加普通前后缀不改变内部插入量', () => {
    const base = isOrderedCoverageMatch(
      '今天先看看火电补偿部分倍率具体怎么算',
      '火电补偿倍率',
    );
    const withPadding = isOrderedCoverageMatch(
      '前面还有别的今天先看看火电补偿部分倍率具体怎么算后面也有别的',
      '火电补偿倍率',
    );
    expect(base.matched).toBe(true);
    expect(withPadding.matched).toBe(true);
    expect(withPadding.insertedChars).toBe(base.insertedChars);
  });

  it('较差早期起点与紧凑后续起点并存时选择后者（最佳跨度算法）', () => {
    // text 含两个 "火"：第一个夹 XY 远离目标，第二个紧贴目标。
    const text = '火XY远火电补偿倍率';
    const result = isOrderedCoverageMatch(text, '火电补偿倍率');
    expect(result.matched).toBe(true);
    // 第二个起点 firstIdx=3，目标字符紧凑连续 → inserted = 0
    expect(result.insertedChars).toBe(0);
  });

  it('内部跨度超预算仍不命中', () => {
    const text = '火XY远远远远远电补偿倍率';
    const result = isOrderedCoverageMatch(text, '火电补偿倍率', 4);
    expect(result.matched).toBe(false);
    expect(result.insertedChars).toBeGreaterThan(4);
  });

  it('"系统方法" vs "系统介绍视频课程" 仅 "系统" 重叠 → 不命中', () => {
    const result = isOrderedCoverageMatch('系统介绍视频课程', '系统方法');
    expect(result.matched).toBe(false);
  });
});

describe('isOneEditMatch: 编辑距离 ≤ 1 + 锚点', () => {
  it('"维林娜一命" in "维琳娜一命"（替换 林→琳）→ 命中 + 距离 1', () => {
    const result = isOneEditMatch('维琳娜一命', '维林娜一命');
    expect(result.matched).toBe(true);
    expect(result.distance).toBe(1);
  });

  it('text.includes(topic) → 距离 0 + 命中', () => {
    const result = isOneEditMatch('维林娜一命', '维林娜一命');
    expect(result.matched).toBe(true);
    expect(result.distance).toBe(0);
  });

  it('完全无关 → 不命中', () => {
    const result = isOneEditMatch('完全不同无关内容', '维林娜一命');
    expect(result.matched).toBe(false);
    expect(result.distance).toBeGreaterThanOrEqual(2);
  });

  it('编辑距离 > 1 → 不命中', () => {
    const result = isOneEditMatch('维林AB一命', '维林娜一命');
    expect(result.matched).toBe(false);
    expect(result.distance).toBeGreaterThan(1);
  });

  it('无锚点（topic 子串都不在 text 中） → 不命中', () => {
    // topic = "苏格拉底" (4 字), text = "苏底" (2 字)
    // anchor: 任何 ≥ 2 字子串 of "苏格拉底" 在 "苏底" 中？都不在 → anchor 缺失
    const result = isOneEditMatch('苏底', '苏格拉底');
    expect(result.matched).toBe(false);
  });

  it('空字符串 → 不命中 + distance = -1', () => {
    expect(isOneEditMatch('', '维林娜一命')).toEqual({
      matched: false,
      distance: -1,
    });
    expect(isOneEditMatch('维林娜一命', '')).toEqual({
      matched: false,
      distance: -1,
    });
  });
});

describe('orderedCoverageInsertionBudget + TOLERANT_MIN_TOPIC_LENGTH', () => {
  it('orderedCoverageInsertionBudget = max(6, topic.length * 2)', () => {
    expect(orderedCoverageInsertionBudget(0)).toBe(6);
    expect(orderedCoverageInsertionBudget(1)).toBe(6);
    expect(orderedCoverageInsertionBudget(3)).toBe(6);
    expect(orderedCoverageInsertionBudget(5)).toBe(10);
    expect(orderedCoverageInsertionBudget(6)).toBe(12);
    expect(orderedCoverageInsertionBudget(10)).toBe(20);
    expect(orderedCoverageInsertionBudget(20)).toBe(40);
  });

  it('TOLERANT_MIN_TOPIC_LENGTH = 5（QA2 §C 恢复保守短主题边界）', () => {
    expect(TOLERANT_MIN_TOPIC_LENGTH).toBe(5);
  });
});
