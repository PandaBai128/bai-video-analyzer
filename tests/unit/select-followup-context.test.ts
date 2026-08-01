/**
 * select-followup-context 路由层测试 — 入口占位文件。
 *
 * 原 943 行按职责拆到 6 个新文件 + 1 个共享 fixtures：
 * - `_fixtures/select-followup-context-fixtures.ts` — METADATA / TIMELINE / CHAPTERS /
 *   CUES / ANALYSIS / ANNOTATIONS / buildPackage()
 * - `select-followup-context-parsers.test.ts` — parseExplicitTimestamp / extractKeywordAfterProbe
 * - `select-followup-context-priority.test.ts` — 路由优先级 1-9
 * - `select-followup-context-round20.test.ts` — Round 20 双义词消除
 * - `select-followup-context-round21.test.ts` — Round 21 explicit/ambiguous 拆分
 * - `select-followup-context-keyword.test.ts` — 关键词命中 + 显式时间点
 * - `select-followup-context-defensive.test.ts` — 防御性 + 字幕窗口兜底
 * - `select-followup-context-global-mode.test.ts` — globalContextMode 显式字段
 * - `select-followup-context-qa1.test.ts` — SG-05B QA1 必修 B（全局问题不被误路由）
 *
 * 公共入口（selectFollowupContext / parseExplicitTimestamp / extractKeywordAfterProbe）
 * 在 `@core/followup/select-followup-context` 导出，行为不变。
 */
import { describe, expect, it } from 'vitest';
import {
  extractKeywordAfterProbe,
  parseExplicitTimestamp,
  selectFollowupContext,
} from '@core/followup/select-followup-context';
import { buildPackage } from './_fixtures/select-followup-context-fixtures';

describe('select-followup-context 入口占位', () => {
  it('公共入口仍从 @core/followup/select-followup-context 导出', () => {
    // smoke test：公共 API 可调用
    expect(typeof selectFollowupContext).toBe('function');
    expect(typeof parseExplicitTimestamp).toBe('function');
    expect(typeof extractKeywordAfterProbe).toBe('function');
    const result = selectFollowupContext({
      question: '整体讲什么',
      contextPackage: buildPackage(),
    });
    expect(result.primaryScope).toBe('global');
  });
});
