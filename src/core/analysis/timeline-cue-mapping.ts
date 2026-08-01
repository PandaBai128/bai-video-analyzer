import type { SubtitleCue, TimelineNode, VideoChapter } from '@core/types';

/**
 * Round 23 必修 A：cue id 映射后，缺时间依据时**抛错**而不是 silent 0。
 *
 * 设计：
 * - 输入 chapter / segment 数组（带可选 `startCueId` / `endCueId`）和完整字幕列表
 * - 对每个 chapter / segment：
 *   - 优先用 `startCueId` / `endCueId` 映射回 `subtitles[id].start` / `subtitles[id].end ?? start`
 *   - 缺 cue id 时 fallback 到模型自报的 `timestamp` / `endTimestamp`（向后兼容）
 *   - **以 cue id 为准**（即使模型同时给了 timestamp）—— 防止模型把 0:39 标成 0:50 才开始的主题
 * - 如果 chapter / segment **两个**时间依据都没有（既无合法 cue id 也无 timestamp），
 *   抛 `MissingTimeAnchorError`，让上层给出清晰错误而不是默默填 0。
 * - subtitles 为空时：cue id 映射跳过，仍要求至少要有 timestamp（旧 schema 兼容）
 * - 纯函数无副作用，方便单测。
 *
 * 端点约定：endCueId 对应字幕的"结束时间"——这样 segment 的时间范围是
 * `[startCue.start, endCue.end]`，覆盖 startCue 到 endCue 的所有字幕。
 *
 * 关键不变量（单测覆盖）：
 * - 纯 cue-only 输入（startCueId 合法、无 timestamp）→ 最终 timestamp 来自 cue
 * - cue id 优先于 timestamp
 * - 缺 cue id + 缺 timestamp + 无 subtitles → 抛错（不再 silent 0）
 * - 旧 schema（仅 timestamp）→ 仍生效
 */

export interface MappedChapter {
  readonly timestamp: number;
  readonly endTimestamp?: number | undefined;
  readonly title: string;
  readonly summary: string;
  readonly importance: VideoChapter['importance'];
  readonly contentTag?: VideoChapter['contentTag'] | undefined;
  readonly watchGuide: string;
  readonly reflectionPrompt?: string | undefined;
  readonly segments: readonly MappedSegment[];
}

export interface MappedSegment {
  readonly timestamp: number;
  readonly endTimestamp?: number | undefined;
  readonly title: string;
  readonly summary: string;
  readonly importance: TimelineNode['importance'];
  readonly contentTag?: TimelineNode['contentTag'] | undefined;
  readonly reasoning?: string | undefined;
  readonly watchPrompt?: string | undefined;
}

export interface RawChapterInput {
  readonly timestamp?: number | undefined;
  readonly endTimestamp?: number | undefined;
  readonly title: string;
  readonly summary: string;
  readonly importance: VideoChapter['importance'];
  readonly contentTag?: VideoChapter['contentTag'] | undefined;
  readonly watchGuide: string;
  readonly reflectionPrompt?: string | undefined;
  readonly startCueId?: number | undefined;
  readonly endCueId?: number | undefined;
  readonly segments: readonly RawSegmentInput[];
}

export interface RawSegmentInput {
  readonly timestamp?: number | undefined;
  readonly endTimestamp?: number | undefined;
  readonly title: string;
  readonly summary: string;
  readonly importance: TimelineNode['importance'];
  readonly contentTag?: TimelineNode['contentTag'] | undefined;
  readonly reasoning?: string | undefined;
  readonly watchPrompt?: string | undefined;
  readonly startCueId?: number | undefined;
  readonly endCueId?: number | undefined;
}

export class MissingTimeAnchorError extends Error {
  readonly contextLabel: string;
  readonly chapterIndex: number | null;
  readonly segmentIndex: number | null;
  constructor(input: {
    readonly message: string;
    readonly contextLabel: string;
    readonly chapterIndex: number | null;
    readonly segmentIndex: number | null;
  }) {
    super(input.message);
    this.name = 'MissingTimeAnchorError';
    this.contextLabel = input.contextLabel;
    this.chapterIndex = input.chapterIndex;
    this.segmentIndex = input.segmentIndex;
  }
}

export function mapCueIdsToTimestamps(input: {
  readonly chapters: readonly RawChapterInput[];
  readonly subtitles?: readonly SubtitleCue[];
}): MappedChapter[] {
  const hasSubtitles = !!input.subtitles && input.subtitles.length > 0;
  return input.chapters.map((chapter, chapterIndex) => {
    const { timestamp: chapterStart, endTimestamp: chapterEnd } = resolveChapterTimes({
      chapter,
      hasSubtitles,
      subtitles: input.subtitles,
      chapterIndex,
      segmentIndex: null,
      contextLabel: 'chapter',
    });

    const segments = chapter.segments.map((segment, segmentIndex) => {
      const { timestamp, endTimestamp } = resolveSegmentTimes({
        segment,
        hasSubtitles,
        subtitles: input.subtitles,
        chapterIndex,
        segmentIndex,
      });
      const base: MappedSegment = {
        timestamp,
        title: segment.title,
        summary: segment.summary,
        importance: segment.importance,
      };
      return {
        ...base,
        ...(segment.contentTag ? { contentTag: segment.contentTag } : {}),
        ...(typeof endTimestamp === 'number' ? { endTimestamp } : {}),
        ...(segment.reasoning ? { reasoning: segment.reasoning } : {}),
        ...(segment.watchPrompt ? { watchPrompt: segment.watchPrompt } : {}),
      };
    });

    const base: MappedChapter = {
      timestamp: chapterStart,
      title: chapter.title,
      summary: chapter.summary,
      importance: chapter.importance,
      watchGuide: chapter.watchGuide,
      segments,
    };
    return {
      ...base,
      ...(chapter.contentTag ? { contentTag: chapter.contentTag } : {}),
      ...(typeof chapterEnd === 'number' ? { endTimestamp: chapterEnd } : {}),
      ...(chapter.reflectionPrompt ? { reflectionPrompt: chapter.reflectionPrompt } : {}),
    };
  });
}

function resolveChapterTimes(input: {
  readonly chapter: RawChapterInput;
  readonly hasSubtitles: boolean;
  readonly subtitles: readonly SubtitleCue[] | undefined;
  readonly chapterIndex: number;
  readonly segmentIndex: number | null;
  readonly contextLabel: string;
}): { readonly timestamp: number; readonly endTimestamp: number | undefined } {
  const cueStart = input.hasSubtitles
    ? resolveCueTimestamp(input.chapter.startCueId, input.subtitles!)
    : undefined;
  const cueEnd = input.hasSubtitles
    ? resolveCueEndTimestamp(input.chapter.endCueId, input.subtitles!)
    : undefined;

  const timestamp = cueStart ?? input.chapter.timestamp;
  if (typeof timestamp !== 'number') {
    throw new MissingTimeAnchorError({
      message:
        'chapter 缺时间依据：startCueId 非法（需要合法整数或在 subtitles 范围内），且未提供 timestamp。',
      contextLabel: 'chapter',
      chapterIndex: input.chapterIndex,
      segmentIndex: null,
    });
  }
  return {
    timestamp,
    endTimestamp: cueEnd ?? input.chapter.endTimestamp,
  };
}

function resolveSegmentTimes(input: {
  readonly segment: RawSegmentInput;
  readonly hasSubtitles: boolean;
  readonly subtitles: readonly SubtitleCue[] | undefined;
  readonly chapterIndex: number;
  readonly segmentIndex: number;
}): { readonly timestamp: number; readonly endTimestamp: number | undefined } {
  const cueStart = input.hasSubtitles
    ? resolveCueTimestamp(input.segment.startCueId, input.subtitles!)
    : undefined;
  const cueEnd = input.hasSubtitles
    ? resolveCueEndTimestamp(input.segment.endCueId, input.subtitles!)
    : undefined;

  const timestamp = cueStart ?? input.segment.timestamp;
  if (typeof timestamp !== 'number') {
    throw new MissingTimeAnchorError({
      message:
        'segment 缺时间依据：startCueId 非法（需要合法整数或在 subtitles 范围内），且未提供 timestamp。',
      contextLabel: 'segment',
      chapterIndex: input.chapterIndex,
      segmentIndex: input.segmentIndex,
    });
  }
  return {
    timestamp,
    endTimestamp: cueEnd ?? input.segment.endTimestamp,
  };
}

/**
 * 把 `cueId` 映射到 `subtitles[cueId].start`。
 * 非法 cueId（undefined / 越界）返回 undefined，调用方 fallback 到 timestamp。
 */
function resolveCueTimestamp(
  cueId: number | undefined,
  subtitles: readonly SubtitleCue[],
): number | undefined {
  if (typeof cueId !== 'number' || !Number.isInteger(cueId)) {
    return undefined;
  }
  if (cueId < 0 || cueId >= subtitles.length) {
    return undefined;
  }
  const cue = subtitles[cueId];
  return typeof cue?.start === 'number' ? cue.start : undefined;
}

/**
 * 把 `cueId` 映射到 `subtitles[cueId].end ?? subtitles[cueId].start`。
 * 非法 cueId / 缺 end 时返回 undefined（让 segment 不带 endTimestamp）。
 *
 * 端点约定：endCueId 对应字幕的"结束时间"——这样 segment 的时间范围是
 * `[startCue.start, endCue.end]`，覆盖 startCue 到 endCue 的所有字幕。
 */
function resolveCueEndTimestamp(
  cueId: number | undefined,
  subtitles: readonly SubtitleCue[],
): number | undefined {
  if (typeof cueId !== 'number' || !Number.isInteger(cueId)) {
    return undefined;
  }
  if (cueId < 0 || cueId >= subtitles.length) {
    return undefined;
  }
  const cue = subtitles[cueId];
  if (!cue) {
    return undefined;
  }
  if (typeof cue.end === 'number' && cue.end > cue.start) {
    return cue.end;
  }
  // 没有 cue.end 时回落：end 起点为 cue 自身的 start（让 segment 的 endTimestamp
  // 至少等于起点，而不是 undefined——这样后续 normalize 不会丢范围）
  return cue.start;
}
