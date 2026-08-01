/**
 * Round 17 必修 A：追问意图识别（"用户是否在问当前片段"）。
 *
 * 设计目标：
 * - 纯函数，无副作用，便于单测。
 * - 中文触发词优先（产品默认中文），少量英文兜底。
 * - **单词边界**严格匹配，避免误伤（"这里"作为完整词才匹配，不会匹配"生活在这里"）。
 * - 不区分大小写；标点不影响匹配。
 * - 命中就返回 true；否则 false。
 *
 * Round 21 必修 1：把 current intent 拆成 **explicit**（明确指向当前播放）
 * 和 **ambiguous**（裸"这段/这里/此处/刚才"等双义词，可能指当前也可能指选中片段）
 * 两类。`detectCurrentSegmentIntent()` 保留兼容导出，内部 = explicit || ambiguous，
 * 让 Round 17/18/19/20 已有调用方不需要修改。
 *
 * 拆分理由（Round 21 关键修复）：
 * - explicit current（如"现在讲的是什么 / 当前片段是什么"）是**明确的**当前播放意图，
 *   即使用户在时间线选过节点（selectedTimestamp 非空），也应该围绕当前播放位置回答。
 * - ambiguous current（如"这段讲什么 / 这里是什么意思 / 刚才点的"）语义模糊——
 *   既可能指"当前播放位置"，也可能指"用户点选的时间线节点"。
 *   如果用户写了**明确**的 selected intent 触发词（"我选的 / 选中的 / 这个节点"），
 *   ambiguous current **不应该**把用户抢到 current_segment；此时应该让 selected
 *   intent 路由优先 → selected_segment。
 *
 * 命中范围（中文 / 英文）：
 *   explicit current（明确指向当前播放）：
 *     现在讲 / 目前讲 / 当前讲 / 当前片段 / 当前播放 / 当前这部分 / 当前这段 / 当前说的
 *     right now / current part / current segment
 *   ambiguous current（双义，可能指当前也可能指选中）：
 *     这段 / 这一段 / 这个片段 / 这部分 / 这里 / 这儿 / 此处 / 刚才 / 刚刚
 *     this part / around here / right here
 *
 * 设计边界：
 * - 不依赖分词器；中文按字面 substring + 单词边界启发式。
 * - 不抽取数字（即便问题里写了 mm:ss，selectFollowupContext 自己的
 *   parseExplicitTimestamp 已经优先覆盖）。
 * - 不支持同义词如"眼下 / 当前 / 此刻"等（避免误伤；后续有需要再加）。
 */

const EXPLICIT_CURRENT_SEGMENT_TRIGGERS_ZH: readonly string[] = [
  '现在讲',
  '目前讲',
  '当前讲',
  '当前片段',
  '当前播放',
  '当前这部分',
  '当前这段',
  '当前说的',
];

const EXPLICIT_CURRENT_SEGMENT_TRIGGERS_EN: readonly string[] = [
  'right now',
  'current part',
  'current segment',
];

const AMBIGUOUS_CURRENT_SEGMENT_TRIGGERS_ZH: readonly string[] = [
  '这一段',
  '这个片段',
  '这部分',
  '这段',
  '这里',
  '这儿',
  '此处',
  '刚才',
  '刚刚',
];

const AMBIGUOUS_CURRENT_SEGMENT_TRIGGERS_EN: readonly string[] = [
  'this part',
  'around here',
  'right here',
];

/**
 * 判断 question 是否命中**明确指向当前播放**的 intent 触发词。
 *
 * 命中范围（中文）：现在讲 / 目前讲 / 当前讲 / 当前片段 / 当前播放 / 当前这部分 /
 *   当前这段 / 当前说的
 * 命中范围（英文）：right now / current part / current segment
 *
 * 与 detectAmbiguousCurrentSegmentIntent 的区别：
 * - explicit current 是**无歧义**的当前播放意图，即使 selectedTimestamp 有效
 *   也应该走 current_segment（"现在讲的是什么？" 即使用户选过节点，意图仍是当前播放）。
 * - ambiguous current 是**有歧义**的（"这段讲什么 / 这里是什么意思 / 刚才点的"），
 *   需要让路由结合 selected intent 触发词判断是否要走 selected_segment。
 *
 * 返回 boolean。
 */
export function detectExplicitCurrentSegmentIntent(question: string): boolean {
  if (!question || typeof question !== 'string') {
    return false;
  }
  const raw = question.trim();
  if (!raw) {
    return false;
  }
  const lowered = raw.toLowerCase();

  for (const trigger of EXPLICIT_CURRENT_SEGMENT_TRIGGERS_EN) {
    if (containsWord(lowered, trigger)) {
      return true;
    }
  }

  for (const trigger of EXPLICIT_CURRENT_SEGMENT_TRIGGERS_ZH) {
    if (containsSubstringWithWordBoundary(raw, trigger)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断 question 是否命中**双义**的 current intent 触发词（"这段/这里/此处/刚才"）。
 *
 * 命中范围（中文）：这段 / 这一段 / 这个片段 / 这部分 / 这里 / 这儿 / 此处 / 刚才 / 刚刚
 * 命中范围（英文）：this part / around here / right here
 *
 * 双义性：用户写"这段讲什么"既可能指"当前播放位置附近"，也可能指"我刚才点选的时间线节点"。
 * selectFollowupContext 在路由时只让 ambiguous current 接管——**当且仅当**
 * 用户没有命中 selected intent（detectSelectedSegmentIntent）时。如果同时命中 selected intent，
 * 应让 selected intent 优先 → selected_segment。
 *
 * 返回 boolean。
 */
export function detectAmbiguousCurrentSegmentIntent(question: string): boolean {
  if (!question || typeof question !== 'string') {
    return false;
  }
  const raw = question.trim();
  if (!raw) {
    return false;
  }
  const lowered = raw.toLowerCase();

  for (const trigger of AMBIGUOUS_CURRENT_SEGMENT_TRIGGERS_EN) {
    if (containsWord(lowered, trigger)) {
      return true;
    }
  }

  for (const trigger of AMBIGUOUS_CURRENT_SEGMENT_TRIGGERS_ZH) {
    if (containsSubstringWithWordBoundary(raw, trigger)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断 question 是否在问"当前播放位置附近讲了什么"。
 *
 * Round 21 必修 1：保留 Round 17 起的全集触发词，**内部** = explicit || ambiguous。
 * 这是兼容导出——Round 17/18/19/20 已有调用方（select-followup-context.ts）继续用
 * detectCurrentSegmentIntent() 走"current intent 命中"的判定逻辑，新代码应该按需
 * 选择 detectExplicitCurrentSegmentIntent() 或 detectAmbiguousCurrentSegmentIntent()。
 *
 * 实现策略：
 * - 把 question 转小写、按 ASCII 空白切词；
 * - 中文触发词按"出现在 question 里且前后是非字母数字（或字符串边界）"判定；
 * - 英文触发词按"作为完整单词出现"判定。
 *
 * 返回 boolean。
 */
export function detectCurrentSegmentIntent(question: string): boolean {
  return (
    detectExplicitCurrentSegmentIntent(question) ||
    detectAmbiguousCurrentSegmentIntent(question)
  );
}

/**
 * 判断 trigger 作为完整 ASCII 单词（前后为非字母数字）出现在 haystack 中。
 * 例：containsWord('this part of the video', 'this part') → true
 *      containsWord('somewhere part', 'this part') → false
 *      containsWord('thiss part', 'this part') → false（前缀也算"不是完整词"，但这里匹配到的应该是 'thiss' 之前没有空格所以不能 match）
 */
function containsWord(haystack: string, needle: string): boolean {
  if (!haystack || !needle) {
    return false;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(haystack);
}

/**
 * 中文触发词按"前后是中文/标点空白边界"判定。中文没有 ASCII 单词边界概念，
 * 这里用启发式：trigger 之前或之后是"非汉字字母数字"（含 ASCII 字母数字）
 * 才视为单词边界——主要是为了避免"这里"误伤"这里的"（"的"是汉字算边界 OK）
 * 以及"生活在这里"这种 phrase 里"这里"前面是汉字仍视为完整词 OK。
 *
 * 简化策略：先 substring 判断，再用左右 1 个 char 是不是字母数字/汉字来过滤：
 * - trigger 前是汉字 → 视为完整词（中文里"这段"在"讲这段"里是完整词）
 * - trigger 前是空白 / 标点 / 字符串开头 → 视为完整词
 * - trigger 前是 ASCII 字母数字 → 视为不是完整词（不匹配）
 *
 * trigger 后类似。
 *
 * 注意：中文里"这段"出现在"讲这段"和"讲这段话"中都算完整词。"生活在这里"里
 * "这里"前面是汉字、后面是字符串边界——也算完整词。这个宽松策略在中文里是合理的
 * （中文不空格分词）。如果出现误伤，后续可以再加"必须在 question 末尾或紧跟
 * 助词 '的/了/呢/啊'"之类约束。
 */
function containsSubstringWithWordBoundary(haystack: string, needle: string): boolean {
  if (!haystack || !needle) {
    return false;
  }
  const idx = haystack.indexOf(needle);
  if (idx < 0) {
    return false;
  }
  // 检查前一个字符（如果存在）是否是 ASCII 字母数字（视为"粘连"，不算完整词）
  if (idx > 0) {
    const prev = haystack.charAt(idx - 1);
    if (isAsciiAlphanumeric(prev)) {
      // 滑动找下一个出现位置继续判断
      return containsSubstringWithWordBoundary(haystack.slice(idx + needle.length), needle);
    }
  }
  const afterIdx = idx + needle.length;
  if (afterIdx < haystack.length) {
    const next = haystack.charAt(afterIdx);
    if (isAsciiAlphanumeric(next)) {
      return containsSubstringWithWordBoundary(haystack.slice(afterIdx), needle);
    }
  }
  return true;
}

function isAsciiAlphanumeric(ch: string): boolean {
  if (!ch) {
    return false;
  }
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// ---------------------------------------------------------------------------
// Round 19 必修 2 + Round 20 收敛：选中片段意图识别
// ---------------------------------------------------------------------------

/**
 * Round 19 必修 2 + Round 20 收敛：判断 question 是否在问
 * "用户点选的时间线节点 / 选中的这段"。
 *
 * 设计目标：
 * - 纯函数，无副作用，便于单测。
 * - 中文触发词优先（产品默认中文），少量英文兜底。
 * - **单词边界**严格匹配，避免误伤（沿用 detectCurrentSegmentIntent 实现）。
 * - **避免误伤全局问题**：先排除 global intent 触发词——这些全局问法即使包含
 *   "这段"等词也不应该被识别为"选中片段意图"。
 * - 不区分大小写；标点不影响匹配。
 * - 命中就返回 true；否则 false。
 *
 * 命中范围（中文，**只**保留明确指向"用户点选"的词，**不含**双义词）：
 *   选中的 / 我选的 / 刚才点的 / 这个节点 / 这个时间点
 *
 *   移除的**双义**触发词（语义模糊，"这段/这里/此处/这个片段"既可能指
 *   "用户点过的时间线节点"，也可能指"当前播放位置的片段"——不做猜）：
 *     这段 / 这一段 / 这里 / 此处 / 这个片段
 *
 *   未来要支持"选中节点追问"，**应**加显式 UI（按钮 / 高亮复盘句），而
 *   不是靠"这段"猜。这样可以避免和 current intent 路由冲突。
 *
 * 命中范围（英文，同步收敛，**不含**双义词）：
 *   selected segment / picked segment / this point / this node
 *
 *   移除的**双义**英文触发词：
 *     this segment（同样偏当前语境）
 *
 * 全局问题白名单（**先**排除——命中直接 false，避免误判）：
 *   这个视频主要讲什么 / 哪些地方值得看 / 整体 / 总结 /
 *   学习笔记 / 重点回看 / 主要表达
 *
 * 设计边界：
 * - 不依赖分词器；中文按字面 substring + 单词边界启发式。
 * - 不抽取数字（即便问题里写了 mm:ss，selectFollowupContext 自己的
 *   parseExplicitTimestamp 已经优先覆盖）。
 */
const SELECTED_SEGMENT_TRIGGERS_ZH: readonly string[] = [
  '选中的',
  '我选的',
  '刚才点的',
  '这个节点',
  '这个时间点',
];

const SELECTED_SEGMENT_TRIGGERS_EN: readonly string[] = [
  'selected segment',
  'picked segment',
  'this point',
  'this node',
];

/**
 * 全局问题白名单。命中 → 直接 false，避免"这段"等词误伤。
 *
 * 顺序：把**更具体的复合触发词**放最前面（"这个视频主要讲什么"先于"主要讲"、
 * "这个视频主要表达什么"先于"主要表达"），确保 JS indexOf 命中完整短语。
 */
const GLOBAL_INTENT_OVERRIDES_ZH: readonly string[] = [
  '这个视频主要讲什么',
  '这个视频主要表达什么',
  '哪些地方值得重点回看',
  '哪些地方值得看',
  '整理成学习笔记',
  '学习笔记',
  '重点回看',
  '主要表达',
  '整体讲什么',
  '整体总结',
  '总结一下',
  '帮我总结',
];

const GLOBAL_INTENT_OVERRIDES_EN: readonly string[] = [
  'summarize',
  'summary',
  'main point',
  'main idea',
  'whole video',
  'overall',
];

/**
 * 判断 question 是否在问"用户点选的时间线节点 / 选中片段"。
 *
 * 实现策略（Round 19 必修 2）：
 * 1. 先判断 global intent 白名单——命中 → false（这些就是全局问题，
 *    即使包含"这段"等词也不应该走 selected_segment 劫持全局回答）。
 * 2. 再判断 selected-segment trigger——命中 → true。
 *
 * 返回 boolean。
 */
export function detectSelectedSegmentIntent(question: string): boolean {
  if (!question || typeof question !== 'string') {
    return false;
  }
  const raw = question.trim();
  if (!raw) {
    return false;
  }
  const lowered = raw.toLowerCase();

  // 1. 全局问题白名单：命中直接 false，避免误伤。
  for (const trigger of GLOBAL_INTENT_OVERRIDES_EN) {
    if (containsWord(lowered, trigger)) {
      return false;
    }
  }
  for (const trigger of GLOBAL_INTENT_OVERRIDES_ZH) {
    if (containsSubstringWithWordBoundary(raw, trigger)) {
      return false;
    }
  }

  // 2. selected-segment trigger：命中 → true。
  for (const trigger of SELECTED_SEGMENT_TRIGGERS_EN) {
    if (containsWord(lowered, trigger)) {
      return true;
    }
  }
  for (const trigger of SELECTED_SEGMENT_TRIGGERS_ZH) {
    if (containsSubstringWithWordBoundary(raw, trigger)) {
      return true;
    }
  }
  return false;
}

/**
 * 全局 / 概览意图判定（SG-05B QA1 修复要求 B）。
 *
 * 命中 `GLOBAL_INTENT_OVERRIDES_ZH/EN` 白名单 → 视为全局问题：
 * 路由层应在普通事实检索（question_match）之前先走 global，**避免**问句骨架
 * 词（如"这个视频主要讲什么"中的"这个"）被完整主题词 substring 评分误判命中。
 *
 * 与 `detectSelectedSegmentIntent` 的关系：
 * - `detectSelectedSegmentIntent` 用全局白名单**过滤** selected intent 双义词；
 * - 本函数独立判定 question 本身是不是"全局 / 概览 / 总结"类问题，给路由层
 *   第 8 位 question_match 之前的一道闸门用。
 *
 * 边界：
 * - 不在白名单 → 返回 false（路由层正常走 question_match 判定）。
 * - 命中白名单 → 返回 true（路由层直接落 global，跳过 question_match）。
 * - 大小写不敏感；标点不影响匹配（`containsWord` / `containsSubstringWithWordBoundary` 已处理）。
 */
export function isGlobalIntentQuestion(question: string): boolean {
  const raw = question.trim();
  if (!raw) {
    return false;
  }
  const lowered = raw.toLowerCase();
  for (const trigger of GLOBAL_INTENT_OVERRIDES_EN) {
    if (containsWord(lowered, trigger)) {
      return true;
    }
  }
  for (const trigger of GLOBAL_INTENT_OVERRIDES_ZH) {
    if (containsSubstringWithWordBoundary(raw, trigger)) {
      return true;
    }
  }
  return false;
}
