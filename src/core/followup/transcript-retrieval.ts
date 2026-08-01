import type { SubtitleCue } from '@core/types';
import { isReliableToken, normalizeForMatching } from './followup-query-topic';
import type { FollowupQueryPlan } from './followup-query-topic';
import {
  isOneEditMatch,
  isOrderedCoverageMatch,
  orderedCoverageInsertionBudget,
  TOLERANT_MIN_TOPIC_LENGTH,
} from './transcript-retrieval-fuzzy';

// 公开 re-export —— 保持外部 API 一致（select-followup-context / 测试 / 文档）
export {
  isOneEditMatch,
  isOrderedCoverageMatch,
  orderedCoverageInsertionBudget,
  TOLERANT_MIN_TOPIC_LENGTH,
};

/**
 * 普通事实问题全字幕检索 —— 窗口 / 评分 / 去重 / 选择编排。
 *
 * 设计目标（SG-05B + FR-01 §3A + FR-02 §3）：
 * - 普通事实问题（"维琳娜一命效果是什么"）从全字幕窗口中找命中片段。
 * - 三层匹配：exact（最严格） → ordered_coverage → one_edit（最宽松），全局停止降级。
 * - 输出按时间升序，含 cue / 字符预算。
 *
 * 与 `keyword_match` 区分：
 * - `keyword_match` 走"有没有提到 X"模板 + 完整字幕精确 substring，
 *   无命中只表示字面未命中，不能直接推成"视频未提到"。
 * - 本模块走主题词 substring + 窗口 + 容错；无可靠命中由路由层回落 global，
 *   **不**产生"完整字幕零命中"否认信号。
 *
 * 拆分：
 * - 容错匹配：`transcript-retrieval-fuzzy`
 * - 主题提取 / 归一化：`followup-query-topic`
 */

// ---------------------------------------------------------------------------
// 字幕窗口（FR-01 §3A）
// ---------------------------------------------------------------------------

/**
 * 相邻 cue 的最大时间间隔（秒）。超过此间隔不允许合并窗口。
 *
 * 选 3s 的理由（FR-01 §3A）：
 * - 中长视频字幕每条 3-8s，3s 是"几乎无间隙"的保守阈值。
 * - 不会把"上个话题尾声"和"下个话题开头"误拼成命中。
 */
export const MAX_CUE_GAP_S = 3;

/**
 * 命中窗口：1-3 条相邻 cue 的滑动窗口。
 *
 * 关键不变量（FR-01 §3A）：
 * - 窗口内所有 cue 必须相邻（cue i.end 到 cue i+1.start 间隔 ≤ `MAX_CUE_GAP_S`）。
 * - 窗口大小 1 / 2 / 3。
 * - `cues` 是原始 cues（**不**拼接文本），用于上下文返回。
 * - `normalizedText` 是窗口内 cue 文本归一化后拼接（用于 substring / fuzzy 匹配）。
 */
export interface CueWindow {
  readonly cues: readonly SubtitleCue[];
  /** 窗口大小（1 / 2 / 3）。 */
  readonly size: 1 | 2 | 3;
  /** 窗口内最早的 cue.start。 */
  readonly startMin: number;
  /** 窗口内最晚的 cue.end（无 end 则用 cue.start）。 */
  readonly endMax: number;
  /** 窗口内文本经 `normalizeForMatching` 归一化后拼接。 */
  readonly normalizedText: string;
}

/**
 * 构建 1-3 条 cue 的滑动窗口。
 *
 * 算法：
 * 1. 单条 cue 各自构成 size=1 窗口。
 * 2. 滑动窗口 size=2：i 和 i+1 若 end[i] → start[i+1] 间隔 ≤ gapS，合并。
 * 3. 滑动窗口 size=3：在 size=2 基础上再扩一条，仍需相邻。
 * 4. 仅返回能合并的窗口；不连续的不返回。
 */
export function buildCueWindows(
  cues: readonly SubtitleCue[],
  gapS: number = MAX_CUE_GAP_S,
): readonly CueWindow[] {
  if (cues.length === 0) return [];
  const out: CueWindow[] = [];

  const endOf = (cue: SubtitleCue): number => cue.end ?? cue.start;

  for (const cue of cues) {
    out.push({
      cues: [cue],
      size: 1,
      startMin: cue.start,
      endMax: endOf(cue),
      normalizedText: normalizeForMatching(cue.text ?? ''),
    });
  }
  if (cues.length < 2) return out;

  for (let i = 0; i < cues.length - 1; i += 1) {
    const a = cues[i]!;
    const b = cues[i + 1]!;
    if (b.start - endOf(a) > gapS) continue;
    out.push({
      cues: [a, b],
      size: 2,
      startMin: a.start,
      endMax: endOf(b),
      normalizedText:
        normalizeForMatching(a.text ?? '') + normalizeForMatching(b.text ?? ''),
    });
  }
  if (cues.length < 3) return out;

  for (let i = 0; i < cues.length - 2; i += 1) {
    const a = cues[i]!;
    const b = cues[i + 1]!;
    const c = cues[i + 2]!;
    if (b.start - endOf(a) > gapS) continue;
    if (c.start - endOf(b) > gapS) continue;
    out.push({
      cues: [a, b, c],
      size: 3,
      startMin: a.start,
      endMax: endOf(c),
      normalizedText:
        normalizeForMatching(a.text ?? '') +
        normalizeForMatching(b.text ?? '') +
        normalizeForMatching(c.text ?? ''),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 匹配层级
// ---------------------------------------------------------------------------

/**
 * 匹配层级。
 * - `exact`：完整主题词 substring 直接命中（最严格）。
 * - `ordered_coverage`：主题字符按顺序在窗口中出现，允许中间插入少量字符（不允许乱序和缺失）。
 * - `one_edit`：编辑距离 ≤ 1 的近似匹配 + 锚点 ≥ 2 chars。
 */
export type TranscriptMatchKind = 'exact' | 'ordered_coverage' | 'one_edit';

/**
 * `matchKind` 排序权重（模块私有）—— 数字越小越优先。
 *
 * 私有原因（QA2 §1.3）：仅为 `scoreQuestionMatchHits` / `dedupeHitsBySize` 共享排序用，
 * 不暴露为公共 API。测试覆盖时验证具体 matchKind 字符串即可。
 */
const MATCH_KIND_RANK: Record<TranscriptMatchKind, number> = {
  exact: 0,
  ordered_coverage: 1,
  one_edit: 2,
};

/**
 * 一条命中：单条 cue 命中或 2-3 条 cue 窗口命中。
 *
 * 关键设计：
 * - `window` 保留命中的完整窗口信息（含所有 cues）—— `pickQuestionMatchCues` 把窗口
 *   内所有原始 cues 标为 core。
 * - `cue` 是窗口代表 cue（`window.cues[0]`）—— 向后兼容 `entry.cue.start`。
 * - `size` 用于 `dedupeHitsBySize` 排序（更小窗口优先）。
 * - `matchKind` —— `scoreHits` 恒为 `exact`，`scoreQuestionMatchHits` 按三层匹配结果填。
 */
export interface ScoredHit {
  readonly window: CueWindow;
  readonly cue: SubtitleCue;
  /** 命中 token 长度总和（同一 token 只算一次）。 */
  readonly score: number;
  /** 该命中"可靠" token 长度累计（`isReliableToken` 命中）。用于 `hasReliableQueryHit`。 */
  readonly reliableScore: number;
  readonly matchKind: TranscriptMatchKind;
}

// ---------------------------------------------------------------------------
// FR-01 §3A 命中评分：单条 cue + 1-3 条相邻窗口
// ---------------------------------------------------------------------------

/**
 * 用 query tokens 对 cues 评分（FR-01 §3A）：单条 cue + 2-3 条 cue 窗口都参与。
 *
 * 算法：
 * 1. `buildCueWindows(cues, gapS)` 生成 1-3 条 cue 滑动窗口。
 * 2. 每个窗口的 `normalizedText` 含某 token → `+token.length`（同一 token 只算一次）。
 * 3. 累计 `reliableScore`（仅 `isReliableToken` 命中），用于 `hasReliableQueryHit`。
 *
 * 返回：未去重的 `ScoredHit`，由 `dedupeHitsBySize` 处理重叠去重。
 */
export function scoreHits(
  cues: readonly SubtitleCue[],
  tokens: readonly string[],
  gapS: number = MAX_CUE_GAP_S,
): readonly ScoredHit[] {
  if (tokens.length === 0 || cues.length === 0) {
    return [];
  }
  const windows = buildCueWindows(cues, gapS);
  const hits: ScoredHit[] = [];
  for (const window of windows) {
    let score = 0;
    let reliable = 0;
    for (const token of tokens) {
      if (window.normalizedText.includes(token)) {
        score += token.length;
        if (isReliableToken(token)) {
          reliable += token.length;
        }
      }
    }
    if (score > 0) {
      hits.push({
        window,
        cue: window.cues[0]!,
        score,
        reliableScore: reliable,
        matchKind: 'exact',
      });
    }
  }
  return hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.window.startMin - b.window.startMin;
  });
}

/** 旧名别名（兼容历史调用方，新代码用 `scoreHits`）。 */
export const scoreCuesByQuery = scoreHits;

// ---------------------------------------------------------------------------
// FR-02 §3 + QA2 §A：三层容错匹配（全局停止降级）
// ---------------------------------------------------------------------------

/**
 * 把一组 ScoredHit 按 (kind, score, startMin) 稳定排序。
 *
 * 同一组内部排序：matchKind rank 升序 → score 倒序 → startMin 升序。
 */
function sortHitsByKindAndTime(hits: readonly ScoredHit[]): ScoredHit[] {
  return [...hits].sort((a, b) => {
    const rk = MATCH_KIND_RANK[a.matchKind] - MATCH_KIND_RANK[b.matchKind];
    if (rk !== 0) return rk;
    if (b.score !== a.score) return b.score - a.score;
    return a.window.startMin - b.window.startMin;
  });
}

/**
 * 三层容错评分（FR-02 §3 + QA2 §A 必修）：**全局停止降级**。
 *
 * 算法（QA2 §A 必修修复）：
 * 1. 对全部 windows 跑 exact；有命中 → **只**返回该层（不继续降级）。
 * 2. exact 全局零命中 → 跑 ordered_coverage；有命中 → 只返回该层。
 * 3. 前两层全零 → 跑 one_edit（兜底）。
 * 4. 一次返回集合中的 `matchKind` 必须完全一致。
 *
 * 关键不变量（与旧版"每 window 各自降级"的区别）：
 * - 跨窗口共享 cue 时只保留最严格层（`MATCH_KIND_RANK` 升序优先）。
 * - 全局 exact 命中时，远处 one_edit 候选**不会**进入结果（防止"维琳娜一命"
 *   远处 cue 在 exact 命中近处 cue 后被错误拼入）。
 *
 * 验收用例（QA2 §A 端到端竞争测试）：
 * - cue 10s "维琳娜一命"（one_edit 候选）+ cue 100s "维林娜一命"（exact 候选），
 *   问"维林娜一命好吗" → 只返回 100s exact，不含 10s。
 *
 * 输入契约：
 * - `plan.exactTopic`：exact 和 one_edit 的主题词。空 → 不参与评分。
 * - `plan.orderedTopic`：ordered_coverage 的主题词。空 → 跳过该层。
 *   MVP 阶段 orderedTopic === exactTopic（不展开为子 n-gram）。
 */
export function scoreQuestionMatchHits(
  cues: readonly SubtitleCue[],
  plan: FollowupQueryPlan,
  gapS: number = MAX_CUE_GAP_S,
): readonly ScoredHit[] {
  if (cues.length === 0) return [];
  const exactTopic = plan.exactTopic ?? '';
  const orderedTopic = plan.orderedTopic ?? '';
  if (!exactTopic && !orderedTopic) return [];

  const windows = buildCueWindows(cues, gapS);

  // 全局 exact 优先 —— 短路返回
  if (exactTopic) {
    const exactHits: ScoredHit[] = [];
    for (const window of windows) {
      if (window.normalizedText.includes(exactTopic)) {
        exactHits.push({
          window,
          cue: window.cues[0]!,
          score: exactTopic.length,
          reliableScore: exactTopic.length,
          matchKind: 'exact',
        });
      }
    }
    if (exactHits.length > 0) return sortHitsByKindAndTime(exactHits);
  }

  // 全局 ordered_coverage 兜底 —— 短路返回
  if (orderedTopic && orderedTopic.length >= TOLERANT_MIN_TOPIC_LENGTH) {
    const budget = orderedCoverageInsertionBudget(orderedTopic.length);
    const ocHits: ScoredHit[] = [];
    for (const window of windows) {
      const result = isOrderedCoverageMatch(
        window.normalizedText,
        orderedTopic,
        budget,
      );
      if (result.matched) {
        ocHits.push({
          window,
          cue: window.cues[0]!,
          score: orderedTopic.length,
          reliableScore: orderedTopic.length,
          matchKind: 'ordered_coverage',
        });
      }
    }
    if (ocHits.length > 0) return sortHitsByKindAndTime(ocHits);
  }

  // 全局 one_edit 兜底 —— 总是返回（即使空）
  if (exactTopic && exactTopic.length >= TOLERANT_MIN_TOPIC_LENGTH) {
    const oeHits: ScoredHit[] = [];
    for (const window of windows) {
      const result = isOneEditMatch(window.normalizedText, exactTopic);
      if (result.matched) {
        oeHits.push({
          window,
          cue: window.cues[0]!,
          score: exactTopic.length,
          reliableScore: exactTopic.length,
          matchKind: 'one_edit',
        });
      }
    }
    return sortHitsByKindAndTime(oeHits);
  }

  return [];
}

// ---------------------------------------------------------------------------
// FR-01 §3A 去重：跨层 + 共享 cue
// ---------------------------------------------------------------------------

/**
 * 去重重叠命中：同一位置产生多个重叠命中时，优先保留更严格匹配层级（`exact` >
 * `ordered_coverage` > `one_edit`）和更小命中窗口，最终按时间升序稳定排序。
 *
 * 算法：
 * 1. 按 `(MATCH_KIND_RANK 升序, size 升序, startMin 升序, endMax 升序)` 排序。
 * 2. 遍历，对每个 hit 检查其窗口的原始 cues 与已接受 hit 是否共享至少一个 cue
 *   （`cue.start` 相同）。
 * 3. 不共享 cue → 接受；共享 cue → 跳过（更严格层 / 更小窗口已先被接受）。
 * 4. 最终按 `(startMin 升序, endMax 升序, size 升序)` 排序返回。
 *
 * 关键不变量：
 * - **共享原始 cue** 才是真正的"同一位置重叠候选"。
 * - 时间区间重叠但不共享 cue 的独立命中必须全部保留。
 * - 跨层命中共享 cue 时优先保留更严格层（QA2 §1 全局停止降级后，
 *   同一集合内 matchKind 一致，跨层只在多集合合并时出现）。
 */
export function dedupeHitsBySize(hits: readonly ScoredHit[]): readonly ScoredHit[] {
  if (hits.length === 0) return [];

  const sorted = [...hits].sort((a, b) => {
    const rk = MATCH_KIND_RANK[a.matchKind] - MATCH_KIND_RANK[b.matchKind];
    if (rk !== 0) return rk;
    if (a.window.size !== b.window.size) return a.window.size - b.window.size;
    if (a.window.startMin !== b.window.startMin) {
      return a.window.startMin - b.window.startMin;
    }
    return a.window.endMax - b.window.endMax;
  });
  const accepted: ScoredHit[] = [];
  for (const hit of sorted) {
    let overlaps = false;
    for (const kept of accepted) {
      if (sharesOriginalCue(hit.window, kept.window)) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) accepted.push(hit);
  }
  return [...accepted].sort((a, b) => {
    if (a.window.startMin !== b.window.startMin) {
      return a.window.startMin - b.window.startMin;
    }
    if (a.window.endMax !== b.window.endMax) {
      return a.window.endMax - b.window.endMax;
    }
    return a.window.size - b.window.size;
  });
}

/** 两个命中窗口是否共享至少一个同一原始 cue（用 `cue.start` 作为唯一标识）。 */
function sharesOriginalCue(a: CueWindow, b: CueWindow): boolean {
  for (const ca of a.cues) {
    for (const cb of b.cues) {
      if (ca.start === cb.start) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 命中窗口 + 字符预算
// ---------------------------------------------------------------------------

/** 普通事实问题检索：cue 数 / 字符预算。复用 transcript-sampling 的常量。 */
export const QUESTION_MATCH_MAX_HITS = 6;
export const QUESTION_MATCH_BEFORE_S = 12;
export const QUESTION_MATCH_AFTER_S = 20;
export const QUESTION_MATCH_MAX_CHARS = 6000;

/**
 * 从 scored 命中集合里取 top N，各核心命中分别扩展前后窗口，合并去重后按时间排序。
 *
 * 关键不变量（SG-05B QA1 / FR-01 §3A）：
 * - **核心命中 cue**：窗口命中的所有原始 cues 都属于 core。
 * - **各核心命中分别扩窗**：每条 hit 独立窗口 `[start-beforeS, end+afterS]`。
 * - **核心命中 cue 必保留**：字符预算下，先把 topHits 全部加入结果。
 */
export function pickQuestionMatchCues(
  scored: readonly ScoredHit[],
  cues: readonly SubtitleCue[],
  maxHits: number = QUESTION_MATCH_MAX_HITS,
  beforeS: number = QUESTION_MATCH_BEFORE_S,
  afterS: number = QUESTION_MATCH_AFTER_S,
  maxChars: number = QUESTION_MATCH_MAX_CHARS,
): readonly SubtitleCue[] {
  if (scored.length === 0 || cues.length === 0) return [];

  const topHits = scored.slice(0, maxHits);
  if (topHits.length === 0) return [];

  const coreStarts = new Set<number>();
  const collected = new Map<number, SubtitleCue>();
  for (const hit of topHits) {
    for (const cue of hit.window.cues) {
      coreStarts.add(cue.start);
      if (!collected.has(cue.start)) {
        collected.set(cue.start, cue);
      }
    }
  }

  const sortedHits = [...topHits].sort(
    (a, b) => a.window.startMin - b.window.startMin,
  );
  for (const hit of sortedHits) {
    const from = Math.max(0, hit.window.startMin - beforeS);
    const to = hit.window.endMax + afterS;
    for (const cue of cues) {
      const cueEnd = cue.end ?? cue.start;
      if (cueEnd >= from && cue.start <= to) {
        if (!collected.has(cue.start)) {
          collected.set(cue.start, cue);
        }
      }
    }
  }

  const allCues = [...collected.values()].sort((a, b) => a.start - b.start);
  return applyCharBudgetToCuesWithCore(allCues, coreStarts, maxChars);
}

/**
 * 按字符预算截断 cues —— 核心命中 cue 必保留，其他 cue 用剩余预算按时间顺序填。
 *
 * 核心 cue 公平份额（QA3 B 修复）：`floor(remaining / unprocessedTotal)` 平分剩余
 * 预算，避免"首 core 吃光所有预算、后续 core 只剩 1 字符"。
 *
 * 最终按 `start` 升序排序（即使内部按 cores-then-others 顺序填充）。
 */
export function applyCharBudgetToCuesWithCore(
  cues: readonly SubtitleCue[],
  coreStarts: ReadonlySet<number>,
  maxChars: number,
): readonly SubtitleCue[] {
  if (cues.length === 0) return [];
  const cores: SubtitleCue[] = [];
  const others: SubtitleCue[] = [];
  for (const cue of cues) {
    if (coreStarts.has(cue.start)) cores.push(cue);
    else others.push(cue);
  }
  cores.sort((a, b) => a.start - b.start);
  others.sort((a, b) => a.start - b.start);

  const out: SubtitleCue[] = [];
  let used = 0;
  for (let i = 0; i < cores.length; i += 1) {
    const cue = cores[i]!;
    const text = cue.text ?? '';
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const unprocessedTotal = cores.length - i;
    const fairShare = Math.max(1, Math.floor(remaining / unprocessedTotal));
    if (text.length <= fairShare) {
      out.push(cue);
      used += text.length;
    } else {
      out.push({
        start: cue.start,
        ...(cue.end !== undefined ? { end: cue.end } : {}),
        text: text.slice(0, fairShare),
      });
      used += fairShare;
    }
  }
  for (const cue of others) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const text = cue.text ?? '';
    if (text.length <= remaining) {
      out.push(cue);
      used += text.length;
    } else {
      out.push({
        start: cue.start,
        ...(cue.end !== undefined ? { end: cue.end } : {}),
        text: text.slice(0, remaining),
      });
      used = maxChars;
      break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// 可靠命中判定
// ---------------------------------------------------------------------------

/**
 * 是否有任何可靠命中 —— 普通事实问题检索路径用。
 *
 * 阈值：必须**至少一条** hit 命中"可靠" token（`reliableScore > 0`）。
 * - "维琳娜" / "苏格拉底" / "鲁迅" 等 2-3+ 字中文专名 → 通过。
 * - "RAG" / "API" / "GPT" 等 2+ 字符 ASCII 技术词/缩写 → 通过。
 * - "这个 / 视频 / 主要" 等通用问句骨架词（已被 `extractQueryTokens` 排除）→ 不参与评分。
 */
export function hasReliableQueryHit(scored: readonly ScoredHit[]): boolean {
  return scored.some((s) => s.reliableScore > 0);
}
