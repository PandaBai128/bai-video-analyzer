import { describe, expect, it } from 'vitest';
import {
  extractCompleteTopic,
  extractFollowupQueryPlan,
  extractQueryTokens,
  isReliableToken,
} from '@core/followup/followup-query-topic';

/**
 * FR-01 §3C 必修：主题提取职责拆分到 followup-query-topic 模块，
 * 本文件专门测纯函数 `extractCompleteTopic` / `extractQueryTokens` /
 * `isReliableToken` 的行为契约。
 *
 * 行为契约分层（按 QA 阶段递进，不回归）：
 * - QA3 §2：完整主题词（不展开为子 n-gram）+ 短专有词支持
 * - QA4 §1-2：4 阶段可组合剥除
 * - QA5：首尾中文标点 / 引号 / 括号清理
 * - FR-01 §3B：尾部问句修饰词（到底 / 具体 / 究竟 / 分别）
 *
 * 端到端行为在 `transcript-retrieval.test.ts` 测（用 `selectFollowupContext`）。
 */

// ---------------------------------------------------------------------------
// SG-05B QA3 §2 验收：完整主题词 + 短专有词
// ---------------------------------------------------------------------------

describe('SG-05B QA3 §2: extractCompleteTopic 完整主题词（不展开为子 n-gram）', () => {
  it('验收 1: "AI 是什么" → "ai"（2 字符 ASCII 缩写）', () => {
    expect(extractCompleteTopic('AI 是什么')).toBe('ai');
  });

  it('验收 2: "鲁迅是谁" → "鲁迅"（2 字中文专名）', () => {
    expect(extractCompleteTopic('鲁迅是谁')).toBe('鲁迅');
  });

  it('验收 3a: "系统方法是什么" → "系统方法"（不切到 系统 / 方法）', () => {
    expect(extractCompleteTopic('系统方法是什么')).toBe('系统方法');
  });

  it('验收 3b: "BM25 算法核心思想是什么" → "bm25算法核心思想"（normalizeForMatching 折叠空白 + 的）', () => {
    // 注意：normalizeForMatching 把所有空白折叠成空，"的" 也按 ZH_STOPWORDS 折叠。
    // 这是匹配专用归一化（transcript-retrieval 用），不是用户可读文本。
    expect(extractCompleteTopic('BM25 算法核心思想是什么')).toBe('bm25算法核心思想');
  });

  it('验收 3c: "RAG 是什么" → "rag"', () => {
    expect(extractCompleteTopic('RAG 是什么')).toBe('rag');
  });

  it('验收 3d: "什么是 RAG" → "rag"（头部骨架剥除）', () => {
    expect(extractCompleteTopic('什么是 RAG')).toBe('rag');
  });

  it('验收 3e: "请简述星舰建造" → "星舰建造"（"请" + "简述" 两阶段剥除）', () => {
    expect(extractCompleteTopic('请简述星舰建造')).toBe('星舰建造');
  });

  it('验收 3g: "维琳娜一命效果是什么" → "维琳娜一命效果"（核心 case，normalize 后无 "的"）', () => {
    // 注意：原文"维琳娜一命效果" 经 normalizeForMatching 后保留原顺序；
    // cue "维琳娜的一命效果" → 归一化后 "维琳娜一命效果"，与 topic 完全一致。
    expect(extractCompleteTopic('维琳娜一命效果是什么')).toBe('维琳娜一命效果');
  });

  it('验收 3f: "维琳娜一命效果是什么" → "维琳娜一命效果"（核心 case）', () => {
    expect(extractCompleteTopic('维琳娜一命效果是什么')).toBe('维琳娜一命效果');
  });
});

// ---------------------------------------------------------------------------
// SG-05B QA4 §1-2 验收：4 阶段可组合剥除
// ---------------------------------------------------------------------------

describe('SG-05B QA4 §1-2: extractCompleteTopic 4 阶段可组合剥除', () => {
  it('验收 1: "请解释一下 AI" → "ai"（阶段 2 剥 "请" + 阶段 3 剥 "解释"+"一下"）', () => {
    expect(extractCompleteTopic('请解释一下 AI')).toBe('ai');
  });

  it('验收 2: "请介绍一下鲁迅" → "鲁迅"（同上）', () => {
    expect(extractCompleteTopic('请介绍一下鲁迅')).toBe('鲁迅');
  });

  it('验收 3: "能讲一下 RAG 吗" → "rag"（阶段 1 剥 "吗" + 阶段 2 剥 "能" + 阶段 3 剥 "讲"+"一下"）', () => {
    expect(extractCompleteTopic('能讲一下 RAG 吗')).toBe('rag');
  });

  it('验收 4: "帮我解释维琳娜一命效果" → "维琳娜一命效果"（"帮我" + "解释"）', () => {
    expect(extractCompleteTopic('帮我解释维琳娜一命效果')).toBe('维琳娜一命效果');
  });

  it('验收 5 不回归: 阶段 4 骨架剥除（"有什么作用" / "是什么" / "什么是"）', () => {
    expect(extractCompleteTopic('AI 有什么作用')).toBe('ai');
    expect(extractCompleteTopic('AI 是什么')).toBe('ai');
    expect(extractCompleteTopic('什么是 RAG')).toBe('rag');
  });

  it('验收 6: "这个视频主要讲什么" → "这个视频主要"（QA1 isGlobalIntentQuestion 闸门优先拦截）', () => {
    // 注意：extractCompleteTopic 不会把它剥光（"讲" 是 REQUEST_VERBS 会被阶段 3 剥，但
    // 阶段 4 尾部骨架不含 "什么"）。本题的 global 路由由
    // `isGlobalIntentQuestion("这个视频主要讲什么")` 白名单命中拦截，端到端测试在
    // transcript-retrieval.test.ts 覆盖。
    expect(extractCompleteTopic('这个视频主要讲什么')).toBe('这个视频主要');
  });
});

// ---------------------------------------------------------------------------
// SG-05B QA5 验收：首尾中文标点 / 引号 / 括号清理
// ---------------------------------------------------------------------------

describe('SG-05B QA5: cleanPunctuationAndParticles 首尾中文标点 + 引号括号覆盖', () => {
  it('验收 1: "请解释一下 AI。" → "ai"（中文句号残留 → 阶段 1 剥除）', () => {
    expect(extractCompleteTopic('请解释一下 AI。')).toBe('ai');
  });

  it('验收 2: "请介绍一下鲁迅！" → "鲁迅"（中文感叹号残留）', () => {
    expect(extractCompleteTopic('请介绍一下鲁迅！')).toBe('鲁迅');
  });

  it('验收 3: "能讲一下 RAG 吗？" → "rag"（中文问号 + 语气词）', () => {
    expect(extractCompleteTopic('能讲一下 RAG 吗？')).toBe('rag');
  });

  it('验收 4: 首尾 ASCII / 全角引号 + 全角 / ASCII 括号全部清理', () => {
    expect(extractCompleteTopic('"AI 是什么？"')).toBe('ai');
    expect(extractCompleteTopic('\u201CAI 是什么？\u201D')).toBe('ai');
    expect(extractCompleteTopic('（AI 是什么）')).toBe('ai');
    expect(extractCompleteTopic('(AI 是什么)')).toBe('ai');
    expect(extractCompleteTopic('【AI 是什么】')).toBe('ai');
    expect(extractCompleteTopic('《AI 是什么》')).toBe('ai');
  });

  it('验收 5 不回归: QA4 6 个无标点场景', () => {
    expect(extractCompleteTopic('请解释一下 AI')).toBe('ai');
    expect(extractCompleteTopic('请介绍一下鲁迅')).toBe('鲁迅');
    expect(extractCompleteTopic('能讲一下 RAG 吗')).toBe('rag');
    expect(extractCompleteTopic('帮我解释维琳娜一命效果')).toBe('维琳娜一命效果');
    expect(extractCompleteTopic('AI 有什么作用')).toBe('ai');
    expect(extractCompleteTopic('AI 是什么')).toBe('ai');
    expect(extractCompleteTopic('什么是 RAG')).toBe('rag');
  });
});

// ---------------------------------------------------------------------------
// FR-01 §3B + §4 验收 6-7：尾部问句修饰词（到底 / 具体 / 究竟 / 分别）
// ---------------------------------------------------------------------------

describe('FR-01 §3B 阶段 5: extractCompleteTopic 剥除紧邻主题尾部的问句修饰词', () => {
  it('§4 验收 6: "维琳娜一命到底有什么效果" → "维琳娜一命"（尾部剥 "有什么效果" + 剥 "到底"）', () => {
    expect(extractCompleteTopic('维琳娜一命到底有什么效果')).toBe('维琳娜一命');
  });

  it('§4 验收 6: "维琳娜一命具体有什么效果" → "维琳娜一命"（同上 + "具体"）', () => {
    expect(extractCompleteTopic('维琳娜一命具体有什么效果')).toBe('维琳娜一命');
  });

  it('§4 验收 7a: "鲁迅究竟是谁" → "鲁迅"（尾部剥 "是谁" + 剥 "究竟"）', () => {
    expect(extractCompleteTopic('鲁迅究竟是谁')).toBe('鲁迅');
  });

  it('§4 验收 7b: "具体方法是什么" → "具体方法"（"具体" 在头部不被剥）', () => {
    // 关键不变量（FR-01 §3B）："具体方法是什么" 必须仍以 "具体方法" 为主题。
    // 阶段 4 剥尾部骨架 "是什么" → "具体方法"，阶段 5 只剥尾部，"具体" 在头部不被剥。
    expect(extractCompleteTopic('具体方法是什么')).toBe('具体方法');
  });

  it('FR-01 §3B: "分别" 作为尾部修饰词剥除', () => {
    // 阶段 4 剥尾部骨架 "是什么" → "技能 A 与 B 的区别分别"
    // 阶段 5 剥尾部修饰词 "分别" → "技能 A 与 B 的区别"
    // normalizeForMatching 把"的"和空白折叠 → "技能a与b区别"
    expect(extractCompleteTopic('技能 A 与 B 的区别分别是什么')).toBe('技能a与b区别');
  });

  it('FR-01 §3B: 多个修饰词叠在一起循环剥除', () => {
    // "X 到底究竟分别是什么" → 阶段 4 剥 "是什么" → "X 到底究竟分别"
    // → 阶段 5 循环剥 "到底" / "究竟" / "分别" → "X"
    expect(extractCompleteTopic('X 到底究竟分别是什么')).toBe('x');
  });

  it('FR-01 §3B 不回归: 修饰词出现在主题中部不能被剥', () => {
    // "具体" 在主题中部（不在尾部）不能剥 → 应保留。
    // "技能的具体描述是什么" → 阶段 4 剥 "是什么" → "技能的具体描述"
    // 阶段 5 不剥中部的 "具体" → "技能的具体描述"
    // normalizeForMatching 把"的"和空白折叠 → "技能具体描述"。
    expect(extractCompleteTopic('技能的具体描述是什么')).toBe('技能具体描述');
  });

  it('FR-01 §3B: 修饰词作为完整主题不能误剥（"具体方法是什么" 主题 = "具体方法"）', () => {
    // 与验收 7b 等价：保留 "具体方法" 整体。
    const topic = extractCompleteTopic('具体方法是什么');
    expect(topic).toBe('具体方法');
    expect(topic.length).toBeGreaterThanOrEqual(4);
  });

  it('位置类问法剥除尾部泛化名词: "计划模式的讲解在哪里" → "计划模式"', () => {
    expect(extractCompleteTopic('计划模式的讲解在哪里')).toBe('计划模式');
  });

  it('作用是否讲到类问法保留真正术语: "那电脑插件的作用有说吗" → "电脑插件"', () => {
    expect(extractCompleteTopic('那电脑插件的作用有说吗')).toBe('电脑插件');
  });

  it('标题党反问保留真正主题: "难道机甲是标题党" → "机甲"', () => {
    expect(extractCompleteTopic('难道机甲是标题党')).toBe('机甲');
    expect(extractCompleteTopic('机甲是标题党吗')).toBe('机甲');
  });
});

// ---------------------------------------------------------------------------
// extractQueryTokens 端到端契约
// ---------------------------------------------------------------------------

describe('extractQueryTokens: 从问句提取主题 token', () => {
  it('"AI 是什么" → ["ai"]', () => {
    expect(extractQueryTokens('AI 是什么')).toEqual(['ai']);
  });

  it('"鲁迅是谁" → ["鲁迅"]', () => {
    expect(extractQueryTokens('鲁迅是谁')).toEqual(['鲁迅']);
  });

  it('"维琳娜一命效果是什么" → ["维琳娜一命效果"]（不展开为子 n-gram）', () => {
    expect(extractQueryTokens('维琳娜一命效果是什么')).toEqual(['维琳娜一命效果']);
  });

  it('"这个视频主要讲什么" → ["这个视频主要"]（QA1 闸门负责 global 路由，不是这里）', () => {
    // extractQueryTokens 不做意图识别闸门；QA1 isGlobalIntentQuestion 闸门在
    // select-followup-context.ts 路由层生效，端到端测试在 transcript-retrieval.test.ts。
    expect(extractQueryTokens('这个视频主要讲什么')).toEqual(['这个视频主要']);
  });

  it('"星舰建造" → ["星舰建造"]（陈述句无问句骨架，topic 保留）', () => {
    expect(extractQueryTokens('星舰建造')).toEqual(['星舰建造']);
  });

  it('"鲁迅究竟是谁" → ["鲁迅"]（FR-01 修饰词已剥除）', () => {
    expect(extractQueryTokens('鲁迅究竟是谁')).toEqual(['鲁迅']);
  });

  it('"具体方法是什么" → ["具体方法"]（FR-01 头部 "具体" 不被剥）', () => {
    expect(extractQueryTokens('具体方法是什么')).toEqual(['具体方法']);
  });

  it('"BM25 算法核心思想是什么" → ["bm25算法核心思想"]（无空白匹配专用归一化）', () => {
    // extractCompleteTopic 输出用 normalizeForMatching 折叠空白。
    // 这就是为什么 cue "BM25 的核心思想" 归一化后 "bm25核心思想" 能命中 topic。
    expect(extractQueryTokens('BM25 算法核心思想是什么')).toEqual(['bm25算法核心思想']);
  });

  it('空字符串 → []', () => {
    expect(extractQueryTokens('')).toEqual([]);
  });

  it('单字符 → []（≤1 字符视为不可靠）', () => {
    expect(extractQueryTokens('a')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isReliableToken 弱词过滤兜底
// ---------------------------------------------------------------------------

describe('isReliableToken: 弱词过滤兜底', () => {
  it('2 字中文专名 → true', () => {
    expect(isReliableToken('鲁迅')).toBe(true);
  });

  it('2 字符 ASCII 缩写 → true', () => {
    expect(isReliableToken('AI')).toBe(true);
  });

  it('3 字中文主题 → true', () => {
    expect(isReliableToken('维琳娜')).toBe(true);
  });

  it('问句骨架词 → false', () => {
    expect(isReliableToken('这个')).toBe(false);
    expect(isReliableToken('视频')).toBe(false);
    expect(isReliableToken('主要')).toBe(false);
  });

  it('单字符 → false', () => {
    expect(isReliableToken('a')).toBe(false);
    expect(isReliableToken('的')).toBe(false);
  });

  it('中文虚词 → false', () => {
    expect(isReliableToken('的')).toBe(false);
    expect(isReliableToken('了')).toBe(false);
  });

  it('英文停用词 → false', () => {
    expect(isReliableToken('the')).toBe(false);
    expect(isReliableToken('is')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-02 §4 验收 1：extractCompleteTopic 稳定主题（自然问法修饰词剥离）
// ---------------------------------------------------------------------------
//
// 行为契约（FR-02 §3 Agent A）：
// - 阶段 4 骨架追加 `等于什么 / 怎么算 / 怎么调 / 是多少 / 好不好 / 强不强 / 值不值得`，
//   这些词放末尾剥除。
// - 阶段 5 修饰词追加 `好不好 / 强不强 / 好吗 / 强吗` + 单字 `吗`，兜底短问法。
// - 阶段 1 不再剥 `吗`，否则 `维林娜一命好吗` 会被剥成 `维林娜一命好` 留下
//   `好` 单字当主题 —— 改为由阶段 5 统一处理。
//
// 这些用例是 FR-02 §4 必修验收 1 的核心稳定主题回归点。

describe('FR-02 §4 验收 1: extractCompleteTopic 稳定主题（自然问法修饰词剥离）', () => {
  it('"维林娜一命好吗" → "维林娜一命"（阶段 5 剥 好吗）', () => {
    // 阶段 1 不剥 "吗"（修正），阶段 4 骨架不含 "好吗"，由阶段 5 兜底。
    // 阶段 5 按长度倒序剥 "好吗"(2) → "维林娜一命"。
    expect(extractCompleteTopic('维林娜一命好吗')).toBe('维林娜一命');
  });

  it('"火电补偿倍率等于什么" → "火电补偿倍率"（阶段 4 剥 等于什么）', () => {
    // 阶段 4 骨架追加 "等于什么"（FR-02 §3 Agent A），剥后剩 "火电补偿倍率"。
    expect(extractCompleteTopic('火电补偿倍率等于什么')).toBe('火电补偿倍率');
  });

  it('"火电补偿倍率怎么算" → "火电补偿倍率"（阶段 4 剥 怎么算）', () => {
    // 阶段 4 骨架追加 "怎么算"（FR-02 §3 Agent A）。
    expect(extractCompleteTopic('火电补偿倍率怎么算')).toBe('火电补偿倍率');
  });

  it('"维林娜一命好不好" → "维林娜一命"（阶段 4 剥 好不好）', () => {
    // "好不好"(3) 既在阶段 4 骨架也在阶段 5 修饰词；阶段 4 先命中剥除。
    expect(extractCompleteTopic('维林娜一命好不好')).toBe('维林娜一命');
  });

  it('"维林娜一命值不值得" → "维林娜一命"（阶段 4 剥 值不值得）', () => {
    // 阶段 4 骨架追加 "值不值得"(4)。
    expect(extractCompleteTopic('维林娜一命值不值得')).toBe('维林娜一命');
  });
});

// ---------------------------------------------------------------------------
// FR-02 §4 验收 7：修饰词不误伤主题内部
// ---------------------------------------------------------------------------
//
// 关键不变量（FR-02 §3 Agent A + handoff §4 验收 7）：
// "等于关系是什么" 提取主题为 "等于关系"，不被 "等于什么" 规则误伤。
// "等于关系等于什么" 提取主题为 "等于关系"，阶段 4 剥尾部 "等于什么" 后
// 正确保留 "等于关系"。
//
// 实现保障：
// - TRAILING_QUESTION_SKELETON 按长度倒序匹配：`等于什么`(4) 优先于 `是什么`(3)。
// - 但 `endsWith('等于什么')` 必须严格匹配字符串末尾；
//   "等于关系是什么" 末尾是 "是什么" 不是 "等于什么"，不会被 `等于什么` 误剥。
// - 阶段 4 找到 `是什么` 剥除 → "等于关系"，阶段 5 也不再剥（"等于关系" 不以
//   任何修饰词结尾）。

describe('FR-02 §4 验收 7: 修饰词不误伤主题内部', () => {
  it('"等于关系是什么" → "等于关系"（"等于什么" 不误剥 "等于关系"）', () => {
    expect(extractCompleteTopic('等于关系是什么')).toBe('等于关系');
  });

  it('"等于关系等于什么" → "等于关系"', () => {
    expect(extractCompleteTopic('等于关系等于什么')).toBe('等于关系');
  });
});

// ---------------------------------------------------------------------------
// FR-02 §3 集成负责人：extractFollowupQueryPlan 共享契约
// ---------------------------------------------------------------------------
//
// 共享契约（FR-02 §3 集成负责人）：
// - `extractFollowupQueryPlan` 与 `extractCompleteTopic` 共用 5 阶段剥除实现；
//   `plan.exactTopic === extractCompleteTopic(q)` 是天然不变量。
// - MVP 阶段 `orderedTopic === exactTopic`（不展开为子 n-gram）。
// - 不在内部做长度 < 2 → 空 plan 的判断；让路由层 / transcript-retrieval 自行决定。

describe('FR-02 §3 集成负责人: extractFollowupQueryPlan 共享契约', () => {
  it('"维林娜一命好吗" → 完整 plan 字段', () => {
    expect(extractFollowupQueryPlan('维林娜一命好吗')).toEqual({
      exactTopic: '维林娜一命',
      orderedTopic: '维林娜一命',
      originalQuestion: '维林娜一命好吗',
    });
  });

  it('"火电补偿倍率等于什么" → exactTopic = orderedTopic = "火电补偿倍率"', () => {
    const plan = extractFollowupQueryPlan('火电补偿倍率等于什么');
    expect(plan.exactTopic).toBe('火电补偿倍率');
    expect(plan.orderedTopic).toBe('火电补偿倍率');
    expect(plan.originalQuestion).toBe('火电补偿倍率等于什么');
  });

  it('空字符串 → 空 plan（{ exactTopic: "", orderedTopic: "", originalQuestion: "" }）', () => {
    expect(extractFollowupQueryPlan('')).toEqual({
      exactTopic: '',
      orderedTopic: '',
      originalQuestion: '',
    });
  });

  it('单字主题 → 仍返回 plan（路由层判断长度 < 2 走 global）', () => {
    // "X 是什么" 剥后剩 "X"（单字）—— plan 必须仍返回，路由层判断长度 < 2 走 global。
    const plan = extractFollowupQueryPlan('X 是什么');
    expect(plan).toEqual({
      exactTopic: 'x',
      orderedTopic: 'x',
      originalQuestion: 'X 是什么',
    });
    // 关键不变量：plan.exactTopic 长度 < 2 但 plan 不为空，让路由层自行判断。
    expect(plan.exactTopic.length).toBeLessThan(2);
    expect(plan.orderedTopic.length).toBeLessThan(2);
  });

  it('不变量：plan.exactTopic === extractCompleteTopic(q) 对所有用例', () => {
    // 共享契约的核心不变量 —— 复用 extractCompleteTopic 的实现保证天然成立。
    const cases = [
      '维林娜一命好吗',
      '火电补偿倍率等于什么',
      '火电补偿倍率怎么算',
      '维林娜一命好不好',
      '维林娜一命值不值得',
      '等于关系是什么',
      '等于关系等于什么',
      'AI 是什么',
      '鲁迅是谁',
      '维琳娜一命到底有什么效果',
      '具体方法是什么',
      '',
    ];
    for (const q of cases) {
      const plan = extractFollowupQueryPlan(q);
      expect(plan.exactTopic, `case: ${q}`).toBe(extractCompleteTopic(q));
      // MVP 阶段：orderedTopic === exactTopic（不展开为子 n-gram）。
      expect(plan.orderedTopic, `case: ${q}`).toBe(plan.exactTopic);
      // originalQuestion 保留原文（空字符串情况已在前面单独断言）。
      if (q) {
        expect(plan.originalQuestion, `case: ${q}`).toBe(q);
      }
    }
  });

  it('extractFollowupQueryPlan 不影响既有 extractCompleteTopic / extractQueryTokens 行为', () => {
    // 既有用例（QA3 / QA4 / QA5 / FR-01）继续通过 —— extractFollowupQueryPlan
    // 是新增 API，不修改既有函数。
    expect(extractCompleteTopic('维林娜一命好吗')).toBe('维林娜一命');
    expect(extractCompleteTopic('AI 是什么')).toBe('ai');
    expect(extractQueryTokens('AI 是什么')).toEqual(['ai']);
    expect(extractQueryTokens('维林娜一命好吗')).toEqual(['维林娜一命']);
  });
});
