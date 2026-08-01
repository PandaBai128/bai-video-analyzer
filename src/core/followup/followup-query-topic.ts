/**
 * 追问查询的主题提取（FR-01）。
 *
 * 从用户问句中提取"完整主题词"，用于全字幕检索（transcript-retrieval）。
 *
 * 设计原则（SG-05B 系列 + FR-01）：
 * - 不做 embedding / 分词器 / 模糊匹配 / 同音字。
 * - 不维护人物名、游戏术语或技术词白名单。
 * - 输出按"完整主题词"语义保留，不拆为子 n-gram（如"系统方法"必须整体匹配）。
 *
 * 4 阶段骨架剥除（SG-05B QA4）+ FR-01 新增 1 阶段：
 * - 阶段 1：首尾标点 / 语气词
 * - 阶段 2：开头请求词（请 / 请问 / 能否 / 可以 / 能 / 帮我 / 麻烦 / 帮）
 * - 阶段 3：解释动作（解释 / 介绍 / 简述 / 描述 / 讲解 / 讲 / 说）+ 可选补语
 * - 阶段 4：问句骨架 —— 尾部优先（是什么 / 是谁 / 有什么效果 等），再剥头部（什么是 / 什么叫）
 * - **阶段 5（FR-01 新增）**：剥除紧邻主题尾部的问句修饰词（到底 / 具体 / 究竟 / 分别）。
 *   只在尾部骨架剥除后，仍位于主题尾部的修饰词才剥 —— "具体方法是什么" 剥
 *   "是什么" 后剩 "具体方法"，头部 "具体" 不被剥。
 *
 * 不负责：
 * - 时间均匀采样 / 字符预算：transcript-sampling / transcript-retrieval
 * - 路由 / 上下文组装：select-followup-context / followup-context-builders
 * - 字幕窗口匹配：transcript-retrieval
 */

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/**
 * 安全可忽略的中文虚词 / 助词 / 语气词 —— 归一化时替换为空格，
 * 让"维琳娜的一命效果"和"维琳娜一命效果"经归一化后能命中同一组 token。
 */
const ZH_STOPWORDS = new Set([
  '的', '了', '过', '着', '么', '呢', '啊', '呀', '吧', '嘛', '哈', '哦', '啦',
]);

/**
 * 安全可忽略的英文 / ASCII 停用词 —— 归一化时同样替换为空格。
 * 不列常见英文术语避免误伤。
 */
const ASCII_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing',
  'what', 'who', 'how', 'where', 'when', 'why', 'which',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as',
  'is', 'it', 'its', 'this', 'that', 'these', 'those',
]);

/**
 * 文本归一化：
 * - lowercase
 * - 中英文常见标点 → 空格（保留中文字符）
 * - 中文虚词 / ASCII 停用词 → 空格
 * - 折叠空白
 *
 * 用于把"维琳娜的一命效果"和"维琳娜一命效果是什么"归一化到同一组 token。
 */
export function normalizeText(text: string): string {
  if (!text) {
    return '';
  }
  return text
    .toLowerCase()
    // 标点 / 符号 → 空格（含 ASCII , . ! ? ; : ( ) [ ] { } " ' " " ' —— — – - / \）
    .replace(/[\s,.!?:;()[\]{}"'""''——–/\\]+/g, ' ')
    // 中文虚词 → 空格
    .replace(/[的了过着么呢吧嘛哈哦呀啊啦]/g, ' ')
    // 折叠空白
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 完整主题词（SG-05B QA3 修复要求 A + QA4 修复要求 A + FR-01 扩展）
// ---------------------------------------------------------------------------

/**
 * 主题词最大长度。超过则视为陈述句不是查询（substring 匹配也很慢）。
 *
 * SG-05B QA4 沿用 QA3 的 32 字符上限；FR-01 保持不变。
 */
export const MAX_TOPIC_LENGTH = 32;

/**
 * 匹配用归一化（SG-05B QA3）：在 `normalizeText` 基础上再剥掉所有空白。
 *
 * 必要性：完整主题词 substring 匹配时，cue 含 "的"（被 `normalizeText` 替换为
 * 空格）会让主题词 "维琳娜一命效果" 找不到 "维琳娜 一命效果"（中间多个空格）。
 * 双方都用本函数归一化后 "维琳娜一命效果" 能稳定命中 "现在讲解维琳娜 的一命
 * 效果触发逻辑"。
 *
 * 注意：这是**匹配**专用的归一化，**不**用于对外展示或 token 切分。主题词
 * 仍用 `normalizeText`（保留空格）以便用户可读。
 */
export function normalizeForMatching(text: string): string {
  return normalizeText(text).replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// SG-05B QA4 修复要求 A：主题提取改为可组合的轻量步骤 + FR-01 阶段 5
// ---------------------------------------------------------------------------
//
// 设计动机（QA4 §1）：QA3 用扁平 `QUERY_TOPIC_PHRASES` 列表 + 长度倒序匹配
// 单端剥除，**无法表达"骨架组合"**——"请解释一下 AI / 能讲一下 RAG 吗 /
// 帮我解释维琳娜一命效果"这类自由问句里，"请解释"会被单条短语命中，但
// 残留的"一下 AI"或"一下 RAG 吗"无法继续剥除，导致整句被错误当作主题词。
//
// FR-01 §3B 新增需求（自然问句修饰词）：
// - 尾部骨架增加 `有什么效果`。
// - 骨架剥除后允许继续剥除紧邻主题尾部的修饰词 `到底 / 具体 / 究竟 / 分别`。
// - `具体方法是什么` 必须仍以 `具体方法` 为主题 —— "具体" 在主题头部不能被剥。
//
// 保留不变量：
// - 主题词**不**展开为子 n-gram（QA3 §2 验收 3 "系统方法"必须整体匹配）。
// - 不维护人名 / 技术词白名单（QA3 §2 "不能维护人物名或技术词白名单"）。
// - 主题词为空 / ≤1 字符 → 路由层走 global（**不**生成"完整字幕零命中"
//   否认信号，与 QA1 / QA3 行为一致）。

/**
 * 阶段 1：尾部语气词 / 标点 / 引号 / 括号（SG-05B QA5 补齐中文标点 + 全角引号）。
 *
 * 覆盖场景：
 * - 语气词：`呢啊呀吧`（**不含 `吗`** —— FR-02 §3 Agent A 修正：`维林娜一命好吗`
 *   必须在阶段 5 才剥 `好吗` / `吗`，阶段 1 提前剥 `吗` 会留下 `好` 单字当主题，
 *   单字主题走 global 后 `提取主题` 仍可能错位。`吗` 改由阶段 5 尾部修饰词统一剥）。
 * - 英文标点：`.!?;:,'"` + 圆括号（QA3 既有 .!?）。
 * - 中文标点：`。，！？；：、` + 全角引号 `"\u201C\u201D'"\u2018\u2019` +
 *   全角括号 `（）` + 中文方括号 `【】` + 中文书名号 `《》` + 尖括号 `<>`。
 *
 * 字符类用 `^...+$` 锚定首尾连续段 —— 中间合法字符（包括中间引号）天然不被剥，
 * 不会误伤 `他说"AI"是什么` 这类中间带引号的真实问句。
 */
const TRAILING_PARTICLE_PATTERN =
  /[呢啊呀吧？?!\s。，！？；：、,;:"'"\u201C\u201D\u2018\u2019()（）【】《》<>]+$/u;
/** 阶段 1：头部空白 / 问号 / 标点 / 引号 / 括号（QA5 同步补齐中文标点 + 全角引号）。*/
const LEADING_PARTICLE_PATTERN =
  /^[\s？?!。，！？；：、,;:"'"\u201C\u201D\u2018\u2019()（）【】《》<>]+/u;

/** 阶段 2：开头请求词（礼貌词 + 能力词），按长度倒序匹配避免短词先截断。 */
const LEADING_REQUEST_WORDS: readonly string[] = [
  '请问', '能否', '可以', '能不能', '帮我', '麻烦', '请', '能', '帮',
];

/** 阶段 3：解释动作（核心动词）。 */
const REQUEST_VERBS: readonly string[] = [
  '解释', '介绍', '简述', '描述', '讲解', '讲', '说',
];

/**
 * 阶段 3：解释动作后的可选补语 —— 包含"一下 / 一下子 / 讲讲"等。
 *
 * 注意顺序：补语列表必须**先于**动词列表尝试（"讲讲"应被识别为补语
 * 而非被 "讲" 动词先吃掉）。
 */
const REQUEST_COMPLEMENTS: readonly string[] = [
  '一下', '一下子', '一下下', '讲讲', '说说', '讲讲看', '说一下',
];

/**
 * 阶段 4：尾部问句骨架（"X 是什么" / "X 怎么用" 等）。
 *
 * FR-01 §3B 追加 `有什么效果`（常见游戏 / 教程问法："一命效果是什么" / "技能有什么效果"）。
 *
 * FR-02 §3 Agent A 追加复合问法修饰词（按长度倒序匹配，位置无所谓）：
 * `等于什么 / 怎么算 / 怎么调 / 是多少 / 好不好 / 强不强 / 值不值得`。
 * 这些词覆盖自然问法常见尾部短问，必须在阶段 5 之前剥除；阶段 5 仍兜底处理
 * `好吗 / 强吗 / 单字 吗` 等更短的尾部修饰词。
 */
const TRAILING_QUESTION_SKELETON: readonly string[] = [
  '有什么效果', // FR-01 新增
  '有什么作用', '有什么用', '有什么特点',
  '在第几分钟', '在几分钟', '第几分钟', '几分钟',
  '在哪一段', '哪一段', '在哪段', '哪段',
  '在哪里', '在哪儿', '在哪', '在什么位置', '什么位置', '哪里',
  '是什么', '是谁', '怎么样', '怎样', '如何', '怎么用', '怎么', '讲什么',
  // FR-02 §3 Agent A：复合问法修饰词（与 `是什么 / 是谁` 等并列）。
  '等于什么', '怎么算', '怎么调', '是多少', '好不好', '强不强', '值不值得',
  '是不是标题党', '是标题党吗', '是标题党',
];

/** 阶段 4：开头问句骨架（"什么是 X" / "什么叫 X"）。 */
const LEADING_QUESTION_SKELETON: readonly string[] = [
  '什么是', '什么叫', '难道',
];

/**
 * FR-01 §3B 阶段 5：问句修饰词，紧邻主题尾部剥除。
 *
 * 设计动机：自然问法常在尾部骨架前夹修饰词（"维琳娜一命到底有什么效果" /
 * "鲁迅究竟是谁"），尾部骨架剥除后残留的修饰词必须继续剥掉，否则
 * `extractQueryTokens` 输出 "维琳娜一命到底" / "鲁迅究竟" 这样的长尾主题，
 * 全字幕 substring 匹配不到。
 *
 * 关键不变量（FR-01 §3B）：
 * - 只能按边界和阶段处理，**禁止**对整句全局替换。
 * - "具体方法是什么" 必须仍以 `具体方法` 为主题 —— 剥尾部骨架 "是什么" 后剩
 *   "具体方法"，"具体" 此时在主题**头部**，阶段 5 只剥尾部，天然不剥头部。
 * - 既有契约（FR-01 §4 验收 5）"系统方法是什么" 不得误命中（"系统" / "方法"
 *   不相邻出现在 cue 中时），由 transcript-retrieval 的完整主题词 substring
 *   匹配保证 —— 本阶段 5 不展开主题为子词。
 *
 * FR-02 §3 Agent A 追加短问法修饰词 + 单字 `吗`：
 * - `好不好 / 强不强 / 好吗 / 强吗` —— 阶段 4 已剥 `好不好 / 强不强`（在骨架清单），
 *   `好吗 / 强吗` 较短不在骨架内，由阶段 5 兜底。
 * - 单字 `吗` —— 配合阶段 1 移除 `吗` 的修正，让 `维林娜一命好吗` 走
 *   阶段 5 剥 `好吗` → "维林娜一命"，不留下 `好` 单字当主题。
 *   阶段 5 已有 `result.length > word.length` 保护（line ~317），单字 `吗`
 *   不会把长度为 1 的字符串剥空。
 */
const TRAILING_QUESTION_MODIFIERS: readonly string[] = [
  '到底', '具体', '究竟', '分别',
  // FR-02 §3 Agent A：短问法修饰词 + 单字「吗」。
  '好不好', '强不强', '好吗', '强吗', '吗',
];

/**
 * 位置类问题里常见的尾部泛化名词。
 *
 * 例："计划模式的讲解在哪里" 的检索主题应是 "计划模式"，否则多出来的
 * "讲解" 会让时间线标题 "计划模式与需求确认" 漏命中。
 */
const TRAILING_TOPIC_NOISE: readonly string[] = [
  '的作用有没有说明', '作用有没有说明',
  '的作用有没有讲', '作用有没有讲',
  '的作用有没有说', '作用有没有说',
  '的作用有说明', '作用有说明',
  '的作用有介绍', '作用有介绍',
  '的作用有解释', '作用有解释',
  '的作用有讲', '作用有讲',
  '的作用有提', '作用有提',
  '的作用有说', '作用有说',
  '的作用说明', '作用说明',
  '的作用介绍', '作用介绍',
  '的作用解释', '作用解释',
  '的作用', '作用',
  '的用途', '用途',
  '的用处', '用处',
  '的功能', '功能',
  '讲解内容', '讲解部分', '讲解片段', '讲解段落', '讲解',
  '内容部分', '内容片段', '内容段落', '内容',
  '部分', '片段', '段落', '位置',
];

/** 长度倒序排（避免短词先命中截断）。 */
function sortByLengthDesc(list: readonly string[]): string[] {
  return [...list].sort((a, b) => b.length - a.length);
}

/** 阶段 1：清理首尾标点 / 语气词。 */
function cleanPunctuationAndParticles(text: string): string {
  return text
    .replace(LEADING_PARTICLE_PATTERN, '')
    .replace(TRAILING_PARTICLE_PATTERN, '')
    .trim();
}

/**
 * 阶段 2：剥离开头请求词，循环直到不再命中（"请问能 X" / "能帮我 X"
 * 叠多个请求词的情况）。
 */
function stripLeadingRequestWords(text: string): string {
  const sorted = sortByLengthDesc(LEADING_REQUEST_WORDS);
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of sorted) {
      if (result.startsWith(word)) {
        result = result.slice(word.length).trim();
        changed = true;
        break;
      }
    }
  }
  return result;
}

/**
 * 阶段 3：先尝试补语（"讲讲" / "一下"），再尝试动词（"讲" / "解释"）。
 * **循环**到不再命中 —— "请解释一下 X" 应得 "解释 → 一下 → X"（剥 2 次），
 * "请讲讲 X" 应得 "讲讲 → X"（剥 1 次）。
 */
function stripRequestVerbAndComplement(text: string): string {
  const sortedComplements = sortByLengthDesc(REQUEST_COMPLEMENTS);
  const sortedVerbs = sortByLengthDesc(REQUEST_VERBS);
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    // 先补语：避免"讲讲"被"讲"动词先吃掉
    for (const complement of sortedComplements) {
      if (result.startsWith(complement)) {
        result = result.slice(complement.length).trim();
        changed = true;
        break;
      }
    }
    if (changed) continue;
    // 再动词
    for (const verb of sortedVerbs) {
      if (result.startsWith(verb)) {
        result = result.slice(verb.length).trim();
        changed = true;
        break;
      }
    }
  }
  return result;
}

/** 阶段 4：先剥尾部骨架，再剥头部骨架。各自循环到不再命中。 */
function stripQuestionSkeleton(text: string): string {
  let result = text;
  // 尾部
  {
    const sorted = sortByLengthDesc(TRAILING_QUESTION_SKELETON);
    let changed = true;
    while (changed) {
      changed = false;
      for (const word of sorted) {
        if (result.endsWith(word)) {
          result = result.slice(0, result.length - word.length).trim();
          changed = true;
          break;
        }
      }
    }
  }
  // 头部
  {
    const sorted = sortByLengthDesc(LEADING_QUESTION_SKELETON);
    let changed = true;
    while (changed) {
      changed = false;
      for (const word of sorted) {
        if (result.startsWith(word)) {
          result = result.slice(word.length).trim();
          changed = true;
          break;
        }
      }
    }
  }
  return result;
}

/**
 * FR-01 §3B 阶段 5：剥除紧邻主题尾部的问句修饰词（到底 / 具体 / 究竟 / 分别）。
 *
 * 关键不变量（FR-01 §3B + §4 验收 6-7）：
 * - **只剥尾部**：`result.endsWith(modifier)` —— "具体方法" 经阶段 4 剥 "是什么"
 *   后剩 "具体方法"，"具体" 在头部不被剥。
 * - **循环**到不再命中：极端输入可能叠多个修饰词（"X 到底究竟分别是什么"
 *   → 阶段 4 剥 "是什么" → "X 到底究竟分别" → 阶段 5 循环剥 3 次 → "X"）。
 * - **按长度倒序匹配**：避免短词先截断。
 *
 * 安全保护：阶段 4 已确保主题词是"完整主题词"语义（QA3 验证），阶段 5
 * 移除的修饰词都是固定清单内的词，不会破坏主题完整性。
 */
function stripTrailingQuestionModifiers(text: string): string {
  const sorted = sortByLengthDesc(TRAILING_QUESTION_MODIFIERS);
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of sorted) {
      if (result.endsWith(word) && result.length > word.length) {
        result = result.slice(0, result.length - word.length).trim();
        changed = true;
        break;
      }
    }
  }
  return result;
}

function stripTrailingTopicNoise(text: string): string {
  const sorted = sortByLengthDesc(TRAILING_TOPIC_NOISE);
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of sorted) {
      if (result.endsWith(word) && result.length > word.length) {
        result = result.slice(0, result.length - word.length).trim();
        changed = true;
        break;
      }
    }
  }
  return result;
}

function stripLeadingFollowupParticleAfterNoise(text: string, enabled: boolean): string {
  if (!enabled) return text;
  if (text.startsWith('那么') && text.length > 2) {
    return text.slice(2).trim();
  }
  if (text.startsWith('然后') && text.length > 2) {
    return text.slice(2).trim();
  }
  if (text.startsWith('那') && text.length > 1) {
    return text.slice(1).trim();
  }
  return text;
}

/**
 * 从问句中提取"完整主题词" —— 按可组合的 4 阶段剥除问句骨架 + FR-01 阶段 5
 * 剥除尾部问句修饰词。
 *
 * 行为契约（SG-05B QA3 §2 + QA4 §1-2 + FR-01 §3B）：
 *
 * QA3 / QA4 / QA5 既有契约（不回归）：
 * - `AI 是什么` → `ai`
 * - `鲁迅是谁` → `鲁迅`
 * - `维琳娜一命效果是什么` → `维琳娜一命效果`
 * - `BM25 算法核心思想是什么` → `bm25 算法核心思想`
 * - `系统方法是什么` → `系统方法`（**不**切到 `系统` / `方法`）
 * - `RAG 是什么` → `rag`
 * - `请简述星舰建造` → `星舰建造`（"请" + "简述" 两阶段剥除）
 * - `什么是 RAG` → `rag`
 * - `请解释一下 AI` → `ai`
 * - `请介绍一下鲁迅` → `鲁迅`
 * - `能讲一下 RAG 吗` → `rag`
 * - `帮我解释维琳娜一命效果` → `维琳娜一命效果`
 * - `这个视频主要讲什么` → ``（被 global intent 闸门优先拦截）
 *
 * FR-01 §4 验收 6-7 新增契约（自然问句修饰词）：
 * - `维琳娜一命到底有什么效果` → `维琳娜一命`（阶段 4 剥 "有什么效果" → 阶段 5 剥 "到底"）
 * - `维琳娜一命具体有什么效果` → `维琳娜一命`（同上 + "具体"）
 * - `鲁迅究竟是谁` → `鲁迅`（阶段 4 剥 "是谁" → 阶段 5 剥 "究竟"）
 * - `具体方法是什么` → `具体方法`（阶段 4 剥 "是什么" 后剩 "具体方法"，阶段 5 不剥头部的"具体"）
 * - `X 到底究竟分别是什么` → `X`（阶段 5 循环剥 3 次）
 *
 * 不变量：
 * - 主题词**不**展开为子 n-gram（QA3 §2 验收 3）。
 * - 不维护人名 / 技术词白名单（QA3 §2）。
 * - 主题词为空 / ≤1 字符 → 路由层走 global，不生成否认信号（QA3 §2）。
 */
export function extractCompleteTopic(question: string): string {
  const trimmed = question.trim();
  if (!trimmed) {
    return '';
  }
  // 阶段 1：首尾标点 / 语气词
  let text = cleanPunctuationAndParticles(trimmed);
  if (!text) {
    return '';
  }
  // 阶段 2：开头请求词
  text = stripLeadingRequestWords(text);
  if (!text) {
    return '';
  }
  // 阶段 3：解释动作 + 可选补语
  text = stripRequestVerbAndComplement(text);
  if (!text) {
    return '';
  }
  // 阶段 4：问句骨架（先尾后头）
  text = stripQuestionSkeleton(text);
  if (!text) {
    return '';
  }
  // 阶段 5（FR-01 §3B）：剥除紧邻主题尾部的问句修饰词
  text = stripTrailingQuestionModifiers(text);
  if (!text) {
    return '';
  }
  // 阶段 6：剥除位置类问题残留的尾部泛化名词
  const beforeTopicNoise = text;
  text = stripTrailingTopicNoise(text);
  if (!text) {
    return '';
  }
  // 只在确实剥掉了"作用/用途/位置"等尾部噪声后，再处理追问开头的"那"。
  // 这样能覆盖"那电脑插件的作用有说吗"，同时避免把普通主题词里的"那"泛化删除。
  text = stripLeadingFollowupParticleAfterNoise(text, beforeTopicNoise !== text);
  if (!text) {
    return '';
  }
  return normalizeForMatching(text);
}

// ---------------------------------------------------------------------------
// 查询词项提取
// ---------------------------------------------------------------------------

/**
 * 问句骨架 / 通用弱 token —— 不参与 question_match 评分（SG-05B QA1 修复要求 B）。
 *
 * 原因：用户问"这个视频主要讲什么"时，骨架词"这个 / 视频 / 主要"会被普通事实检索
 * 错误地当作"区分度 token"，导致字幕含"这个"也走 question_match 误判为命中。
 *
 * 与 ZH_STOPWORDS / ASCII_STOPWORDS 区别：
 * - 归一化阶段去掉的虚词（"的了着"）+ 英文停用词（"the"）— 是为了归一化文本
 *   能正确分词；与检索**打分**无关。
 * - 问句骨架词 — 是为了不让骨架词参与检索打分（normalize 时**保留**，
 *   extractQueryTokens 时**排除**）。
 *
 * SG-05B QA3 调整：完整主题词**不**展开为子 n-gram（见 `extractCompleteTopic`），
 * 这份骨架词集合主要作双保险 —— 防止 `extractCompleteTopic` 在边界场景下漏掉
 * 骨架时（极少见）仍能挡住。
 */
const QUERY_SKELETON_TOKENS = new Set([
  // 单字弱 token
  '这', '那', '它', '请', '问', '谁', '哪', '几', '怎', '什',
  // 双字问句骨架
  '这个', '那个', '请问', '视频', '主要', '讲什么', '是什么', '怎么', '怎样', '如何',
]);

/**
 * 提取普通事实问题的查询 token（SG-05B QA3 改用"完整主题词"）。
 *
 * 旧版（QA1 / QA2）从 question 全量 n-gram 提取（1-6 字 / 2-6 ASCII），再用
 * `isReliableToken` 过滤"区分度"。问题：
 * - 2 字中文专名（"鲁迅" / "金庸"）和 2-3 字符 ASCII 缩写（"AI" / "RAG"）被一刀切。
 * - "系统方法是什么" 的 n-gram 含"系统"和"方法"——subtitle 分别含两个词但**不**
 *   含完整短语时仍会误判命中（QA3 §2 验收 3）。
 *
 * 新版（QA3）：先 `extractCompleteTopic(question)` 剥离问句骨架得到完整主题词，
 * 把主题词**作为单个 token**返回（不展开为子 n-gram）。这样：
 * - 主题词作为整体参与 substring 匹配 —— 2 字专名 / 短语整体都支持。
 * - 子 n-gram 不会单独参与匹配 —— "系统方法"必须整体出现才算命中，
 *   "系统"或"方法"分散出现不命中。
 *
 * 返回：长度为 0 或 1 的数组。
 */
export function extractQueryTokens(question: string): readonly string[] {
  const topic = extractCompleteTopic(question);
  if (!topic || topic.length < 2) {
    return [];
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    return [];
  }
  return [topic];
}

// ---------------------------------------------------------------------------
// FR-02 §3 集成负责人：FollowupQueryPlan 共享契约（基础 commit 占位）
// ---------------------------------------------------------------------------

/**
 * 追问查询主题提取的输出契约（FR-02 §3 集成负责人）。
 *
 * 三个工作流（query-topic / transcript-retrieval / prompt）共用同一契约。
 * MVP 阶段仅保留 `exactTopic` / `orderedTopic` / `originalQuestion` 三字段；
 * 字段命名可调整但接口必须稳定。
 *
 * 实际填充见 FR-02 Agent A 在 `extractFollowupQueryPlan()` 中实现。
 */
export interface FollowupQueryPlan {
  readonly exactTopic: string;
  readonly orderedTopic: string;
  readonly originalQuestion: string;
}

/**
 * 从问句中提取追问查询计划（FR-02 §3 Agent A 共享契约）。
 *
 * 与 `extractCompleteTopic` 的关系：
 * - `extractCompleteTopic(q)` 只输出归一化后的"完整主题词"，给 `extractQueryTokens`
 *   和 transcript-retrieval 的 exact 匹配层用。
 * - 本函数输出**结构化 plan**，给 transcript-retrieval 的多层级匹配（exact /
 *   ordered_coverage / one_edit）和 prompt 解释共用。
 *
 * 共享 5 阶段剥除逻辑：直接复用 `extractCompleteTopic` 的实现，避免双源漂移。
 * 这样 `plan.exactTopic === extractCompleteTopic(q)` 是天然不变量。
 *
 * MVP 阶段字段语义：
 * - `exactTopic` —— 与 `extractCompleteTopic(q)` 完全一致。
 * - `orderedTopic` —— MVP 阶段等于 `exactTopic`，不展开为子 n-gram。
 * - `originalQuestion` —— 原始问句原文（保留 user 表述，给 prompt 解释命中用）。
 *
 * 长度判定（QA2 收口）：不做长度 < 2 → 空 plan 的截断；路由层 / transcript-retrieval
 * 自己决定是否走 `global` 兜底。空字符串仍返回 `{ exactTopic: '', orderedTopic: '',
 * originalQuestion: '' }`，让调用方能用 `plan.exactTopic.length === 0` 判断。
 *
 * 契约（QA2 收口）：`question` 是 `string`，不接受 `null` / `undefined` —— 调用方
 * 用 `?? ''` 自己处理。
 */
export function extractFollowupQueryPlan(question: string): FollowupQueryPlan {
  const exact = extractCompleteTopic(question);
  return {
    exactTopic: exact,
    // MVP 阶段：orderedTopic 与 exactTopic 共用同字符串（不展开为子 n-gram）。
    // transcript-retrieval 走完整主题词 substring 匹配，仍能命中 cue。
    orderedTopic: exact,
    originalQuestion: question,
  };
}

// ---------------------------------------------------------------------------
// 弱词过滤（兜底，给 transcript-retrieval 用）
// ---------------------------------------------------------------------------

/**
 * 判断 token 是否"可靠"（SG-05B QA3 修复要求 A + C：长度不等于区分度，靠
 * 完整主题词 + 弱词过滤判定）。
 *
 * 旧版（QA2）规则 `length >= 3` 误杀：
 * - 2 字中文专名（"鲁迅" / "金庸"）
 * - 2 字符 ASCII 缩写（"AI"）
 *
 * 新版（QA3）规则：
 * - `length >= 2` 字符（覆盖所有"完整主题词"输出，包括 2 字专名 / 2-3 字 ASCII）。
 * - 不在 `QUERY_SKELETON_TOKENS`（问句骨架 / 通用弱词 — 已被 `extractQueryTokens`
 *   + `extractCompleteTopic` 排除，双保险）。
 * - 不在 `ZH_STOPWORDS` / `ASCII_STOPWORDS`。
 *
 * 与"完整主题词"的关系：QA3 之后 `extractQueryTokens` 输出的 token 都是从
 * question 剥离骨架后的剩余短语，本质上**都是**"用户实际想查的主题"。但
 * `isReliableToken` 仍保留作为弱词过滤兜底 —— 防止 `extractCompleteTopic` 边界
 * 场景（极少见）漏掉骨架时仍能挡住。
 *
 * 用途：transcript-retrieval 的 `scoreHits` 在判定 `reliableScore` 时调用，
 * 决定一条命中是否真正"可靠"（参与 `hasReliableQueryHit` 判定）。
 */
export function isReliableToken(token: string): boolean {
  if (token.length < 2) return false;
  if (QUERY_SKELETON_TOKENS.has(token)) return false;
  if (ASCII_STOPWORDS.has(token)) return false;
  if (ZH_STOPWORDS.has(token)) return false;
  return true;
}
