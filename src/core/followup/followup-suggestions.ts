/**
 * Round 17 必修 C + Round 18 必修 3：拆分 LLM 回答正文和"可以继续问"小节。
 *
 * 设计要点（Round 18 必修 3 严格化）：
 * 1. 提取规则比 Round 17 更严格：
 *    - **只**从 "可以继续问 / 继续追问 / 追问建议" heading 后的**有 bullet / 编号**的列表里提取。
 *    - 必须是问题（？/ ? 结尾，或含为什么/如何/怎么/是否/能不能/有没有/哪里/什么/哪段 之一）。
 *    - heading 之后的**第一个非空行**必须是有 bullet 的列表项；否则视为"小节存在但
 *      没有可提取的列表"——**不**剥小节本体，**不**误吞正文。
 *    - 遇下一个 markdown heading / 分割线 / 非列表正文段落停止。
 *    - 过滤明显不是问题的行：含"依据/结论/回答/字幕：/附近字幕"、以 [mm:ss] 开头的依据行。
 *    - 最多 3 条；去重（大小写不敏感、首尾标点归一化）。
 *
 * 2. 拆出 `stripSuggestedQuestionsSection` / `splitSuggestedQuestions`，
 *    让 UI 把"可以继续问"列表从正文里剥掉，避免重复显示。
 *
 * 3. **不**做的事（边界）：
 *    - 不调用 LLM / 不调网络。
 *    - 不解析时间点跳转（时间点跳转由 followup-timestamps 处理）。
 *    - 不修改 markdown 原文（strip 只返回新字符串，原文不变）。
 *    - **不**为了凑出建议把没有 bullet 的正文行当成列表项（Round 18 必修 3 关键约束，
 *      之前 LIST_ITEM_PATTERN 把 bullet 设为可选，会把"可以继续问："后整段正文全当建议，
 *      正文 + 按钮重复显示）。
 */

const SUGGESTED_HEADING_PATTERN =
  /(?:\*{0,2}\s*(?:🧭\s*)?(?:你\s*)?可以继续问|🧭\s*可以继续问|\*{0,2}\s*继续追问|追问建议|后续问题|you can ask next|follow[- ]?up questions?|next questions?)\s*\*{0,2}\s*[:：]?\s*\n+/iu;

/**
 * Round 18 必修 3 关键：**必须**有 bullet 或编号才算列表项。
 * 之前 LIST_ITEM_PATTERN 把 bullet 设为可选（`(?:...)?`），导致 "可以继续问："
 * 后跟普通正文时，整段正文被当候选，最后 collectValidSuggestions 过滤噪音
 * 仍然可能误剥。
 *
 * 接受的 bullet / 编号形式：
 *   - `- ` / `* ` / `+ `
 *   - `1.` / `1、` / `1)` 阿拉伯数字
 *   - `**1.**` / `**1、**` 加粗序号（Round 16 兼容）
 */
const BULLET_REQUIRED_PATTERN = /^[ \t]*(?:[-*+]\s+|\d+[.)、]\s+|\*\*\d+\*\*[.)、]?\s*)(.+?)\s*$/u;

/**
 * 下一个 markdown heading：## / ### / ## emoji / **加粗小节**
 */
const NEXT_HEADING_PATTERN = /^[ \t]*(?:#{1,6}\s+|\*\*[^*]+\*\*\s*$|---+\s*$)/u;

/**
 * 过滤依据/调试信息：含这些关键词的行一律不算问题。
 */
const NOISE_LINE_PATTERN =
  /(?:^|\s)(?:依据|结论|回答|字幕[:：]|附近字幕|附近字幕兜底|附近字幕不足|时间线|章节[:：]|引用[:：]|evidence|answer|conclusion|transcript|chapter|timeline|quote)(?:\s|$)|^\s*\[(?:[0-9]+[:：][0-5][0-9](?:[-–][0-9]+[:：][0-5][0-9])?)\]/iu;

/**
 * 疑问词：含其一即视为问题候选。
 */
const QUESTION_WORD_PATTERN =
  /(?:[？?]|[？?]\s*$)|(?:为什么|为何|如何|怎么|怎样|是否|能否|能不能|可不可以|有没有|哪里|哪个|哪段|哪些|什么|哪方面)/u;

const MIN_LENGTH = 4;
const MAX_LENGTH = 80;
const MAX_SUGGESTIONS = 3;

export interface SplitSuggestionResult {
  readonly bodyMarkdown: string;
  readonly suggestions: readonly string[];
}

/**
 * 一站式拆分：把"可以继续问"小节从 markdown 里剥出来，返回正文 + 建议列表。
 *
 * 关键不变量（Round 18 必修 3）：
 * - 找不到 heading → suggestions=[]、bodyMarkdown=原文。
 * - heading 存在但**没有有效列表项**（第一个非空行不是 bullet 列表）
 *   → suggestions=[]、bodyMarkdown=原文。**不**剥小节，避免误删正文。
 * - 找到 heading + 至少 1 个合格候选 → suggestions=[...有效问题]、bodyMarkdown=
 *   heading 之前 + heading 之后剥掉小节区 + 下节内容。
 */
export function splitSuggestedQuestions(markdown: string): SplitSuggestionResult {
  if (!markdown) {
    return { bodyMarkdown: '', suggestions: [] };
  }
  const heading = findSuggestedHeading(markdown);
  if (!heading) {
    return { bodyMarkdown: markdown, suggestions: [] };
  }
  const before = markdown.slice(0, heading.index);
  const after = markdown.slice(heading.index + heading.match.length);
  const { items, stopIndex } = parseSuggestionList(after);
  const suggestions = collectValidSuggestions(items);
  if (suggestions.length === 0) {
    // 关键 Round 18 必修 3：没提取到任何合格建议 → 不剥小节，避免误吞正文。
    return { bodyMarkdown: markdown, suggestions: [] };
  }
  // 拼接正文：heading 之前 + heading 之后但**剥掉**小节区（stopIndex 之后的内容
  // 属于"下一个小节"，剥掉 stopIndex 之前的小节本体）。
  const tail = stopIndex > 0 ? after.slice(stopIndex) : '';
  const bodyMarkdown = stripTrailingBlankLines(before) + tail;
  return { bodyMarkdown, suggestions };
}

/**
 * 仅返回剥除"可以继续问"小节后的 markdown 原文。
 * 用于只需要正文、不需要建议列表的调用方（向后兼容场景）。
 *
 * Round 18 必修 3 严格化：`strip` 在没有提取到合格建议时**不**剥小节，
 * 直接返回原 markdown，避免误吞正文。
 */
export function stripSuggestedQuestionsSection(markdown: string): string {
  return splitSuggestedQuestions(markdown).bodyMarkdown;
}

/**
 * Round 16 的旧导出名。继续保留以避免破坏外部调用方，但内部走新的严格实现。
 */
export function extractSuggestedQuestions(markdown: string): readonly string[] {
  return splitSuggestedQuestions(markdown).suggestions;
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

interface HeadingMatch {
  readonly index: number;
  readonly match: string;
}

function findSuggestedHeading(markdown: string): HeadingMatch | null {
  const match = SUGGESTED_HEADING_PATTERN.exec(markdown);
  if (!match || typeof match.index !== 'number') {
    return null;
  }
  return { index: match.index, match: match[0] };
}

interface ParsedList {
  readonly items: readonly string[];
  readonly stopIndex: number;
}

/**
 * 从 heading 之后的内容里解析候选列表，遇到下一个 heading / 分割线 / 非列表正文段落停止。
 *
 * Round 18 必修 3 关键边界：
 * - heading 之后的第一个**非空**行**必须**是 bullet 列表项（BULLET_REQUIRED_PATTERN 命中）；
 *   否则视为"小节存在但没有可提取列表"，返回 `{ items: [], stopIndex: 0 }`。
 *   上层 splitSuggestedQuestions 据此不剥小节，**不**误吞正文。
 * - 之后的非空行如果不是 bullet 列表项 → 停止。
 * - 遇下一个 markdown heading / 分割线 / **加粗小节** → 停止。
 * - 空行**不**触发停止（多空行 list 是合法的）。
 * - heading 后非空内容**不**是列表项的整段（典型："可以继续问：\n  这段是普通正文，无 bullet"）
 *   → 不会被误提为建议，stopIndex=0 让 strip 整段不剥。
 */
function parseSuggestionList(after: string): ParsedList {
  if (!after) {
    return { items: [], stopIndex: 0 };
  }
  const lines = after.split(/\r?\n/);
  const items: string[] = [];
  let seenFirstContent = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // 空行：继续扫描下一行，但**不**视为"停止"
      continue;
    }
    // 下一个 markdown heading / 分割线 / **加粗小节** → 停止
    if (NEXT_HEADING_PATTERN.test(trimmed)) {
      // 回退：把这一行当 boundary，不计入 items
      break;
    }
    const itemMatch = BULLET_REQUIRED_PATTERN.exec(trimmed);
    if (!itemMatch) {
      // Round 18 必修 3 关键：第一个非空行不是 bullet 列表项 → 不再尝试
      // 兼容无 bullet 列表（避免误吞正文），直接停止。
      // 关键：第一个非空行**不**是 bullet 时，本函数应返回空 items。
      if (!seenFirstContent) {
        return { items: [], stopIndex: 0 };
      }
      break;
    }
    seenFirstContent = true;
    items.push(itemMatch[1] ?? trimmed);
    if (items.length >= MAX_SUGGESTIONS * 3) {
      // 提前截断：避免极端 list 把整篇 markdown 都吞了
      break;
    }
  }
  // 计算 stopIndex：从 after 第一个非空行开始走 line 边界
  const stopIndex = computeStopIndex(after, items);
  return { items, stopIndex };
}

/**
 * 计算"解析停止位置"：从 after 开头扫到 items.length 个列表项之后的第一个空行 / heading。
 * 用于 strip 时把"小节尾巴"的空白/heading 也一并剥掉。
 *
 * 用一个简单的累计字符索引：每行长度 + '\n'。
 */
function computeStopIndex(after: string, items: readonly string[]): number {
  if (items.length === 0) {
    return 0;
  }
  const lines = after.split(/\r?\n/);
  let cursor = 0;
  let collected = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && BULLET_REQUIRED_PATTERN.test(trimmed) && !NEXT_HEADING_PATTERN.test(trimmed)) {
      collected += 1;
    }
    cursor += line.length + 1;
    if (collected >= items.length) {
      // 找到了 items.length 个候选后，跳过该行的尾部 + 紧跟的空行
      return cursor;
    }
  }
  return after.length;
}

function collectValidSuggestions(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of items) {
    // 噪音行（含"依据/字幕：/[mm:ss] 时间点开头"等）直接跳过
    if (NOISE_LINE_PATTERN.test(raw)) {
      continue;
    }
    const cleaned = cleanSuggestionText(raw);
    if (!cleaned) {
      continue;
    }
    if (!isLikelyQuestion(cleaned)) {
      continue;
    }
    const key = dedupeKey(cleaned);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_SUGGESTIONS) {
      break;
    }
  }
  return result;
}

/**
 * 清洗：去首尾成对引号 / 反引号 / 中文引号；去尾部多余标点；
 * 去掉 markdown 加粗/反引号残留；去掉开头的 emoji 视觉锚点。
 * 太短（< MIN_LENGTH）返回空串；太长（> MAX_LENGTH）截断加省略号。
 */
function cleanSuggestionText(text: string): string {
  let result = text.replace(/^[\s"'`「『]+|[\s"'`」』,。.;；]+$/gu, '').trim();
  // markdown 强调痕迹 `**` `__` 头尾剥掉
  result = result.replace(/^(\*\*|__)+|(\*\*|__)+$/gu, '').trim();
  // 去掉开头的 emoji 视觉锚点（🧭 / 💡 / ❓ 之类）
  result = result.replace(/^[\p{Emoji_Presentation}\s]+/u, '').trim();
  if (result.length < MIN_LENGTH) {
    return '';
  }
  if (result.length > MAX_LENGTH) {
    result = `${result.slice(0, MAX_LENGTH - 1)}…`;
  }
  return result;
}

/**
 * 判断一条文本是否像问题：含疑问词 / ？/? / 是/吗 之类。
 */
function isLikelyQuestion(text: string): boolean {
  return QUESTION_WORD_PATTERN.test(text);
}

/**
 * 去重 key：trim + 去尾部 ？/ ? + 折叠空白 + lowercase。
 */
function dedupeKey(text: string): string {
  return text.replace(/[？?]+$/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function stripTrailingBlankLines(text: string): string {
  return text.replace(/[\r\n]+$/u, '');
}
