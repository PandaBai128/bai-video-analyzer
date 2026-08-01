import type { SubtitleCue } from '@core/types';

/**
 * 全片均匀采样 + 字符预算 —— 给 global scope / 普通事实问题检索做"全片代表性"选取。
 *
 * 设计目标（SG-05B §4）：
 * - 无论 timeline / chapters / review 是否存在，global 上下文都从全片确定性采样，
 *   覆盖开头、中段、结尾。
 * - 派生分析（时间线 + 复盘 + 章节）继续作为补充，**不**再单独走"前 8 条字幕"。
 * - 复用 transcript-retrieval 的字符预算常量（QUESTION_MATCH_MAX_CHARS =
 *   TRANSCRIPT_ONLY_MAX_CHARS = 8000 共享）。
 *
 * 不负责：
 * - 关键词命中 / 完整主题词 substring 评分 / 普通事实问题检索（含相邻字幕窗口）：transcript-retrieval
 * - 路由 / 上下文组装：select-followup-context / followup-context-builders
 */

/**
 * 全片字幕采样条数上限。约 1 小时视频、字幕密度 1 条/秒也够用；
 * 超过会让 token 暴涨。
 */
export const TRANSCRIPT_ONLY_MAX_CUES = 50;

/**
 * 全片字幕字符上限。8000 字符约 2000-3000 token，
 * 留出 prompt / 时间线 / 复盘 / 用户问题的预算。
 */
export const TRANSCRIPT_ONLY_MAX_CHARS = 8000;

/**
 * 全视频字幕采样。
 *
 * 算法：
 * 1. 按时间均匀分成 N 个桶（`N = min(TRANSCRIPT_ONLY_MAX_CUES, cues.length)`）；
 *    **每桶取 1 条**最接近桶中心时刻的 cue。
 * 2. 输出**按时间升序**排（不是按采样顺序），方便 LLM 阅读。
 * 3. 累计字符超 `TRANSCRIPT_ONLY_MAX_CHARS` 时截断（单条字幕特别长时保护 prompt）。
 *
 * 设计取舍：
 * - **不**做语义摘要 / 抽关键词 —— prompt 要求"基于上下文回答"，原文比摘要更稳。
 * - **不**优先头尾（用户问"结尾讲了什么"会漏掉中段）—— 均匀采样更通用。
 * - **不**随机（用户两次问同样的问题会拿到不同上下文）—— 确定性更好 debug。
 * - **不**取多条连续 cue —— 多条连续会破坏"全片均匀覆盖"的目标（开头桶一旦命中
 *   几条连读 cue，就不再覆盖中段/结尾）。
 *
 * @param cues 全部字幕（**不**做时间排序，caller 应保证 start 升序，但函数内部
 *             会再 sort 一遍保证稳定）
 * @param duration 视频总时长（秒，可选；不传则按 cues 总跨度估）
 */
export function pickRepresentativeCues(
  cues: readonly SubtitleCue[],
  duration?: number,
): readonly SubtitleCue[] {
  if (cues.length === 0) return [];

  // 防御：caller 不保证顺序 —— 排序后处理。
  const sorted = [...cues].sort((a, b) => a.start - b.start);

  // 总时长：优先用 pkg.duration；否则用最后一条 cue 的 end（或 start）。
  const effectiveDuration =
    typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? duration
      : Math.max(sorted[sorted.length - 1]?.end ?? 0, sorted[sorted.length - 1]?.start ?? 0, 1);

  // 桶数：min(MAX_CUES, cues.length)；至少 1 桶。
  const bucketCount = Math.min(TRANSCRIPT_ONLY_MAX_CUES, sorted.length);
  if (bucketCount <= 1) {
    // cue 很少，原样返回（排序后）。
    return applyCharBudget(sorted, TRANSCRIPT_ONLY_MAX_CHARS);
  }

  // 计算每桶时间范围；用"桶中心时刻 + 选 1 条最近 cue"的简化策略。
  const bucketWidth = effectiveDuration / bucketCount;
  const picked = new Map<number, SubtitleCue>();
  for (let i = 0; i < bucketCount; i += 1) {
    const bucketCenter = bucketWidth * (i + 0.5);
    const nearest = findNearestByStart(sorted, bucketCenter);
    if (nearest) {
      picked.set(nearest.start, nearest);
    }
  }

  const merged = [...picked.values()].sort((a, b) => a.start - b.start);
  return applyCharBudget(merged, TRANSCRIPT_ONLY_MAX_CHARS);
}

/**
 * 按字符预算截断：累计文本字符数超 maxChars 时保留前面的、丢尾部 cue。
 * 返回顺序与输入一致（输入应已升序）。
 *
 * 单条 cue 文本自身极长（例如 1 条 10000 字）也会被强制截到剩余预算，避免
 * 单条 cue 占满全部预算。
 */
export function applyCharBudget(
  cues: readonly SubtitleCue[],
  maxChars: number,
): readonly SubtitleCue[] {
  if (cues.length === 0) return [];
  let used = 0;
  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const text = cue.text ?? '';
    if (text.length <= remaining) {
      out.push(cue);
      used += text.length;
      continue;
    }
    // 单条 cue 极长：截断到剩余预算（保留原文前段）
    const truncated: SubtitleCue = {
      start: cue.start,
      ...(cue.end !== undefined ? { end: cue.end } : {}),
      text: text.slice(0, remaining),
    };
    out.push(truncated);
    used = maxChars;
    break;
  }
  return out;
}

/**
 * 在升序 cues 里找 start 最接近 target 的 cue。
 * 时间复杂度 O(n)；对 1 小时视频的字幕规模（数千条）仍可控。
 * 平局时保留更早的 cue，输出更稳定。
 */
export function findNearestByStart(
  sortedCues: readonly SubtitleCue[],
  target: number,
): SubtitleCue | null {
  if (sortedCues.length === 0) return null;
  let bestIdx = 0;
  let bestDiff = Math.abs(sortedCues[0]!.start - target);
  for (let i = 1; i < sortedCues.length; i += 1) {
    const d = Math.abs(sortedCues[i]!.start - target);
    if (d < bestDiff) {
      bestDiff = d;
      bestIdx = i;
    } else if (d === bestDiff) {
      // 平局：保留更早的（更稳定）
      break;
    }
  }
  return sortedCues[bestIdx] ?? null;
}

// ---------------------------------------------------------------------------
// 范围挑选工具 —— 给 explicit_time / current_segment / selected_segment scope 用
// ---------------------------------------------------------------------------

/**
 * Round 16 必修 1 字幕窗口兜底：
 * 1. 主窗口已有 cue → 直接用，不算兜底；
 * 2. 主窗口 0 cue + pkg.transcriptCues 非空 → 走"离 anchor 最近的 N 条"；
 * 3. 全视频都没有 cue（视频本身没字幕） → 返回空，不算兜底，
 *    让 prompt 显式告诉 LLM "附近没有字幕"。
 *
 * 兜底 cue 按距离 anchor 升序排；如果两侧数量都不够，把对侧也带上，保持时间顺序。
 */
export function applyTranscriptFallback(
  pkgCues: readonly SubtitleCue[],
  primaryRange: readonly SubtitleCue[],
  anchor: number,
  min: number,
  max: number,
): { readonly cues: readonly SubtitleCue[]; readonly fallback: boolean } {
  if (primaryRange.length > 0) {
    return { cues: primaryRange, fallback: false };
  }
  if (pkgCues.length === 0) {
    return { cues: [], fallback: false };
  }
  const nearest = pickCuesNearest(pkgCues, anchor, max, min);
  return { cues: nearest, fallback: true };
}

/**
 * 找离 anchor 最近的 N 条 cue，按时间升序排。
 *
 * 策略：先按绝对距离排序取 N 条；如果两侧（anchor 前 / 后）有偏，优先填少的一侧
 * ——避免 anchor = 100s、cues 都在 0-50s 时返回的全是"之前"，LLM 看不到后面
 * 仍然相关的内容。
 */
export function pickCuesNearest(
  cues: readonly SubtitleCue[],
  anchor: number,
  max: number,
  min: number,
): readonly SubtitleCue[] {
  if (cues.length === 0) {
    return [];
  }
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  // 双指针：先 anchor 之前最近的 N/2，anchor 之后最近的 N - N/2
  const beforeCount = Math.max(min, Math.ceil(max / 2));
  const afterCount = Math.max(min, max - beforeCount);
  const beforeIdx = lastIndexBefore(sorted, anchor);
  const afterIdx = firstIndexAtOrAfter(sorted, anchor);
  const beforeSlice = sorted.slice(Math.max(0, beforeIdx - beforeCount + 1), beforeIdx + 1);
  const afterSlice = sorted.slice(afterIdx, afterIdx + afterCount);
  const merged = [...beforeSlice, ...afterSlice].sort((a, b) => a.start - b.start);
  return merged.slice(0, max);
}

export function lastIndexBefore(sorted: readonly SubtitleCue[], anchor: number): number {
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i]!.start <= anchor) {
      return i;
    }
  }
  return -1;
}

export function firstIndexAtOrAfter(sorted: readonly SubtitleCue[], anchor: number): number {
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i]!.start >= anchor) {
      return i;
    }
  }
  return sorted.length;
}

export function pickCuesInRange(
  cues: readonly SubtitleCue[],
  from: number,
  to: number,
): readonly SubtitleCue[] {
  return cues.filter((cue) =>
    cue.end === undefined
      ? cue.start >= from && cue.start <= to
      : cue.end >= from && cue.start <= to,
  );
}

export function pickChaptersCovering(
  chapters: readonly import('@core/types').VideoChapter[],
  timestamp: number,
): readonly import('@core/types').VideoChapter[] {
  return chapters.filter((chapter) => {
    const end = chapter.endTimestamp ?? Number.POSITIVE_INFINITY;
    return timestamp >= chapter.timestamp && timestamp < end;
  });
}

export function pickTimelineCovering(
  timeline: readonly import('@core/types').TimelineNode[],
  timestamp: number,
): readonly import('@core/types').TimelineNode[] {
  const idx = timeline.findIndex((node, i) => {
    const next = timeline[i + 1];
    return timestamp >= node.timestamp && (!next || timestamp < next.timestamp);
  });
  if (idx < 0) {
    return [];
  }
  return [timeline[idx]!];
}
