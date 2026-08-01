import type { FollowupConversationMessage } from '@shared/messages';

/**
 * AGENT_HANDOFF §检索问题补全 纯函数。
 *
 * 用户短追问（如"我问的是优点"、"那缺点呢"、"为什么"）经常依赖上一轮
 * 主题；selectFollowupContext 当前只看本次问题，会按"优点"或"为什么"这种
 * 弱关键词重新匹配字幕，可能切错主题。
 *
 * 该函数返回给 selectFollowupContext 的检索用问题；对用户可见的当前问题
 * 不做任何改写 —— buildFollowupChatPrompt 的 `question` 仍是用户原问题。
 *
 * 关键不变量（AGENT_HANDOFF QA1 必修 3 + QA2 必修 1 收口）：
 * - **只**对"明显依赖上一轮"的短追问拼接上一条 user 问题（保守确定规则）。
 * - **不**依赖宽匹配 `includes`：解释型 / 接续型 / 指代型分支都必须显式
 *   短问句模式 + 长度上限，避免"BM25 算法怎么计算，它和 TF-IDF 有什么区别？"
 *   这种完整独立新问题被错误拼接。
 * - 完整 / 独立的新问题（含 `？` 或长度超过对应分支上限）保持原样。
 * - 纠正型（"我问的是 X" / "我是说 X"）允许任意长度，**早于**完整问句硬切断——
 *   避免"我问的是 ChatGPT 的优点，不是 GLM 的优点"（30+ 字符）被 13 字符阈值
 *   错误判定为独立问句。
 * - 只使用最近一条**已完成** user 问题（不含 streaming / 空内容）。
 * - **不**使用 assistant 回答做字幕关键词检索（assistant 内容可能误述）。
 * - **不**调用额外 LLM 改写，本轮是确定性规则。
 */

// 解释型短追问最大字符数；超过该长度即视为完整问句，**不**触发拼接。
const EXPLAIN_MAX_CHARS = 12;
// 接续型短追问（"那 X 呢"）最大字符数。
const CONTINUATION_MAX_CHARS = 8;
// 指代型短追问（"它 X 呢 / 这个 X 是什么"）最大字符数。
const PRONOUN_MAX_CHARS = 10;
// 完整问句的硬阈值：超过该字符数一律视为完整独立问题，不触发任何拼接。
const INDEPENDENT_QUESTION_MIN_CHARS = 13;

// 纠正型：以这些词开头。允许任意长度（即使后续很长也仍然是纠正）。
// 例子："我问的是优点" / "我是说维琳娜一命"。
const CORRECTION_PREFIX_PATTERNS: readonly RegExp[] = [
  /^(我问的是|我是说|我说的是|我问的就是)\s*/,
];

// 接续型：以"那 / 那么 / 然后 / 那个"开头 + 短词 + 可选"呢" / 问号；总长 ≤ CONTINUATION_MAX_CHARS。
// 例子："那缺点呢" / "那个呢" / "那么结论呢"。
const CONTINUATION_PATTERN = new RegExp(
  `^(?:那|那么|然后|那你说|那这个|那个)(?:[\\u4e00-\\u9fa5\\w]{0,4}呢)?[？?]?$`,
);
// 注意：必须用字符类字符集显式包含中英文，避免 'w' 误命中下划线等。
const CONTINUATION_TOTAL_MAX_CHARS = CONTINUATION_MAX_CHARS;
// 注：CONTINUATION_PATTERN 已限制可选短词 ≤ 4 字符，加上前缀 ≤ 4 字符 ≈ ≤ 8 字符。

// 解释型：仅以解释关键词开头；总长 ≤ EXPLAIN_MAX_CHARS。
// 例子："为什么" / "怎么算" / "具体呢" / "解释一下"。
// 不接受"BM25 算法怎么计算，它和 TF-IDF 有什么区别？" → 总长 20+ → 不拼接。
const EXPLAIN_START_PATTERN = new RegExp(
  `^(?:为什么|为何|怎么|怎么算|怎么说|怎么理解|具体呢|详细说说|解释一下|再解释|详细一点|展开讲|为啥)(?:[\\u4e00-\\u9fa5\\w]{0,2})?[？?]?$`,
);

// 指代型：以"它 / 这个 / 那个 / 前者 / 后者"开头 + 短词（≤ 5 字符）。
// 例子："它的优势呢" / "这个是啥" / "那个呢" / "它的优缺点"。
// 不用 `includes` 命中"这 / 那"单字，避免"BM25 算法怎么计算，它和 TF-IDF 有什么区别？"
// 这种含"它"的完整独立问句被误判。
// 总长 ≤ 10 = 前缀 ≤ 4 字符 + 短词 ≤ 5 字符 + 可选问号 1 字符。
const PRONOUN_START_PATTERN = new RegExp(
  `^(?:它|这个|那个|前者|后者)[\\u4e00-\\u9fa5\\w]{0,5}[？?]?$`,
);

export interface BuildContextualRetrievalQuestionInput {
  readonly question: string;
  readonly conversationHistory: readonly FollowupConversationMessage[];
}

/**
 * 返回给 selectFollowupContext 的检索用问题。
 *
 * - 用户可见的当前问题保持原样 — 不改写 UI 和最终提问文本。
 * - 当匹配到"明显依赖上一轮"的短追问 + 上一条已完成 user 问题存在时，
 *   返回 `${lastUserQuestion} ${question}`（拼接检索输入）。
 * - 否则返回 `question` 原样。
 *
 * 拼接用空格分隔，避免中英连字。
 */
export function buildContextualRetrievalQuestion(
  input: BuildContextualRetrievalQuestionInput,
): string {
  const { question, conversationHistory } = input;
  const trimmed = question.trim();
  if (!trimmed) return trimmed;

  // 上一条已完成的 user 问题：history 里最近的 role === 'user' 且 content 非空。
  const lastUserMessage = findLastUserQuestion(conversationHistory);
  if (!lastUserMessage) {
    return trimmed;
  }

  // 1) 纠正型优先（AGENT_HANDOFF QA2 必修 1）：纠正型允许任意长度，
  //    必须**早于**完整问句硬切断。例如"我问的是 ChatGPT 的优点，不是 GLM 的优点"
  //    是 30+ 字符的明确纠正，**不**能被 13 字符阈值直接判定为独立问句。
  if (hasExplicitCorrectionPrefix(trimmed)) {
    return `${lastUserMessage} ${trimmed}`;
  }

  // 2) 完整问句防御：长度 ≥ INDEPENDENT_QUESTION_MIN_CHARS 的问题视为独立完整，
  //    强制返回原样。即"BM25 算法怎么计算，它和 TF-IDF 有什么区别？"（≥ 13 字符）
  //    即使含"怎么"开头也不会拼接。
  if (trimmed.length >= INDEPENDENT_QUESTION_MIN_CHARS) {
    return trimmed;
  }

  // 3) 短追问模式（解释型 / 接续型 / 指代型）：必须在长度硬切断**之后**再判断，
  //    否则这些模式的"短"属性已经没有意义（已经过阈值了）。
  if (matchesShortFollowupPattern(trimmed)) {
    return `${lastUserMessage} ${trimmed}`;
  }
  return trimmed;
}

/**
 * 在 history 里从后向前找最近一条已完成的 user 问题。
 * 不含 streaming / 空 content（这些状态在 pickConversationHistory 里已被过滤；
 * 这里再做一次防御性检查，不依赖上游）。
 */
function findLastUserQuestion(
  history: readonly FollowupConversationMessage[],
): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (!m) continue;
    if (m.role !== 'user') continue;
    const content = m.content.trim();
    if (!content) continue;
    return content;
  }
  return null;
}

/**
 * 判定当前问题是否包含"明确纠正型前缀"。
 *
 * 纠正型（如"我问的是 ChatGPT 的优点，不是 GLM 的优点"）即便后续很长
 * 也仍然是纠正——不能被长度硬切断截住。AGENT_HANDOFF QA2 必修 1 要求
 * 此类判断**早于** `>= 13` 字符的完整问句硬切断。
 */
function hasExplicitCorrectionPrefix(question: string): boolean {
  for (const pattern of CORRECTION_PREFIX_PATTERNS) {
    if (pattern.test(question)) return true;
  }
  return false;
}

/**
 * 短追问模式（解释型 / 接续型 / 指代型）。
 *
 * 三类都强制短问句 + 长度上限，避免"BM25 算法怎么计算，它和 TF-IDF 有
 * 什么区别？"这种含多关键词的完整独立问句被错误拼接。
 */
function matchesShortFollowupPattern(question: string): boolean {
  const trimmed = question.trim();

  // 模式 2：接续型（"那优点呢"）。CONTINUATION_PATTERN 已限制总长 ≤ 8 字符。
  if (trimmed.length <= CONTINUATION_TOTAL_MAX_CHARS && CONTINUATION_PATTERN.test(trimmed)) {
    return true;
  }

  // 模式 3：解释型（"为什么" / "怎么算"）。必须以解释关键词开头 + 总长 ≤ 12 字符。
  if (trimmed.length <= EXPLAIN_MAX_CHARS && EXPLAIN_START_PATTERN.test(trimmed)) {
    return true;
  }

  // 模式 4：指代型（"它的优势呢"）。必须以指代词开头 + 总长 ≤ 10 字符。
  if (trimmed.length <= PRONOUN_MAX_CHARS && PRONOUN_START_PATTERN.test(trimmed)) {
    return true;
  }

  return false;
}
