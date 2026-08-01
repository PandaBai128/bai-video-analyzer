import type { FollowupConversationMessage } from '@shared/messages';

/**
 * 跨边界类型：sidepanel / core / background 共用。
 * 实际定义在 `@shared/messages`，本文件只 re-export 方便测试和业务层引用。
 */
export type { FollowupConversationMessage };

/**
 * 最多携带最近 3 个完整问答轮次。
 *
 * "完整"= user + assistant 都成功提交 / 完成；任何半对的轮次直接丢弃，
 * 避免给模型"上一句没答完"这种半截上下文。
 */
export const MAX_CONVERSATION_TURNS = 3;

/**
 * 总字符数**硬上限**（含 user + assistant 内容，按字符数计）。
 *
 * AGENT_HANDOFF QA1 必修 1：硬上限，不允许"至少保留最新一轮"放行超大单轮。
 * 即最新一轮自身字符数 > MAX_CONVERSATION_CHARS，整轮丢弃，返回空历史。
 * 不截断单条消息，不发送半轮。
 */
export const MAX_CONVERSATION_CHARS = 6_000;

/**
 * 输入对话历史项（按"完整问答对"切分后的最小单元）。
 *
 * 故意只暴露 role / content —— UI 用的 id / createdAt / streaming / error
 * 都是 sidepanel 本地状态，不应跨 Port 传到 background。
 */
export interface ConversationTurn {
  readonly user: FollowupConversationMessage;
  readonly assistant: FollowupConversationMessage;
}

/**
 * 把 followup.messages 风格的"原始"消息流切成完整问答对。
 *
 * 纯函数；过滤 streaming / error / 空 assistant；孤儿 user（没配对 assistant）
 * 被下一个 user 覆盖并丢弃；孤儿 assistant 直接丢弃。
 *
 * 输入用最小 `RawConversationMessage` 形状，**不**依赖 `@extension/sidepanel/followup-state`，
 * 这样 background / core / sidepanel 三端可以共用。
 */
export interface RawConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly streaming?: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * 从 sidepanel 的 `FollowupState.messages` 提取随 Port 一起发送的对话历史。
 *
 * 关键不变量（AGENT_HANDOFF §历史限额 + QA1 必修 1）：
 * - **不**包含 streaming / error / 空 content 的 assistant 消息。
 * - **不**包含半个问答对。
 * - **不**修改入参，返回新数组。
 * - **硬上限**：历史总字符数（user.content + assistant.content 之和）任何情况下
 *   都不得超过 `MAX_CONVERSATION_CHARS`。
 * - **不**截断单条消息、不发送半轮。
 * - 最新轮自身字符数已超 MAX_CONVERSATION_CHARS → 整轮丢弃，返回 `[]`。
 *   （**不**再保留"至少最新一轮"作为兜底，避免破坏硬上限。）
 *
 * 限额顺序：
 * 1. 按 user→assistant 成对切分（保证完整问答对）。
 * 2. 取最近 3 轮（`MAX_CONVERSATION_TURNS`）。
 * 3. 按 `MAX_CONVERSATION_CHARS` 硬上限从最新往旧累加；任一候选轮超预算 → 停止。
 * 4. 累计字符数（含本轮）> MAX_CONVERSATION_CHARS → 丢弃本轮（更旧）和更早所有轮次。
 */
export function pickConversationHistory(input: {
  readonly messages: readonly RawConversationMessage[];
}): readonly FollowupConversationMessage[] {
  const { messages } = input;

  // 1) 切完整轮次：streaming / error / 空 assistant 过滤；按 user→assistant 单次遍历配对。
  const turns: ConversationTurn[] = [];
  let pendingUser: RawConversationMessage | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      // 孤儿 user 被覆盖（下一个 user 直接顶替）
      pendingUser = m;
    } else if (m.role === 'assistant') {
      if (m.streaming) continue;
      if (m.error) continue;
      const trimmed = m.content?.trim?.() ?? '';
      // AGENT_HANDOFF QA2 必修 2：user 和 assistant 都必须 trim 后非空才视为完整轮。
      // 纯空白 user（"   "）不能与后续 assistant 配成一轮——避免给模型"空问题 → 实质回答"
      // 这种半截上下文。content 原样保留，**不**自动 trim 输出。
      const pendingContent = pendingUser?.content?.trim?.() ?? '';
      if (pendingUser && pendingContent.length > 0 && trimmed.length > 0) {
        turns.push({
          user: { role: 'user', content: pendingUser.content },
          assistant: { role: 'assistant', content: m.content },
        });
        pendingUser = null;
      }
      // 孤儿 assistant 直接丢弃
    }
  }

  // 2) 取最近 MAX_CONVERSATION_TURNS 轮。
  const recent = turns.slice(-MAX_CONVERSATION_TURNS);

  // 3) 硬上限：从最新轮往旧累加字符数；超 MAX_CONVERSATION_CHARS 立即停止。
  //    任一候选轮自身就超 MAX_CONVERSATION_CHARS（包含单轮成本 > 预算）→ 整轮丢弃。
  //    最终结果可能为 []（最新轮自身超预算时）。
  const keptTurns: ConversationTurn[] = [];
  let chars = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (!turn) continue;
    const cost = turn.user.content.length + turn.assistant.content.length;
    // 硬上限：单轮成本 > 预算 → 整轮丢弃（保持"不截断、不发半轮"）。
    if (cost > MAX_CONVERSATION_CHARS) {
      break;
    }
    if (chars + cost > MAX_CONVERSATION_CHARS && keptTurns.length > 0) {
      // 已经保留至少最新一轮，旧轮会让总预算超 → 停止。
      break;
    }
    keptTurns.unshift(turn);
    chars += cost;
  }

  // 4) 展开成最终消息数组（按时间正序）。
  const result: FollowupConversationMessage[] = [];
  for (const turn of keptTurns) {
    result.push(turn.user);
    result.push(turn.assistant);
  }
  return result;
}
