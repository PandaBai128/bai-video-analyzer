import type { VideoContextPackage } from './video-context-package';
import {
  detectAmbiguousCurrentSegmentIntent,
  detectExplicitCurrentSegmentIntent,
  detectSelectedSegmentIntent,
  isGlobalIntentQuestion,
} from './intent-detection';
import {
  buildCurrentSegmentContext,
  buildExplicitTimeContext,
  buildGlobalContext,
  buildKeywordContext,
  buildQuestionMatchContext,
  buildSelectedTimestampContext,
  buildTimelineMatchContext,
  findTimelineMatches,
} from './followup-context-builders';
import {
  hasReliableQueryHit,
  scoreQuestionMatchHits,
  type TranscriptMatchKind,
} from './transcript-retrieval';
import { extractFollowupQueryPlan } from './followup-query-topic';

/**
 * 上下文选择器 —— 公共入口。
 *
 * 拆 4 个职责模块（SG-05B）：
 * - intent-detection.ts：意图识别
 * - transcript-retrieval.ts：完整主题词 substring 评分（SG-05B）+ 相邻字幕窗口匹配（FR-01 §3A）/ 命中窗口 / 字符预算
 * - transcript-sampling.ts：全片均匀采样 / 字符预算
 * - followup-context-builders.ts：各 scope 上下文组装
 *
 * 本文件只承担"公开类型 + 路由 + 时间点 / 关键词触发词解析"职责。
 */

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/**
 * 上下文选择器输出：把"给 LLM 的上下文"切分成不同角色。
 *
 * 几个字段互相不重叠：
 * - `primaryScope` 给前端展示"这段在指代什么"（决定 Prompt 怎么写）
 * - `selectedTimelineItems` / `selectedTranscriptCues` 是真正喂给 LLM 的内容
 * - `reviewSummary` / `overviewLine` 是给 LLM 的全局锚点
 * - `matchInfo.keywordMatch` 是 "X 是否提到" 类问题的轻量搜索结果
 */
export type FollowupScope =
  /** 用户问题里含 mm:ss / hh:mm:ss 时间点，按 ±30s/~90s 取字幕 + 覆盖该时间的章节 */
  | 'explicit_time'
  /** 用户在时间线选中过节点，优先取该节点 */
  | 'selected_segment'
  /** "结合当前播放位置"开关打开，取当前播放时间覆盖的章节/字幕 */
  | 'current_segment'
  /** 命中"有没有提到 X"等关键词，给命中片段 */
  | 'keyword_match'
  /** 字幕未直接命中，但时间线/章节标题或摘要命中主题，用时间线作为定位证据 */
  | 'timeline_match'
  /**
   * 普通事实问题的全字幕检索（SG-05B §3）。
   *
   * 与 keyword_match 的关键差异：
   * - 触发器不同：question_match 走完整主题词 substring 评分（覆盖"维琳娜一命效果是什么"
   *   等无关键词触发词的问题，FR-01 §3A 扩展为单条 + 1-3 条相邻字幕窗口）；
   *   keyword_match 走"有没有提到 X"模板。
   * - 否认语义不同：question_match 无可靠命中**不**返回"未在上下文中提到"，
   *   路由层直接回落 global。keyword_match 无命中返回 hitCount=0，但只表达
   *   "完整字幕精确字面未命中"，prompt 不得直接等同为"视频没讲"。
   */
  | 'question_match'
  /** 全视频上下文：metadata + 时间线摘要 + 复盘摘要 + 全片代表性字幕 */
  | 'global';

export interface FollowupContext {
  readonly primaryScope: FollowupScope;
  readonly selectedTimelineItems: readonly import('@core/types').TimelineNode[];
  readonly selectedTranscriptCues: readonly import('@core/types').SubtitleCue[];
  readonly selectedChapters: readonly import('@core/types').VideoChapter[];
  readonly reviewSummary: string;
  readonly overviewLine: string;
  readonly matchInfo?: {
    readonly keyword: string;
    readonly hitCount: number;
    readonly hitTimestamps: readonly number[];
    /**
     * FR-02 §3 集成接线：question_match 命中层级（exact / ordered_coverage /
     * one_edit），prompt 按此选用户可见话术。
     */
    readonly matchKind?: TranscriptMatchKind;
    /**
     * FR-02 §3 集成接线：用户原始问题原文。prompt 用 "你说的 `X` 可能对应……"
     * 话术时回引。
     */
    readonly originalQuestion?: string;
  };
  /**
   * 当前回答应当聚焦的"锚点时间"（秒）。
   *
   * 构造规则（与 primaryScope 一一对应；fallback 类型不会有 anchor）：
   * - `explicit_time` → 用户在问题里写的 mm:ss / hh:mm:ss
   * - `selected_segment` → 用户点选的时间线节点时间
   * - `current_segment` → 当前播放时间
   * - `keyword_match` / `question_match` / `global` → 不设 anchor（不强制 LLM 围绕特定时间点）
   *
   * 这个字段驱动 prompt 里的 `<focus_anchor>` 块。
   */
  readonly anchorTimestamp?: number;
  readonly anchorLabel?: 'explicit_time' | 'selected_timestamp' | 'current_time';
  /**
   * Round 16 必修 1：当前窗口（explicit_time / selected_segment / current_segment）
   * 没命中字幕时是否走了"最近 cue 兜底"。为 true 时 prompt 标注"附近字幕兜底"，
   * 让 LLM 知道这条 cue 离 anchor 较远、不要强求和 anchor 完全对齐。
   */
  readonly transcriptFallback?: boolean;
  /**
   * SG-05B §4：global scope 上下文来源。
   *
   * 仅当 `primaryScope === 'global'` 时有值；其它 scope 不用关心。
   *
   * SG-05B 后：global 统一走 transcript_only 全片均匀采样（删除"有派生分析就只取
   * 前 8 条字幕"分支），所以 `globalContextMode` 总是 `'transcript_only'`。
   * 字段保留是为 prompt 显式标注上下文来源 + 未来扩展。
   */
  readonly globalContextMode?: 'derived_analysis' | 'transcript_only';
}

export interface SelectFollowupContextInput {
  readonly question: string;
  readonly contextPackage: VideoContextPackage;
  readonly currentTime?: number;
  readonly selectedTimestamp?: number;
  /**
   * Round 17 必修 A：固定问题（如"解释当前片段"）携带的强制锚点信号。
   * 为 true 时跳过意图识别和"结合当前播放位置"开关，直接走 current_segment。
   */
  readonly forceCurrentSegment?: boolean;
  /**
   * "结合当前播放位置" 开关。默认 true。
   *
   * Round 17 必修 A 调整语义：它现在只代表"允许在需要时结合当前播放位置"，
   * 不再代表"所有问题都无脑走当前片段"。具体触发逻辑见 selectFollowupContext()。
   */
  readonly includeCurrentSegment?: boolean;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * 选追问上下文。
 *
 * 优先级（SG-05B）：
 *   1. 用户问题里的明确时间点 (`explicit_time`)
 *   2. **forceCurrentSegment**（"解释当前片段"快捷问题携带的强制锚点）
 *   3. **明确 selected intent + selectedTimestamp**（`detectSelectedSegmentIntent` 命中 + 有效 `selectedTimestamp`）→ `selected_segment`
 *   4. **明确 current intent**（`detectExplicitCurrentSegmentIntent` 命中 + `currentTime` 有效）→ `current_segment`
 *   5. **ambiguous current intent**（`detectAmbiguousCurrentSegmentIntent` 命中 + `currentTime` 有效）→ `current_segment`
 *   6. **`selectedTimestamp` 兜底**（caller 显式传 `selectedTimestamp` 但 selected intent 未命中 + current intent 未命中）→ `selected_segment`
 *   7. 关键词命中 (`keyword_match`，"有没有提到 X")
 *   8. **普通事实问题全字幕检索**（`question_match`）—— SG-05B 新增；
 *      无可靠命中回落 global（**不**产生"完整字幕零命中"否认信号）
 *   9. 全视频上下文 (`global`)
 */
export function selectFollowupContext(input: SelectFollowupContextInput): FollowupContext {
  const question = input.question ?? '';
  const pkg = input.contextPackage;
  const hasTranscriptCues = pkg.transcriptCues.length > 0;

  // 1. 显式时间点
  const explicitTime = parseExplicitTimestamp(question);
  if (explicitTime !== null) {
    return buildExplicitTimeContext(pkg, explicitTime);
  }

  // 2. forceCurrentSegment
  if (
    input.forceCurrentSegment === true &&
    typeof input.currentTime === 'number' &&
    Number.isFinite(input.currentTime)
  ) {
    return buildCurrentSegmentContext(pkg, input.currentTime);
  }

  // 3. 明确 selected intent + selectedTimestamp
  if (
    typeof input.selectedTimestamp === 'number' &&
    Number.isFinite(input.selectedTimestamp) &&
    detectSelectedSegmentIntent(question)
  ) {
    return buildSelectedTimestampContext(pkg, input.selectedTimestamp);
  }

  // 4. 明确 current intent
  if (typeof input.currentTime === 'number' && Number.isFinite(input.currentTime)) {
    if (detectExplicitCurrentSegmentIntent(question)) {
      return buildCurrentSegmentContext(pkg, input.currentTime);
    }
  }

  // 5. ambiguous current intent
  if (typeof input.currentTime === 'number' && Number.isFinite(input.currentTime)) {
    if (detectAmbiguousCurrentSegmentIntent(question)) {
      return buildCurrentSegmentContext(pkg, input.currentTime);
    }
  }

  // 6. selectedTimestamp 兜底
  if (
    typeof input.selectedTimestamp === 'number' &&
    Number.isFinite(input.selectedTimestamp)
  ) {
    return buildSelectedTimestampContext(pkg, input.selectedTimestamp);
  }

  // 7. 关键词命中 ("有没有提到 X")
  const keyword = hasTranscriptCues ? extractKeywordAfterProbe(question) : null;
  if (keyword) {
    const keywordContext = buildKeywordContext(pkg, keyword);
    if ((keywordContext.matchInfo?.hitCount ?? 0) > 0) {
      return keywordContext;
    }
    const keywordPlan = {
      exactTopic: normalizeKeywordForPlan(keyword),
      orderedTopic: normalizeKeywordForPlan(keyword),
      originalQuestion: question,
    };
    if (keywordPlan.exactTopic.length >= 2) {
      const scored = scoreQuestionMatchHits(pkg.transcriptCues, keywordPlan);
      if (hasReliableQueryHit(scored)) {
        return buildQuestionMatchContext({ pkg, scored, plan: keywordPlan });
      }
    }
    const timelineMatches = findTimelineMatches(pkg, keyword);
    if (timelineMatches.timeline.length || timelineMatches.chapters.length) {
      return buildTimelineMatchContext({ pkg, topic: keyword, matches: timelineMatches });
    }
    return keywordContext;
  }

  // 8. 普通事实问题全字幕检索（SG-05B §3 + FR-01 §3A + FR-02 §3）
  //    无可靠命中 → 回落 global（不进入 buildQuestionMatchContext，
  //    也不在 prompt 里出现"完整字幕零命中"否认信号）
  //    SG-05B QA1 修复要求 B：先过 isGlobalIntentQuestion 闸门——全局 / 概览
  //    类问题（如"这个视频主要讲什么"）必须直接落 global，**不**进入 question_match
  //    评分（避免问句骨架词被完整主题词 substring 评分误判为命中）。
  //    FR-01 §3A：scoreQuestionMatchHits 评单条 cue + 1-3 条 cue 窗口
  //    （相邻 ≤ 3s）；
  //    FR-02 §3：plan.exactTopic ≥ 2 才进入三层容错匹配，避免单字 / 空 plan
  //    触发误命中；buildQuestionMatchContext 内部对命中按 size 优先 + 时间升序去重。
  if (hasTranscriptCues && !isGlobalIntentQuestion(question)) {
    const plan = extractFollowupQueryPlan(question);
    if (plan.exactTopic.length >= 2) {
      const scored = scoreQuestionMatchHits(pkg.transcriptCues, plan);
      if (hasReliableQueryHit(scored)) {
        return buildQuestionMatchContext({ pkg, scored, plan });
      }
      const timelineMatches = findTimelineMatches(pkg, plan.exactTopic);
      if (timelineMatches.timeline.length || timelineMatches.chapters.length) {
        return buildTimelineMatchContext({ pkg, topic: plan.exactTopic, matches: timelineMatches });
      }
    }
  }

  // 9. global 兜底
  return buildGlobalContext(pkg);
}

// ---------------------------------------------------------------------------
// 公开时间点 / 关键词触发词解析
// ---------------------------------------------------------------------------

/**
 * 抽出问题里的"明确时间点"。支持 `mm:ss` 和 `hh:mm:ss`。
 * 也接受 "1:02:11 这段" / "12:30 前后" 这种把时间点放在句首/句中。
 *
 * 返回秒数（无匹配返回 null）。
 */
export function parseExplicitTimestamp(question: string): number | null {
  if (!question) {
    return null;
  }
  // 顺序：先匹配 hh:mm:ss（要求第一段 > 0），再匹配 mm:ss
  const hhMatch = question.match(/(?<!\d)(\d{1,2}):([0-5]?\d):([0-5]?\d)\b/);
  if (hhMatch) {
    const h = Number.parseInt(hhMatch[1] ?? '0', 10);
    const m = Number.parseInt(hhMatch[2] ?? '0', 10);
    const s = Number.parseInt(hhMatch[3] ?? '0', 10);
    if (h >= 0 && m >= 0 && s >= 0) {
      return h * 3600 + m * 60 + s;
    }
  }
  const mmMatch = question.match(/(?<!\d)(\d{1,3}):([0-5]?\d)\b/);
  if (mmMatch) {
    const m = Number.parseInt(mmMatch[1] ?? '0', 10);
    const s = Number.parseInt(mmMatch[2] ?? '0', 10);
    if (m >= 0 && s >= 0) {
      return m * 60 + s;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 关键词触发词（"有没有提到 X"）
// ---------------------------------------------------------------------------

/**
 * 关键词触发词。
 *
 * 关键：把"更具体的复合触发词"放最前面，因为 JS regex alternation 是从左到右
 * 贪心匹配——如果"提到"排在"提到了"前面，会先吞掉"提到"留下"了"作为关键词。
 */
const KEYWORD_PROBE_PATTERN =
  /(?:有没有[提到讲到说过提讲]|是否[提到讲到说过提讲]|讲没讲[了过的]?|提到了|讲到了|说到了|提到了吗|讲到了吗|说到了吗|有没有[提讲]?了?|提到|讲到|说到)/u;
const NEGATED_KEYWORD_PROBE_PATTERN =
  /^(?:难道)?(?:没有(?:提到|讲到|说到|提过|讲过|说过|提|讲|说)?|没(?:有)?(?:提到|讲到|说到|提过|讲过|说过|提|讲|说)?)/u;

/**
 * "有没有提到 X / 是否讲了 X" 这类问题里抽出关键词。
 * 不做中文分词；用启发式：
 * - 取问号 / 逗号之前、关键词触发词之后的一段连续中文（和 ASCII 单词）
 * - 剥掉自然问法尾部的"吗 / 哪里 / 什么"等问句壳
 * - 长度 1-32 字；单字中文只在显式"是否提到 X"问法里允许
 *
 * 没匹配到或太短（< 2 字，且不是单字中文）返回 null。
 */
export function extractKeywordAfterProbe(question: string): string | null {
  if (!question) {
    return null;
  }
  const probeMatch = question.match(KEYWORD_PROBE_PATTERN) ??
    question.match(NEGATED_KEYWORD_PROBE_PATTERN);
  if (!probeMatch || typeof probeMatch.index !== 'number') {
    return null;
  }
  let after = question.slice(probeMatch.index + probeMatch[0].length);
  // 跳过 "了/过/的/是/吗/到" 等助词 / 介词
  after = stripKeywordQuestionShell(after.replace(/^[了过的吗是的到]+/u, ''));
  if (!after) {
    return null;
  }
  // ASCII 技术词常带空格（如 "computer use"）。这里按英文原词精确保留，
  // 不做中英文别名映射；字幕没出现该英文串就应保持未命中。
  const asciiPhraseMatch = after.match(/^[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*){0,4}/u);
  const tokenMatch = asciiPhraseMatch ?? after.match(/^[\p{Letter}\p{Number}_]+/u);
  if (!tokenMatch) {
    return null;
  }
  const token = tokenMatch[0].replace(/\s+/g, ' ').trim();
  if (token.length < 2 && !isSingleHanKeyword(token)) {
    return null;
  }
  return token.slice(0, 32);
}

const KEYWORD_TRAILING_QUESTION_WORDS: readonly string[] = [
  '有没有',
  '有吗',
  '了吗',
  '了么',
  '过吗',
  '过么',
  '是什么',
  '有什么',
  '什么',
  '哪里',
  '哪儿',
  '在哪',
  '哪',
  '啥',
  '吗',
  '么',
  '呢',
  '嘛',
  '呀',
  '啊',
  '吧',
];

function stripKeywordQuestionShell(text: string): string {
  let result = text
    .replace(/[？?，,。.!！；;：:].*$/u, '')
    .replace(/^[\s"'"\u201C\u201D\u2018\u2019《》【】()（）]+/u, '')
    .replace(/[\s"'"\u201C\u201D\u2018\u2019《》【】()（）]+$/u, '')
    .trim();
  const sorted = [...KEYWORD_TRAILING_QUESTION_WORDS].sort((a, b) => b.length - a.length);
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

function isSingleHanKeyword(token: string): boolean {
  return /^[\u3400-\u9fff]$/u.test(token);
}

function normalizeKeywordForPlan(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[\s,.!?:;()[\]{}"'"\u201C\u201D\u2018\u2019——–/\\]+/g, '')
    .replace(/[的了过着么呢吧嘛哈哦呀啊啦吗]/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// 公开辅助（re-export for backward compat）
// ---------------------------------------------------------------------------

export { pickRepresentativeCues } from './transcript-sampling';
export { hasDerivedAnalysis } from './followup-context-builders';
