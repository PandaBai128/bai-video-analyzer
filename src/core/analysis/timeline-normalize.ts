import type { TimelineNode, VideoChapter } from '@core/types';

/**
 * Round 22 必修 B1+B2：时间线结构对齐的纯函数。
 *
 * 目标：
 * - 单一 timeline 来源：`chapters` 才是真理，timeline 由 chapters 派生
 * - 排序：chapters 按 timestamp 升序，每章 segments 按 timestamp 升序
 * - 范围校验：segment 必须落在 chapter `[timestamp, endTimestamp)` 内；
 *   越界则尝试移到覆盖它的 chapter；找不到则并入最近前一个 chapter，
 *   并扩展该 chapter 的 endTimestamp
 * - chapter.endTimestamp 至少覆盖最后 segment 的 endTimestamp
 * - 不做语义改写：不改 title / summary 文案
 *
 * 纯函数无副作用，方便单测。
 *
 * 实现要点：
 * - 纯函数不能 mutate 输入；用"两趟"法
 *   1. 第一趟：把每个 chapter 的 segments + 越界 segment 收集起来
 *   2. 第二趟：按"覆盖关系"决定每个 segment 归到哪个 chapter；chapter 顺序
 *      和 segment 顺序固定后写回。
 * - chapter.endTimestamp 的"扩展到覆盖越界 segment 的 endTimestamp"作为
 *   兜底逻辑：先把 segments 归位，再按 segments 的 endTimestamp 重新计算
 *   chapter.endTimestamp。
 */

export interface NormalizedTimeline {
  readonly chapters: readonly VideoChapter[];
  readonly timeline: readonly TimelineNode[];
}

export function normalizeChapterTimelineStructure(
  chaptersInput: readonly VideoChapter[],
  duration?: number,
): NormalizedTimeline {
  if (chaptersInput.length === 0) {
    return { chapters: [], timeline: [] };
  }

  // Step 1：先按 chapter.timestamp 升序排好，保留原 index 用来"找前一个 chapter"
  const indexedChapters = chaptersInput
    .map((chapter, originalIndex) => ({ chapter, originalIndex }))
    .sort((a, b) => a.chapter.timestamp - b.chapter.timestamp);

  // Step 2：收集所有 segments
  type Assignment = {
    readonly seg: TimelineNode;
    readonly fromOriginalIndex: number;
    readonly assignedChapterKey: string;
  };
  const assignments: Assignment[] = [];
  for (const { chapter, originalIndex } of indexedChapters) {
    for (const seg of chapter.segments) {
      const key = chapterKey(originalIndex);
      assignments.push({ seg, fromOriginalIndex: originalIndex, assignedChapterKey: key });
    }
  }

  // Step 3：每条 assignment 重新决定 chapter（基于排好序的 chapters 数组）
  const sortedChapters = indexedChapters.map((c) => c.chapter);
  const getEffectiveChapterEnd = (index: number): number | undefined => {
    const chapterEnd = sortedChapters[index]?.endTimestamp;
    const nextChapterStart = sortedChapters[index + 1]?.timestamp;
    if (typeof chapterEnd === 'number' && typeof nextChapterStart === 'number') {
      return Math.min(chapterEnd, nextChapterStart);
    }
    return typeof nextChapterStart === 'number' ? nextChapterStart : chapterEnd;
  };
  const findCoveringChapterIndex = (seg: TimelineNode): number => {
    for (let i = 0; i < sortedChapters.length; i += 1) {
      const ch = sortedChapters[i];
      if (!ch) {
        continue;
      }
      if (segmentInChapter(seg, ch.timestamp, getEffectiveChapterEnd(i))) {
        return i;
      }
    }
    return -1;
  };

  const finalAssignments = assignments.map(({ seg, fromOriginalIndex }) => {
    const coveringIdx = findCoveringChapterIndex(seg);
    if (coveringIdx >= 0) {
      const coveringCh = sortedChapters[coveringIdx];
      const targetOriginalIdx = coveringCh
        ? indexedChapters[coveringIdx]?.originalIndex ?? fromOriginalIndex
        : fromOriginalIndex;
      return { seg, targetOriginalIdx };
    }
    // 没人覆盖：并入"最近的前一个 chapter"（按排好序的位置）
    let prevIdx = -1;
    for (let i = sortedChapters.length - 1; i >= 0; i -= 1) {
      const ch = sortedChapters[i];
      if (!ch) {
        continue;
      }
      if (ch.timestamp <= seg.timestamp) {
        prevIdx = i;
        break;
      }
    }
    if (prevIdx < 0) {
      // 没有前一个 chapter：clamp 到第一个 chapter 的起点
      const firstCh = sortedChapters[0];
      const clamped: TimelineNode = firstCh
        ? { ...seg, timestamp: Math.max(seg.timestamp, firstCh.timestamp) }
        : seg;
      const targetOriginalIdx = firstCh
        ? indexedChapters[0]?.originalIndex ?? fromOriginalIndex
        : fromOriginalIndex;
      return { seg: clamped, targetOriginalIdx };
    }
    // 归到 prevIdx 对应 chapter（保留原 timestamp；该 chapter 的 endTimestamp
    // 会在 Step 4 扩展）。
    const targetOriginalIdx = indexedChapters[prevIdx]?.originalIndex ?? fromOriginalIndex;
    return { seg, targetOriginalIdx };
  });

  // Step 4：把 segments 按 chapter 归类
  const chapterSegments = new Map<number, TimelineNode[]>();
  for (const { seg, targetOriginalIdx } of finalAssignments) {
    const list = chapterSegments.get(targetOriginalIdx) ?? [];
    list.push(seg);
    chapterSegments.set(targetOriginalIdx, list);
  }

  // Step 5：构造最终 chapters
  const finalChapters: VideoChapter[] = indexedChapters.map(({ chapter, originalIndex }) => {
    const segs = (chapterSegments.get(originalIndex) ?? []).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    // 重新计算 chapter.endTimestamp：至少覆盖最后 segment 的 endTimestamp，
    // 但不超过下一个 chapter 起点
    const lastSegEnd = segs.length
      ? Math.max(
          ...segs
            .map((s) => (typeof s.endTimestamp === 'number' ? s.endTimestamp : s.timestamp))
            .filter((n) => Number.isFinite(n)),
        )
      : undefined;
    const originalChapterIdx = indexedChapters.findIndex((c) => c.originalIndex === originalIndex);
    const nextChapter = originalChapterIdx >= 0 ? sortedChapters[originalChapterIdx + 1] : undefined;
    const nextChapterStart = nextChapter?.timestamp;
    let newEnd: number | undefined = chapter.endTimestamp;
    if (typeof lastSegEnd === 'number') {
      newEnd = typeof newEnd === 'number' ? Math.max(newEnd, lastSegEnd) : lastSegEnd;
    }
    if (typeof nextChapterStart === 'number' && typeof newEnd === 'number') {
      newEnd = Math.min(newEnd, nextChapterStart);
    }
    return typeof newEnd === 'number'
      ? { ...chapter, endTimestamp: newEnd, segments: segs }
      : { ...chapter, segments: segs };
  });

  // Step 6：duration 裁剪
  let cappedChapters = finalChapters;
  if (typeof duration === 'number' && duration > 0) {
    cappedChapters = finalChapters
      .filter((chapter) => chapter.timestamp <= duration)
      .map((chapter) => {
        const endCap =
          typeof chapter.endTimestamp === 'number'
            ? Math.min(chapter.endTimestamp, duration)
            : undefined;
        const segs = chapter.segments
          .filter((seg) => seg.timestamp <= duration)
          .map((seg) =>
            typeof seg.endTimestamp === 'number'
              ? { ...seg, endTimestamp: Math.min(Math.max(seg.endTimestamp, seg.timestamp), duration) }
              : seg,
          );
        return typeof endCap === 'number' ? { ...chapter, endTimestamp: endCap, segments: segs } : { ...chapter, segments: segs };
      });
  }

  const scarceChapters = applyTimelineImportanceScarcity(cappedChapters);
  const timeline: TimelineNode[] = scarceChapters.flatMap((c) => c.segments);
  return { chapters: scarceChapters, timeline };
}

function chapterKey(originalIndex: number): string {
  return `c${originalIndex}`;
}

function segmentInChapter(
  segment: TimelineNode,
  chapterStart: number,
  chapterEnd: number | undefined,
): boolean {
  if (segment.timestamp < chapterStart) {
    return false;
  }
  if (typeof chapterEnd === 'number' && segment.timestamp >= chapterEnd) {
    return false;
  }
  return true;
}

export function applyTimelineImportanceScarcity(
  chapters: readonly VideoChapter[],
): readonly VideoChapter[] {
  if (chapters.length === 0) return [];

  const chapterLimit = getMustWatchChapterLimit(chapters.length);
  const mustWatchChapterIndexes = chapters
    .map((chapter, index) => ({ chapter, index, score: scoreTimelineItem(chapter) }))
    .filter(({ chapter }) => chapter.importance === 'must-watch')
    .sort((a, b) => b.score - a.score || a.chapter.timestamp - b.chapter.timestamp)
    .slice(0, chapterLimit)
    .map(({ index }) => index);
  const keepChapterIndexes = new Set(mustWatchChapterIndexes);

  return chapters.map((chapter, chapterIndex) => {
    const segments = applySegmentImportanceScarcity(chapter.segments);
    const importance =
      chapter.importance === 'must-watch' && !keepChapterIndexes.has(chapterIndex)
        ? 'recommended'
        : chapter.importance;
    return { ...chapter, importance, segments };
  });
}

function applySegmentImportanceScarcity(
  segments: readonly TimelineNode[],
): readonly TimelineNode[] {
  const mustWatchSegments = segments
    .map((segment, index) => ({ segment, index, score: scoreTimelineItem(segment) }))
    .filter(({ segment }) => segment.importance === 'must-watch')
    .sort((a, b) => b.score - a.score || a.segment.timestamp - b.segment.timestamp);
  const keepSegmentIndex = mustWatchSegments[0]?.index;

  return segments.map((segment, index) =>
    segment.importance === 'must-watch' && index !== keepSegmentIndex
      ? { ...segment, importance: 'recommended' }
      : segment,
  );
}

function getMustWatchChapterLimit(chapterCount: number): number {
  if (chapterCount <= 1) return chapterCount;
  return Math.max(1, Math.min(3, Math.floor(chapterCount * 0.3)));
}

function scoreTimelineItem(item: Pick<VideoChapter | TimelineNode, 'title' | 'summary'>): number {
  const text = `${item.title} ${item.summary}`;
  let score = 2;
  if (/核心|关键|重点|主线/u.test(text)) {
    score += 3;
  }
  if (/方法|框架|流程|步骤|实战|案例|项目|计划|体系|原则/u.test(text)) {
    score += 2;
  }
  if (/AGENTS|Skill|MCP|Codex|插件|配置|部署|工具/u.test(text)) {
    score += 1;
  }
  if (/广告|赞助|推广|闲聊|铺垫|过渡|背景/u.test(text)) {
    score -= 3;
  }
  return score;
}
