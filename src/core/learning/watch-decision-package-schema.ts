import { z } from 'zod';
import { parseJsonWithRepair } from '@core/analysis/video-analysis-json-repair';
import { stripJsonFence } from '@core/analysis/video-analysis-schema';
import type {
  LearningGuide,
  LearningGuideDecision,
  LearningGuideDecisionRating,
  LearningGuideDecisionSegment,
  LearningGuideValueProfile,
  LearningGuideValueProfileKind,
  SubtitleCue,
  TimelineContentTag,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
} from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import { normalizeValueProfileCriteria } from './value-profile-criteria';
import { TIMELINE_CONTENT_TAGS } from '@core/types';
import { createTimelineDigest } from './content-context-digest';

export interface WatchDecisionPackage {
  readonly analysis: VideoAnalysis;
  readonly guide: LearningGuide;
}

const importanceSchema = z
  .enum(['must-watch', 'recommended', 'optional', 'skip'])
  .default('recommended')
  .catch('recommended');

const contentTagSchema = z.enum(TIMELINE_CONTENT_TAGS).optional().catch(undefined);

const optionalText = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}, z.string().optional());

const cueId = z
  .preprocess((value) => {
    const number = Number(value);
    return Number.isInteger(number) ? number : value;
  }, z.number().int().nonnegative())
  .catch(-1);

const optionalCueId = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === '') return undefined;
    const number = Number(value);
    return Number.isInteger(number) ? number : value;
  }, z.number().int().nonnegative().optional())
  .catch(undefined);

const optionalSeconds = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = parseTimestampLike(value);
      if (parsed !== undefined) return parsed;
      const number = Number(value.trim());
      return Number.isFinite(number) ? number : value;
    }
    return value;
  }, z.number().nonnegative().optional())
  .catch(undefined);

const rawTimelineSegmentSchema = z.object({
  id: optionalText,
  startCueId: cueId,
  endCueId: cueId,
  startCueIndex: optionalCueId,
  endCueIndex: optionalCueId,
  start_cue_id: optionalCueId,
  end_cue_id: optionalCueId,
  timestamp: optionalSeconds,
  startTimestamp: optionalSeconds,
  endTimestamp: optionalSeconds,
  startTime: optionalSeconds,
  endTime: optionalSeconds,
  start: optionalSeconds,
  end: optionalSeconds,
  importance: importanceSchema,
  contentTag: contentTagSchema,
  title: optionalText,
  summary: optionalText,
  watchPrompt: optionalText,
});

const rawChapterSchema = z.object({
  id: optionalText,
  startCueId: cueId,
  endCueId: cueId,
  startCueIndex: optionalCueId,
  endCueIndex: optionalCueId,
  start_cue_id: optionalCueId,
  end_cue_id: optionalCueId,
  timestamp: optionalSeconds,
  startTimestamp: optionalSeconds,
  endTimestamp: optionalSeconds,
  startTime: optionalSeconds,
  endTime: optionalSeconds,
  start: optionalSeconds,
  end: optionalSeconds,
  importance: importanceSchema,
  contentTag: contentTagSchema,
  title: optionalText,
  summary: optionalText,
  watchGuide: optionalText,
  segments: z.array(rawTimelineSegmentSchema).max(8).default([]).catch([]),
});

const textArraySchema = z.array(z.unknown()).max(8).default([]).catch([]);

const optionalScore = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }, z.number().min(0).max(100).optional())
  .catch(undefined);

const ratingSchema = z
  .preprocess(normalizeRatingInput, z.enum(['worth_watching', 'selective', 'quick_browse', 'skip']))
  .optional()
  .catch(undefined);

const valueTagSchema = z.enum([
  'must_watch',
  'watch',
  'skim',
  'skip',
  'uncertain',
  'case',
  'method',
  'ad',
]);

const valueProfileKindSchema = z
  .enum([
    'learning_tutorial',
    'interview_qa',
    'opinion_commentary',
    'product_review',
    'news_context',
    'entertainment_reaction',
    'gameplay_walkthrough',
    'mixed',
  ])
  .catch('mixed');

const valueCriterionSchema = z.object({
  label: optionalText,
  score: optionalScore,
  reason: optionalText,
});

const MAX_VALUE_PROFILE_CRITERIA = 5;

const rawDecisionSegmentSchema = z.object({
  nodeId: optionalText,
  segmentId: optionalText,
  chapterId: optionalText,
  id: optionalText,
  title: optionalText,
  tag: z.preprocess(normalizeValueTagInput, valueTagSchema).catch('uncertain'),
  reason: optionalText,
});

const rawTimePlanSchema = z.object({
  budget: z.enum(['10min', '20min', '40min', 'full']).default('full').catch('full'),
  label: optionalText,
  instruction: optionalText,
  segments: z.array(rawDecisionSegmentSchema).max(8).default([]).catch([]),
});

const valueProfileSchema = z.object({
  kind: valueProfileKindSchema,
  label: optionalText,
  criteria: z
    .preprocess(
      (value) => (Array.isArray(value) ? value.slice(0, MAX_VALUE_PROFILE_CRITERIA) : value),
      z.array(valueCriterionSchema).default([]).catch([]),
    )
    .default([]),
});

const decisionSchema = z.object({
  rating: ratingSchema,
  score: optionalScore,
  valueProfile: valueProfileSchema,
  verdict: optionalText,
  overallMeaning: optionalText,
  reason: optionalText,
  worthReasons: textArraySchema,
  bestFor: textArraySchema,
  notFor: textArraySchema,
  learningValue: textArraySchema,
  timePlans: z.array(rawTimePlanSchema).max(6).default([]).catch([]),
  mustWatch: z.array(rawDecisionSegmentSchema).max(10).default([]).catch([]),
  canWatch: z.array(rawDecisionSegmentSchema).max(10).default([]).catch([]),
  canSkim: z.array(rawDecisionSegmentSchema).max(10).default([]).catch([]),
  canSkip: z.array(rawDecisionSegmentSchema).max(10).default([]).catch([]),
  reservations: textArraySchema,
});

const rawPackageSchema = z.object({
  overview: optionalText,
  coreTakeaways: textArraySchema,
  reviewSummary: optionalText,
  chapters: z.array(rawChapterSchema).max(30).default([]).catch([]),
  decision: decisionSchema,
  contentType: optionalText,
  contentTypeReason: optionalText,
  suggestedStance: optionalText,
});

export function parseWatchDecisionPackageJson(input: {
  readonly content: string;
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly generatedAt: number;
  readonly modelUsed: string;
  readonly contextDigest: string;
  readonly outputLocale?: UiLocale;
}): WatchDecisionPackage {
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const parsedJson = parseJsonWithRepair(stripJsonFence(input.content));
  const parsed = rawPackageSchema.parse(coerceWatchDecisionPackage(parsedJson, outputLocale));
  const { chapters, timeline, nodesById } = normalizeTimeline({
    rawChapters: parsed.chapters,
    transcriptCues: input.transcriptCues,
    duration: input.metadata.duration,
    outputLocale,
  });
  const analysisWithoutDigest: VideoAnalysis = {
    overview: parsed.overview ?? getDefaultPackageOverview(outputLocale),
    watchStrategy: [],
    coreTakeaways: limitTextItems(parsed.coreTakeaways, 5),
    reviewSummary:
      parsed.reviewSummary ??
      parsed.overview ??
      getDefaultPackageReviewSummary(outputLocale),
    chapters,
    timeline,
    quotes: [],
    keyConcepts: [],
    inspirations: [],
    generatedAt: input.generatedAt,
    modelUsed: input.modelUsed,
    sourceMode: 'subtitle',
    contextDigest: input.contextDigest,
  };
  const timelineDigest = createTimelineDigest(analysisWithoutDigest);
  const analysis: VideoAnalysis = {
    ...analysisWithoutDigest,
    timelineDigest,
  };
  const decision = normalizeDecision(parsed.decision, nodesById, outputLocale);
  const guide: LearningGuide = {
    decision,
    contentType: parsed.contentType ?? getDefaultContentType(outputLocale),
    contentTypeReason: parsed.contentTypeReason ?? getDefaultContentTypeReason(outputLocale),
    suggestedStance: parsed.suggestedStance ?? decision.verdict,
    generatedAt: input.generatedAt,
    modelUsed: input.modelUsed,
    contextDigest: input.contextDigest,
    timelineDigest,
  };
  return { analysis, guide };
}

function getDefaultPackageOverview(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'Generated a watch decision and timeline for this video.'
    : '已生成视频观看判断和时间线。';
}

function getDefaultPackageReviewSummary(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'A watch decision is ready. Use questions and notes to build your summary.'
    : '当前视频已经生成观看判断，可结合提问和记录整理笔记。';
}

function getDefaultContentType(outputLocale: UiLocale): string {
  return outputLocale === 'en-US' ? 'Video content' : '视频内容';
}

function getDefaultContentTypeReason(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not provide a content-type reason.'
    : '模型没有补充内容类型理由。';
}

function getDefaultFlatTimelineTitle(outputLocale: UiLocale): string {
  return outputLocale === 'en-US' ? 'Video Timeline' : '视频时间线';
}

function getDefaultFlatTimelineSummary(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model returned a flat timeline, so it has been grouped into one chapter.'
    : '模型返回了扁平时间线，已归入单章。';
}

function getDefaultFlatTimelineWatchGuide(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'Choose what to watch from the segments below.'
    : '按下方片段选择观看。';
}

function getDefaultUnnamedSegmentTitle(outputLocale: UiLocale): string {
  return outputLocale === 'en-US' ? 'Untitled Segment' : '未命名片段';
}

function getDefaultUnnamedChapterTitle(outputLocale: UiLocale): string {
  return outputLocale === 'en-US' ? 'Untitled Chapter' : '未命名章节';
}

function getDefaultSegmentSummary(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not provide a summary for this segment.'
    : '模型没有补充这一段说明。';
}

function getDefaultChapterSummary(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not provide a summary for this chapter.'
    : '模型没有补充这一章说明。';
}

function getDefaultChapterWatchGuide(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'Choose what to watch based on this chapter’s segment value.'
    : '按这一章的片段价值选择观看。';
}

function getDefaultDecisionReason(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not provide a clear reason.'
    : '模型没有给出明确判断原因。';
}

function getDefaultOverallMeaning(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not provide a full video summary.'
    : '模型没有给出完整视频说明。';
}

function getDefaultDecisionSegmentContentReason(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not explain this segment.'
    : '模型没有说明片段内容。';
}

function getDefaultDecisionSegmentReason(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not explain this segment.'
    : '模型没有说明片段理由。';
}

function coerceWatchDecisionPackage(value: unknown, outputLocale: UiLocale): unknown {
  if (!isRecord(value)) return value;

  const analysis = getRecord(value.analysis) ?? value;
  const guide =
    getRecord(value.guide) ??
    getRecord(value.judgment) ??
    getRecord(value.watchDecision) ??
    getRecord(value.watch_decision) ??
    value;
  const decision =
    getRecord(value.decision) ??
    getRecord(guide.decision) ??
    (hasDecisionShape(guide) ? guide : undefined) ??
    getRecord(value.watchDecision) ??
    getRecord(value.watch_decision) ??
    getRecord(value.judgment);
  const chapters =
    getArray(value.chapters) ??
    getArray(analysis.chapters) ??
    coerceTimelineArrayToChapters(
      getArray(value.timeline) ?? getArray(analysis.timeline),
      outputLocale,
    );

  return {
    overview: firstValue(value.overview, analysis.overview, analysis.summary),
    coreTakeaways: firstValue(value.coreTakeaways, analysis.coreTakeaways, analysis.takeaways),
    reviewSummary: firstValue(value.reviewSummary, analysis.reviewSummary, analysis.summary),
    chapters,
    decision,
    contentType: firstValue(value.contentType, guide.contentType, guide.content_type),
    contentTypeReason: firstValue(
      value.contentTypeReason,
      guide.contentTypeReason,
      guide.content_type_reason,
    ),
    suggestedStance: firstValue(value.suggestedStance, guide.suggestedStance, guide.stance),
  };
}

function coerceTimelineArrayToChapters(
  timeline: readonly unknown[] | undefined,
  outputLocale: UiLocale,
): readonly unknown[] | undefined {
  if (!timeline?.length) return undefined;
  const cueRanges = timeline
    .map((item) => (isRecord(item) ? normalizeCueRangeLike(item) : null))
    .filter(
      (range): range is { readonly startCueId: number; readonly endCueId: number } =>
        range !== null,
    );
  if (cueRanges.length) {
    return [
      {
        id: 'c1',
        startCueId: Math.min(...cueRanges.map((range) => range.startCueId)),
        endCueId: Math.max(...cueRanges.map((range) => range.endCueId)),
        title: getDefaultFlatTimelineTitle(outputLocale),
        summary: getDefaultFlatTimelineSummary(outputLocale),
        importance: 'recommended',
        watchGuide: getDefaultFlatTimelineWatchGuide(outputLocale),
        segments: timeline,
      },
    ];
  }
  const timestampRanges = timeline
    .map((item) => (isRecord(item) ? normalizeTimestampRangeLike(item) : null))
    .filter(
      (range): range is { readonly startTimestamp: number; readonly endTimestamp: number } =>
        range !== null,
    );
  if (!timestampRanges.length) return undefined;
  return [
    {
      id: 'c1',
      startTimestamp: Math.min(...timestampRanges.map((range) => range.startTimestamp)),
      endTimestamp: Math.max(...timestampRanges.map((range) => range.endTimestamp)),
      title: getDefaultFlatTimelineTitle(outputLocale),
      summary: getDefaultFlatTimelineSummary(outputLocale),
      importance: 'recommended',
      watchGuide: getDefaultFlatTimelineWatchGuide(outputLocale),
      segments: timeline,
    },
  ];
}

function normalizeCueRangeLike(
  value: Record<string, unknown>,
): { readonly startCueId: number; readonly endCueId: number } | null {
  const startCueId = Number(
    value.startCueId ?? value.startCueIndex ?? value.startCue ?? value.start_cue_id,
  );
  const endCueId = Number(
    value.endCueId ?? value.endCueIndex ?? value.endCue ?? value.end_cue_id ?? startCueId,
  );
  if (!Number.isInteger(startCueId) || !Number.isInteger(endCueId)) return null;
  if (startCueId < 0 || endCueId < startCueId) return null;
  return { startCueId, endCueId };
}

function normalizeTimestampRangeLike(
  value: Record<string, unknown>,
): { readonly startTimestamp: number; readonly endTimestamp: number } | null {
  const startTimestamp = normalizeTimestampInput(
    value.startTimestamp ?? value.timestamp ?? value.startTime ?? value.start,
  );
  if (startTimestamp === undefined) return null;
  const endTimestamp =
    normalizeTimestampInput(value.endTimestamp ?? value.endTime ?? value.end) ?? startTimestamp;
  if (endTimestamp < startTimestamp) return null;
  return { startTimestamp, endTimestamp };
}

function normalizeTimestampInput(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = parseTimestampLike(value);
  if (parsed !== undefined) return parsed;
  const number = Number(value.trim());
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function parseTimestampLike(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const normalized = text.replace(/[：]/g, ':');
  if (!/^\d{1,2}(?::\d{1,2}){1,2}$/.test(normalized)) return undefined;
  const parts = normalized.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (minutes === undefined || seconds === undefined || seconds >= 60) return undefined;
    return minutes * 60 + seconds;
  }
  const [hours, minutes, seconds] = parts;
  if (
    hours === undefined ||
    minutes === undefined ||
    seconds === undefined ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return undefined;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function hasDecisionShape(value: Record<string, unknown>): boolean {
  return (
    value.decision === undefined &&
    (value.rating !== undefined ||
      value.score !== undefined ||
      value.verdict !== undefined ||
      value.overallMeaning !== undefined)
  );
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function firstValue(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTimeline(input: {
  readonly rawChapters: readonly z.infer<typeof rawChapterSchema>[];
  readonly transcriptCues: readonly SubtitleCue[];
  readonly duration: number | undefined;
  readonly outputLocale: UiLocale;
}): {
  readonly chapters: readonly VideoChapter[];
  readonly timeline: readonly TimelineNode[];
  readonly nodesById: ReadonlyMap<string, TimelineNode | VideoChapter>;
} {
  const chapters: VideoChapter[] = [];
  const timeline: TimelineNode[] = [];
  const nodesById = new Map<string, TimelineNode | VideoChapter>();
  const usedIds = new Set<string>();

  input.rawChapters.forEach((rawChapter, chapterIndex) => {
    const chapterRange = normalizeCueRange(rawChapter, input.transcriptCues, input.duration);
    if (!chapterRange) return;
    const chapterId = createUniqueId(rawChapter.id, `c${chapterIndex + 1}`, usedIds);
    const segments = rawChapter.segments
      .map((rawSegment, segmentIndex) => {
        const range = normalizeCueRange(rawSegment, input.transcriptCues, input.duration);
        if (!range) return null;
        const constrainedRange = constrainRangeToParent(range, chapterRange);
        if (!constrainedRange) return null;
        const segmentId = createUniqueId(
          rawSegment.id,
          `${chapterId}-s${segmentIndex + 1}`,
          usedIds,
        );
        const node = buildTimelineNode({
          id: segmentId,
          range: constrainedRange,
          raw: rawSegment,
          transcriptCues: input.transcriptCues,
          duration: input.duration,
          outputLocale: input.outputLocale,
        });
        nodesById.set(segmentId, node);
        timeline.push(node);
        return node;
      })
      .filter((node): node is TimelineNode => node !== null);
    const effectiveSegments =
      segments.length > 0
        ? segments
        : [
            buildTimelineNode({
              id: createUniqueId(undefined, `${chapterId}-s1`, usedIds),
              range: chapterRange,
              raw: {
                title: rawChapter.title,
                summary: rawChapter.summary,
                importance: rawChapter.importance,
                contentTag: rawChapter.contentTag,
              },
              transcriptCues: input.transcriptCues,
              duration: input.duration,
              outputLocale: input.outputLocale,
            }),
          ];
    for (const node of effectiveSegments) {
      if (!nodesById.has(node.id ?? '')) {
        nodesById.set(node.id ?? '', node);
        timeline.push(node);
      }
    }
    const chapter = buildChapter({
      id: chapterId,
      range: chapterRange,
      raw: rawChapter,
      segments: effectiveSegments,
      transcriptCues: input.transcriptCues,
      duration: input.duration,
      outputLocale: input.outputLocale,
    });
    nodesById.set(chapterId, chapter);
    chapters.push(chapter);
  });

  return {
    chapters: chapters.sort((left, right) => left.timestamp - right.timestamp),
    timeline: timeline.sort((left, right) => left.timestamp - right.timestamp),
    nodesById,
  };
}

function buildTimelineNode(input: {
  readonly id: string;
  readonly range: { readonly startCueId: number; readonly endCueId: number };
  readonly raw: {
    readonly title?: string | undefined;
    readonly summary?: string | undefined;
    readonly importance: TimelineNode['importance'];
    readonly contentTag?: TimelineContentTag | undefined;
    readonly watchPrompt?: string | undefined;
  };
  readonly transcriptCues: readonly SubtitleCue[];
  readonly duration: number | undefined;
  readonly outputLocale: UiLocale;
}): TimelineNode {
  const timestamps = getCueRangeTimestamps(input.range, input.transcriptCues, input.duration);
  return {
    id: input.id,
    timestamp: timestamps.start,
    ...(timestamps.end !== undefined ? { endTimestamp: timestamps.end } : {}),
    title: input.raw.title ?? getDefaultUnnamedSegmentTitle(input.outputLocale),
    summary: input.raw.summary ?? getDefaultSegmentSummary(input.outputLocale),
    importance: input.raw.importance,
    ...(input.raw.contentTag ? { contentTag: input.raw.contentTag } : {}),
    ...(input.raw.watchPrompt ? { watchPrompt: input.raw.watchPrompt } : {}),
    sourceCueRange: input.range,
  };
}

function buildChapter(input: {
  readonly id: string;
  readonly range: { readonly startCueId: number; readonly endCueId: number };
  readonly raw: z.infer<typeof rawChapterSchema>;
  readonly segments: readonly TimelineNode[];
  readonly transcriptCues: readonly SubtitleCue[];
  readonly duration: number | undefined;
  readonly outputLocale: UiLocale;
}): VideoChapter {
  const timestamps = getCueRangeTimestamps(input.range, input.transcriptCues, input.duration);
  return {
    id: input.id,
    timestamp: timestamps.start,
    ...(timestamps.end !== undefined ? { endTimestamp: timestamps.end } : {}),
    title: input.raw.title ?? getDefaultUnnamedChapterTitle(input.outputLocale),
    summary: input.raw.summary ?? getDefaultChapterSummary(input.outputLocale),
    importance: input.raw.importance,
    ...(input.raw.contentTag ? { contentTag: input.raw.contentTag } : {}),
    watchGuide: input.raw.watchGuide ?? getDefaultChapterWatchGuide(input.outputLocale),
    segments: input.segments,
    sourceCueRange: input.range,
  };
}

type RawCueRangeInput = {
  readonly startCueId: number;
  readonly endCueId: number;
  readonly startCueIndex?: number | undefined;
  readonly endCueIndex?: number | undefined;
  readonly start_cue_id?: number | undefined;
  readonly end_cue_id?: number | undefined;
  readonly timestamp?: number | undefined;
  readonly startTimestamp?: number | undefined;
  readonly endTimestamp?: number | undefined;
  readonly startTime?: number | undefined;
  readonly endTime?: number | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
};

function normalizeCueRange(
  raw: RawCueRangeInput,
  cues: readonly SubtitleCue[],
  duration: number | undefined,
): { readonly startCueId: number; readonly endCueId: number } | null {
  if (cues.length <= 0) return null;

  const cueRange = normalizeExplicitCueRange(
    firstValidCueId(raw.startCueId, raw.startCueIndex, raw.start_cue_id),
    firstValidCueId(raw.endCueId, raw.endCueIndex, raw.end_cue_id),
    cues.length,
  );
  if (cueRange) return cueRange;

  const startTimestamp = normalizeSecondsForDuration(
    firstFinite(raw.startTimestamp, raw.timestamp, raw.startTime, raw.start),
    duration,
  );
  if (startTimestamp === undefined) return null;

  const endTimestamp = normalizeSecondsForDuration(
    firstFinite(raw.endTimestamp, raw.endTime, raw.end),
    duration,
  );
  const startCueId = findCueIndexForTimestamp(startTimestamp, cues);
  const endCueId =
    endTimestamp !== undefined && endTimestamp >= startTimestamp
      ? Math.max(startCueId, findCueIndexForTimestamp(Math.max(0, endTimestamp - 0.001), cues))
      : startCueId;

  return { startCueId, endCueId };
}

function normalizeExplicitCueRange(
  startCueId: number | undefined,
  endCueId: number | undefined,
  cueCount: number,
): { readonly startCueId: number; readonly endCueId: number } | null {
  if (startCueId === undefined || startCueId < 0 || startCueId >= cueCount) return null;
  if (endCueId !== undefined && endCueId >= cueCount) return null;
  const safeEndCueId = endCueId === undefined || endCueId < 0 ? startCueId : endCueId;
  return {
    startCueId: Math.min(startCueId, safeEndCueId),
    endCueId: Math.max(startCueId, safeEndCueId),
  };
}

function firstValidCueId(...values: readonly (number | undefined)[]): number | undefined {
  return values.find((value) => value !== undefined && Number.isInteger(value) && value >= 0);
}

function firstFinite(...values: readonly (number | undefined)[]): number | undefined {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value));
}

function normalizeSecondsForDuration(
  value: number | undefined,
  duration: number | undefined,
): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const seconds =
    value > 36_000 || (typeof duration === 'number' && value > Math.max(1, duration) * 10)
      ? value / 1000
      : value;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  if (typeof duration === 'number' && duration > 0 && seconds > duration + 2) return undefined;
  return seconds;
}

function findCueIndexForTimestamp(timestamp: number, cues: readonly SubtitleCue[]): number {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (!cue) continue;
    const nextCue = cues[index + 1];
    const end = cue.end ?? nextCue?.start;
    if (timestamp >= cue.start && (end === undefined || timestamp < end)) {
      return index;
    }
    const distance = Math.abs(cue.start - timestamp);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  return closestIndex;
}

function constrainRangeToParent(
  range: { readonly startCueId: number; readonly endCueId: number },
  parentRange: { readonly startCueId: number; readonly endCueId: number },
): { readonly startCueId: number; readonly endCueId: number } | null {
  const startCueId = Math.max(range.startCueId, parentRange.startCueId);
  const endCueId = Math.min(range.endCueId, parentRange.endCueId);
  if (endCueId < startCueId) return null;
  return { startCueId, endCueId };
}

function getCueRangeTimestamps(
  range: { readonly startCueId: number; readonly endCueId: number },
  cues: readonly SubtitleCue[],
  duration: number | undefined,
): { readonly start: number; readonly end?: number } {
  const startCue = cues[range.startCueId];
  const endCue = cues[range.endCueId];
  const nextCue = cues[range.endCueId + 1];
  const start = Math.max(0, startCue?.start ?? 0);
  const rawEnd = endCue?.end ?? nextCue?.start ?? duration;
  const end = typeof rawEnd === 'number' && rawEnd > start ? rawEnd : undefined;
  return { start, ...(end !== undefined ? { end } : {}) };
}

function normalizeDecision(
  decision: z.infer<typeof decisionSchema>,
  nodesById: ReadonlyMap<string, TimelineNode | VideoChapter>,
  outputLocale: UiLocale,
): LearningGuideDecision {
  const inferredRating =
    decision.rating ??
    inferRatingFromText(decision.verdict) ??
    inferRatingFromText(decision.reason) ??
    inferRatingFromText(decision.overallMeaning) ??
    'selective';
  const score = getDecisionScore(decision.score, inferredRating);
  const rating = getRatingForScore(score);
  const worthReasons = limitTextItems(decision.worthReasons, 3);
  const reason = firstNonEmpty(
    decision.reason,
    worthReasons[0],
    decision.verdict,
    decision.overallMeaning,
    getDefaultDecisionReason(outputLocale),
  );
  const verdict = firstNonEmpty(
    decision.verdict,
    `${getRatingText(rating, outputLocale)}${outputLocale === 'en-US' ? ': ' : '，'}${reason}`,
  );
  const overallMeaning = firstNonEmpty(
    decision.overallMeaning,
    reason,
    verdict,
    getDefaultOverallMeaning(outputLocale),
  );

  return {
    rating,
    score,
    valueProfile: normalizeValueProfile(decision.valueProfile, score, outputLocale),
    verdict,
    overallMeaning,
    reason,
    worthReasons,
    bestFor: limitTextItems(decision.bestFor, 3),
    notFor: limitTextItems(decision.notFor, 3),
    learningValue: [],
    timePlans: [],
    mustWatch: normalizeDecisionSegments(decision.mustWatch, nodesById, outputLocale).slice(0, 4),
    canWatch: normalizeDecisionSegments(decision.canWatch, nodesById, outputLocale).slice(0, 4),
    canSkim: normalizeDecisionSegments(decision.canSkim, nodesById, outputLocale).slice(0, 4),
    canSkip: normalizeDecisionSegments(decision.canSkip, nodesById, outputLocale).slice(0, 4),
    reservations: limitTextItems(decision.reservations, 3),
  };
}

function normalizeValueProfile(
  profile: z.infer<typeof valueProfileSchema>,
  fallbackScore: number,
  outputLocale: UiLocale,
): LearningGuideValueProfile {
  return {
    kind: profile.kind,
    label: profile.label ?? getDefaultValueProfileLabel(profile.kind, outputLocale),
    criteria: normalizeValueProfileCriteria({
      kind: profile.kind,
      criteria: profile.criteria,
      fallbackScore,
      outputLocale,
    }),
  };
}

function getDefaultValueProfileLabel(
  kind: LearningGuideValueProfileKind,
  outputLocale: UiLocale,
): string {
  if (outputLocale === 'en-US') {
    if (kind === 'learning_tutorial') return 'Tutorial';
    if (kind === 'interview_qa') return 'Interview Q&A';
    if (kind === 'opinion_commentary') return 'Opinion Commentary';
    if (kind === 'product_review') return 'Product Review';
    if (kind === 'news_context') return 'News Context';
    if (kind === 'entertainment_reaction') return 'Entertainment Reaction';
    if (kind === 'gameplay_walkthrough') return 'Gameplay Walkthrough';
    return 'Mixed Content';
  }
  if (kind === 'learning_tutorial') return '教程学习';
  if (kind === 'interview_qa') return '访谈 Q&A';
  if (kind === 'opinion_commentary') return '观点评论';
  if (kind === 'product_review') return '产品评测';
  if (kind === 'news_context') return '新闻背景';
  if (kind === 'entertainment_reaction') return '娱乐反应';
  if (kind === 'gameplay_walkthrough') return '游戏实况';
  return '混合内容';
}

function normalizeDecisionSegments(
  segments: readonly z.infer<typeof rawDecisionSegmentSchema>[],
  nodesById: ReadonlyMap<string, TimelineNode | VideoChapter>,
  outputLocale: UiLocale,
): readonly LearningGuideDecisionSegment[] {
  return segments
    .map((segment) => normalizeDecisionSegment(segment, nodesById, outputLocale))
    .filter((segment): segment is LearningGuideDecisionSegment => segment !== null);
}

function normalizeDecisionSegment(
  segment: z.infer<typeof rawDecisionSegmentSchema>,
  nodesById: ReadonlyMap<string, TimelineNode | VideoChapter>,
  outputLocale: UiLocale,
): LearningGuideDecisionSegment | null {
  const requestedNodeId = firstNonEmpty(
    segment.nodeId,
    segment.segmentId,
    segment.chapterId,
    segment.id,
  );
  const node = requestedNodeId ? nodesById.get(requestedNodeId) : undefined;
  const title = firstNonEmpty(node?.title, segment.title, segment.reason);
  if (!title) return null;
  const reason = node
    ? firstNonEmpty(
        node.summary,
        getNodeWatchHint(node),
        segment.reason,
        getDefaultDecisionSegmentContentReason(outputLocale),
      )
    : firstNonEmpty(
        segment.reason,
        segment.title,
        getDefaultDecisionSegmentReason(outputLocale),
      );
  return {
    ...(node && requestedNodeId ? { nodeId: requestedNodeId } : {}),
    title,
    tag: segment.tag,
    reason,
    ...(node ? { startTimestamp: node.timestamp } : {}),
    ...(node?.endTimestamp !== undefined ? { endTimestamp: node.endTimestamp } : {}),
  };
}

function getNodeWatchHint(node: TimelineNode | VideoChapter): string | undefined {
  if ('watchGuide' in node) return node.watchGuide;
  return node.watchPrompt;
}

function createUniqueId(rawId: string | undefined, fallback: string, usedIds: Set<string>): string {
  const base = sanitizeId(rawId) || fallback;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function sanitizeId(id: string | undefined): string {
  if (!id) return '';
  return id
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getDecisionScore(
  rawScore: number | undefined,
  fallbackRating: LearningGuideDecisionRating,
): number {
  if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
    return Math.round(Math.max(0, Math.min(100, rawScore)));
  }
  return getDefaultScoreForRating(fallbackRating);
}

function getRatingForScore(score: number): LearningGuideDecision['rating'] {
  if (score >= 80) return 'worth_watching';
  if (score >= 60) return 'selective';
  if (score >= 40) return 'quick_browse';
  return 'skip';
}

function getDefaultScoreForRating(rating: LearningGuideDecisionRating): number {
  if (rating === 'worth_watching') return 85;
  if (rating === 'quick_browse') return 42;
  if (rating === 'skip') return 18;
  return 62;
}

function getRatingText(rating: LearningGuideDecisionRating, outputLocale: UiLocale): string {
  if (outputLocale === 'en-US') {
    if (rating === 'worth_watching') return 'Watch closely';
    if (rating === 'quick_browse') return 'Quick browse';
    if (rating === 'skip') return 'Skip';
    return 'Watch selectively';
  }
  if (rating === 'worth_watching') return '完整细看';
  if (rating === 'quick_browse') return '快速浏览';
  if (rating === 'skip') return '可以跳过';
  return '选择性看';
}

function limitTextItems(items: readonly unknown[], limit: number): readonly string[] {
  return items
    .map((item) => normalizeTextValue(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, limit);
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim() ?? '';
}

function normalizeTextValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function normalizeRatingInput(value: unknown): unknown {
  const text = normalizeTextValue(value);
  if (!text) return undefined;
  if (text.includes('完整') || text.includes('细看') || text === '值得看') return 'worth_watching';
  if (text.includes('快速') || text.includes('浏览')) return 'quick_browse';
  if (text.includes('跳过') || text.includes('不建议')) return 'skip';
  if (text.includes('选择')) return 'selective';
  return value;
}

function inferRatingFromText(text: string | undefined): LearningGuideDecisionRating | undefined {
  const normalized = normalizeRatingInput(text);
  if (
    normalized === 'worth_watching' ||
    normalized === 'selective' ||
    normalized === 'quick_browse' ||
    normalized === 'skip'
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeValueTagInput(value: unknown): unknown {
  const text = normalizeTextValue(value);
  if (!text) return 'uncertain';
  if (text.includes('广告')) return 'ad';
  if (text.includes('案例')) return 'case';
  if (text.includes('方法')) return 'method';
  if (text.includes('重点') || text.includes('必看') || text.includes('最值得')) {
    return 'must_watch';
  }
  if (text.includes('轻放') || text.includes('略看') || text.includes('粗看')) return 'skim';
  if (text.includes('跳过') || text.includes('可跳')) return 'skip';
  if (text.includes('可看') || text.includes('正常看')) return 'watch';
  if (text.includes('存疑') || text.includes('不确定')) return 'uncertain';
  return value;
}
