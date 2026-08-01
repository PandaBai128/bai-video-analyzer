import type {
  TimelineContentTag,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
  VideoPlatformChapter,
} from '@core/types';
import { normalizeChapterTimelineStructure } from './timeline-normalize';

const MIN_PLATFORM_CHAPTERS = 2;
const PRE_ANCHOR_TOLERANCE_SECONDS = 20;
const MISSING_ANCHOR_SEGMENT_THRESHOLD_SECONDS = 45;

interface NormalizedPlatformChapter {
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

export function alignAnalysisToPlatformChapters(input: {
  readonly analysis: VideoAnalysis;
  readonly platformChapters: readonly VideoPlatformChapter[] | undefined;
  readonly duration?: number | undefined;
}): VideoAnalysis {
  const anchors = normalizePlatformChapters(input.platformChapters, input.duration);
  if (anchors.length < MIN_PLATFORM_CHAPTERS) {
    return input.analysis;
  }

  const sourceSegments = input.analysis.timeline.length
    ? input.analysis.timeline
    : input.analysis.chapters.flatMap((chapter) => chapter.segments);
  const alignedChapters = anchors.map((anchor) =>
    createAlignedChapter(anchor, input.analysis.chapters, sourceSegments),
  );
  const normalized = normalizeChapterTimelineStructure(alignedChapters, input.duration);

  return {
    ...input.analysis,
    chapters: normalized.chapters,
    timeline: normalized.timeline,
  };
}

export function normalizePlatformChapters(
  chapters: readonly VideoPlatformChapter[] | undefined,
  duration: number | undefined,
): readonly NormalizedPlatformChapter[] {
  if (!chapters?.length) {
    return [];
  }
  const sorted = chapters
    .filter((chapter) => chapter.title.trim() && Number.isFinite(chapter.start))
    .map((chapter) => ({
      title: chapter.title.trim(),
      start: Math.max(0, chapter.start),
      ...(typeof chapter.end === 'number' && Number.isFinite(chapter.end) && chapter.end > chapter.start
        ? { end: chapter.end }
        : {}),
    }))
    .sort((left, right) => left.start - right.start);

  const normalized: NormalizedPlatformChapter[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const chapter = sorted[index];
    if (!chapter) {
      continue;
    }
    const nextStart = sorted[index + 1]?.start;
    const rawEnd =
      typeof chapter.end === 'number'
        ? chapter.end
        : typeof nextStart === 'number'
          ? nextStart
          : duration;
    if (typeof rawEnd !== 'number' || !Number.isFinite(rawEnd) || rawEnd <= chapter.start) {
      continue;
    }
    const end = typeof duration === 'number' && duration > 0 ? Math.min(rawEnd, duration) : rawEnd;
    if (end <= chapter.start) {
      continue;
    }
    normalized.push({
      title: chapter.title,
      start: chapter.start,
      end,
    });
  }
  return normalized;
}

function createAlignedChapter(
  anchor: NormalizedPlatformChapter,
  sourceChapters: readonly VideoChapter[],
  sourceSegments: readonly TimelineNode[],
): VideoChapter {
  const bestChapter = pickBestChapterForAnchor(anchor, sourceChapters);
  const segments = sourceSegments
    .filter((segment) => segmentOverlapsAnchor(segment, anchor))
    .map((segment) => clampSegmentToAnchor(segment, anchor))
    .sort((left, right) => left.timestamp - right.timestamp);
  const dedupedSegments = dedupeSegments(segments);
  const firstSegment = dedupedSegments[0];
  const needsAnchorSegment =
    !firstSegment ||
    firstSegment.timestamp - anchor.start > MISSING_ANCHOR_SEGMENT_THRESHOLD_SECONDS;
  const finalSegments = needsAnchorSegment
    ? [createAnchorSegment(anchor, bestChapter), ...dedupedSegments]
    : dedupedSegments;

  const base: VideoChapter = {
    timestamp: anchor.start,
    endTimestamp: anchor.end,
    title: anchor.title,
    summary: bestChapter?.summary ?? `这一章对应平台章节「${anchor.title}」。`,
    importance: bestChapter?.importance ?? 'recommended',
    ...(bestChapter?.contentTag ? { contentTag: bestChapter.contentTag } : {}),
    watchGuide: bestChapter?.watchGuide ?? '按平台章节边界观看这一段。',
    segments: finalSegments.length ? finalSegments : [createAnchorSegment(anchor, bestChapter)],
  };
  return {
    ...base,
    ...(bestChapter?.reflectionPrompt ? { reflectionPrompt: bestChapter.reflectionPrompt } : {}),
  };
}

function segmentOverlapsAnchor(segment: TimelineNode, anchor: NormalizedPlatformChapter): boolean {
  const segmentEnd =
    typeof segment.endTimestamp === 'number' && segment.endTimestamp > segment.timestamp
      ? segment.endTimestamp
      : segment.timestamp;
  return (
    segment.timestamp >= anchor.start - PRE_ANCHOR_TOLERANCE_SECONDS &&
    segment.timestamp < anchor.end &&
    segmentEnd > anchor.start
  );
}

function clampSegmentToAnchor(
  segment: TimelineNode,
  anchor: NormalizedPlatformChapter,
): TimelineNode {
  const timestamp = Math.max(segment.timestamp, anchor.start);
  const rawEnd =
    typeof segment.endTimestamp === 'number' && segment.endTimestamp > segment.timestamp
      ? segment.endTimestamp
      : undefined;
  const endTimestamp =
    typeof rawEnd === 'number' ? Math.min(Math.max(rawEnd, timestamp), anchor.end) : undefined;
  const base: TimelineNode = {
    timestamp,
    title: segment.title,
    summary: segment.summary,
    importance: segment.importance,
  };
  return {
    ...base,
    ...(segment.contentTag ? { contentTag: segment.contentTag } : {}),
    ...(typeof endTimestamp === 'number' && endTimestamp > timestamp ? { endTimestamp } : {}),
    ...(segment.reasoning ? { reasoning: segment.reasoning } : {}),
    ...(segment.watchPrompt ? { watchPrompt: segment.watchPrompt } : {}),
  };
}

function dedupeSegments(segments: readonly TimelineNode[]): readonly TimelineNode[] {
  const result: TimelineNode[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const key = `${Math.floor(segment.timestamp)}:${normalizeTitle(segment.title)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(segment);
  }
  return result;
}

function createAnchorSegment(
  anchor: NormalizedPlatformChapter,
  bestChapter: VideoChapter | null,
): TimelineNode {
  const segment: TimelineNode = {
    timestamp: anchor.start,
    endTimestamp: anchor.end,
    title: anchor.title,
    summary: bestChapter?.summary ?? `从这里开始进入「${anchor.title}」。`,
    importance: bestChapter?.importance ?? 'recommended',
  };
  return {
    ...segment,
    ...(bestChapter?.contentTag ? { contentTag: bestChapter.contentTag } : {}),
  };
}

function pickBestChapterForAnchor(
  anchor: NormalizedPlatformChapter,
  chapters: readonly VideoChapter[],
): VideoChapter | null {
  let best: { readonly chapter: VideoChapter; readonly score: number } | null = null;
  for (const chapter of chapters) {
    const score = scoreChapterForAnchor(anchor, chapter);
    if (!best || score > best.score) {
      best = { chapter, score };
    }
  }
  return best?.score && best.score > 0 ? best.chapter : null;
}

function scoreChapterForAnchor(
  anchor: NormalizedPlatformChapter,
  chapter: VideoChapter,
): number {
  const overlap = getIntervalOverlap(
    anchor.start,
    anchor.end,
    chapter.timestamp,
    chapter.endTimestamp ?? getChapterFallbackEnd(chapter),
  );
  const titleScore = titlesRoughlyMatch(anchor.title, chapter.title) ? 10_000 : 0;
  return titleScore + overlap;
}

function getChapterFallbackEnd(chapter: VideoChapter): number {
  const segmentEnds = chapter.segments.map((segment) =>
    typeof segment.endTimestamp === 'number' && segment.endTimestamp > segment.timestamp
      ? segment.endTimestamp
      : segment.timestamp,
  );
  return Math.max(chapter.timestamp, ...segmentEnds);
}

function getIntervalOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): number {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function titlesRoughlyMatch(left: string, right: string): boolean {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) {
    return false;
  }
  if (a.includes(b) || b.includes(a)) {
    return true;
  }
  const tokens = new Set(splitTitleTokens(a));
  return splitTitleTokens(b).some((token) => token.length >= 3 && tokens.has(token));
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, '');
}

function splitTitleTokens(normalizedTitle: string): readonly string[] {
  const latinTokens = normalizedTitle.match(/[a-z0-9]+/g) ?? [];
  const chineseTokens = normalizedTitle.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const singularLatinTokens = latinTokens
    .filter((token) => token.length > 3 && token.endsWith('s'))
    .map((token) => token.slice(0, -1));
  return [...latinTokens, ...singularLatinTokens, ...chineseTokens];
}

export function pickDominantContentTag(
  chapters: readonly VideoChapter[],
): TimelineContentTag | undefined {
  const counts = new Map<TimelineContentTag, number>();
  for (const chapter of chapters) {
    if (!chapter.contentTag) {
      continue;
    }
    counts.set(chapter.contentTag, (counts.get(chapter.contentTag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}
