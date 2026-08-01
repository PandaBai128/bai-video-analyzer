import { describe, expect, it } from 'vitest';
import { buildContextualRetrievalQuestion } from '@core/followup/contextual-retrieval-question';
import type { FollowupConversationMessage } from '@shared/messages';

/**
 * buildContextualRetrievalQuestion 纯函数测试（QA1 测试压缩版）。
 *
 * 覆盖（AGENT_HANDOFF §测试要求 + QA1 必修 3）：
 * - 每类短追问 1 个代表场景（拼接）
 * - 1-2 个反例（完整新问题保持原样）
 * - 防御性：空 question / 空 history
 *
 * 不为每种中文句式建大量正则矩阵（QA1 §测试压缩要求）。
 */

const H = (...items: FollowupConversationMessage[]): readonly FollowupConversationMessage[] => items;

describe('buildContextualRetrievalQuestion (QA1 修正: 解释型 / 指代型加保守长度限制)', () => {
  it('防御性：空 question / 空 history → 原样返回', () => {
    expect(
      buildContextualRetrievalQuestion({ question: '', conversationHistory: H({ role: 'user', content: '上一问' }) }),
    ).toBe('');
    expect(
      buildContextualRetrievalQuestion({ question: '任何问题', conversationHistory: [] }),
    ).toBe('任何问题');
  });

  it('代表场景 1 (纠正型)："我问的是优点" → 拼接上一 user', () => {
    expect(
      buildContextualRetrievalQuestion({
        question: '我问的是优点',
        conversationHistory: H({ role: 'user', content: 'ChatGPT 的优势是什么？' }),
      }),
    ).toBe('ChatGPT 的优势是什么？ 我问的是优点');
  });

  it('QA2 必修 1：长纠正句（> 13 字符）早于长度硬切断，命中后必须拼接上一 user', () => {
    // 完整问句"BM25 算法怎么计算，它和 TF-IDF 有什么区别？"（21 字符）→ 不拼接。
    // 但纠正型"我问的是 ChatGPT 的优点，不是 GLM 的优点"（21 字符）→ 必须拼接。
    const correction = '我问的是 ChatGPT 的优点，不是 GLM 的优点';
    expect(correction.length).toBeGreaterThanOrEqual(13);
    expect(
      buildContextualRetrievalQuestion({
        question: correction,
        conversationHistory: H({ role: 'user', content: '比较 ChatGPT 和 GLM' }),
      }),
    ).toBe('比较 ChatGPT 和 GLM 我问的是 ChatGPT 的优点，不是 GLM 的优点');
  });

  it('代表场景 2 (接续型)："那缺点呢" → 拼接上一 user', () => {
    expect(
      buildContextualRetrievalQuestion({
        question: '那缺点呢',
        conversationHistory: H({ role: 'user', content: 'ChatGPT 的优势是什么？' }),
      }),
    ).toBe('ChatGPT 的优势是什么？ 那缺点呢');
  });

  it('代表场景 3 (解释型)："为什么" (短追问) → 拼接上一 user', () => {
    expect(
      buildContextualRetrievalQuestion({
        question: '为什么',
        conversationHistory: H({ role: 'user', content: 'BM25 比 TF-IDF 好' }),
      }),
    ).toBe('BM25 比 TF-IDF 好 为什么');
  });

  it('代表场景 4 (指代型)："它的优势呢" → 拼接上一 user', () => {
    expect(
      buildContextualRetrievalQuestion({
        question: '它的优势呢',
        conversationHistory: H({ role: 'user', content: '介绍 ChatGPT' }),
      }),
    ).toBe('介绍 ChatGPT 它的优势呢');
  });

  it('QA1 必修 3 反例 1：完整新问题含"怎么 / 它 / 那"不拼接（不被误判为短追问）', () => {
    // 长度 21（> 12）→ 长度阈值直接判定为完整问句
    const independent = 'BM25 算法怎么计算，它和 TF-IDF 有什么区别？';
    expect(independent.length).toBeGreaterThanOrEqual(13);
    expect(
      buildContextualRetrievalQuestion({
        question: independent,
        conversationHistory: H({ role: 'user', content: 'ChatGPT 的优势是什么？' }),
      }),
    ).toBe(independent);
  });

  it('QA1 必修 3 反例 2：纯独立短问句（不含任何依赖上一轮的关键词）保持原样', () => {
    // 不含"为什么 / 怎么 / 那 / 它 / 前者 / 后者 / 我问的是 / 我是说"等任何关键词
    const independent = '排序算法主要分类';
    expect(independent.length).toBeLessThanOrEqual(12);
    expect(
      buildContextualRetrievalQuestion({
        question: independent,
        conversationHistory: H({ role: 'user', content: '介绍 GPT' }),
      }),
    ).toBe(independent);
  });

  it('只拼接最近一条已完成的 user 问题，不使用 assistant 历史', () => {
    expect(
      buildContextualRetrievalQuestion({
        question: '为什么',
        conversationHistory: H(
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '第一答（可能误述）' },
          { role: 'user', content: '第二问' },
        ),
      }),
    ).toBe('第二问 为什么');
  });
});
