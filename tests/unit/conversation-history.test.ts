import { describe, expect, it } from 'vitest';
import { pickConversationHistory } from '@core/followup/conversation-history';
import type { FollowupMessage } from '@extension/sidepanel/followup-state';

/**
 * pickConversationHistory 纯函数测试（QA1 测试压缩版 + QA2 必修 2 收口）。
 *
 * 覆盖（AGENT_HANDOFF §测试要求 + QA1 必修 1 硬上限 + QA2 必修 2 空白 user）：
 * - 完整轮次切分（user→assistant 必须成对；user / assistant 都要 trim 后非空）。
 * - 排除 streaming / error / 空 assistant / **空白 user**（QA2 必修 2）。
 * - 3 轮 / 6000 字硬上限（含"最新轮自身超预算整轮丢弃"）。
 * - 最新优先；不修改入参。
 *
 * 用 4 个测例覆盖关键风险，不堆 1:1 文案矩阵。
 */

function makeUser(id: string, content: string, streaming = false): FollowupMessage {
  return { id, role: 'user', content, createdAt: 0, ...(streaming ? { streaming: true } : {}) };
}
function makeAssistant(
  id: string,
  content: string,
  extras: Partial<FollowupMessage> = {},
): FollowupMessage {
  return { id, role: 'assistant', content, createdAt: 0, ...extras };
}

describe('pickConversationHistory', () => {
  it('完整轮次 + 异常排除：空 / 半对 / streaming / error / 空 content / 空白 user 都不进 history', () => {
    // 包含各种异常情况：只有完整且 user + assistant 都 trim 后非空的最后一轮能进 history
    const messages = [
      // 半对：assistant streaming
      makeUser('u1', '第一问'),
      makeAssistant('a1', '半截', { streaming: true }), // streaming 排除
      // 完整但中间：error assistant
      makeUser('u2', '第二问'),
      makeAssistant('a2', '', { error: { code: 'STREAM_TIMEOUT', message: '超时' } }), // error + 空排除
      // QA2 必修 2：纯空白 user（"   "）不能与后续 assistant 配成一轮
      makeUser('u-blank', '   '),
      makeAssistant('a-blank', '这条回答不算数'), // 整轮被拒
      // 唯一完整对（user trim 后非空 + assistant trim 后非空）
      makeUser('u3', '第三问'),
      makeAssistant('a3', '完整回答'),
    ];
    expect(pickConversationHistory({ messages })).toEqual([
      { role: 'user', content: '第三问' },
      { role: 'assistant', content: '完整回答' },
    ]);
  });

  it('3 轮上限：5 轮对话只保留最近 3 轮', () => {
    const messages: FollowupMessage[] = [];
    for (let i = 1; i <= 5; i += 1) {
      messages.push(makeUser(`u${i}`, `第 ${i} 问`));
      messages.push(makeAssistant(`a${i}`, `第 ${i} 答`));
    }
    const history = pickConversationHistory({ messages });
    expect(history).toHaveLength(6); // 3 轮 × 2 条
    expect(history.map((m) => m.content)).toEqual(['第 3 问', '第 3 答', '第 4 问', '第 4 答', '第 5 问', '第 5 答']);
  });

  it('6000 字硬上限：总字符超预算时按整轮丢弃更旧，最新轮保留', () => {
    // 三轮各 4000 字符（user 2000 + assistant 2000 = 4000/轮）。
    // 总 12000 > 6000：
    // - 最新轮 4000 < 6000（单轮不超硬上限）→ 保留
    // - 加中间轮（4000 + 4000 = 8000 > 6000 且已有最新轮）→ 整轮丢弃，停止
    const half = 'x'.repeat(2_000);
    const messages = [
      makeUser('u1', half),
      makeAssistant('a1', half),
      makeUser('u2', half),
      makeAssistant('a2', half),
      makeUser('u3', half),
      makeAssistant('a3', half),
    ];
    expect(pickConversationHistory({ messages })).toEqual([
      { role: 'user', content: half },
      { role: 'assistant', content: half },
    ]);
  });

  it('QA1 必修 1：最新一轮自身字符数已超 6000 → 整轮丢弃，返回空（不保留"至少最新一轮"兜底）', () => {
    // 单轮 7000 字符 > MAX_CONVERSATION_CHARS 硬上限
    const huge = 'x'.repeat(7_000);
    const messages = [
      // 旧轮小
      makeUser('u-old', 'short'),
      makeAssistant('a-old', 'short'),
      // 最新轮自身超预算
      makeUser('u-new', huge),
      makeAssistant('a-new', huge),
    ];
    // 关键不变量：硬上限下"至少保留最新一轮"是 bug；超大单轮应整轮丢弃返回空
    expect(pickConversationHistory({ messages })).toEqual([]);
  });
});
