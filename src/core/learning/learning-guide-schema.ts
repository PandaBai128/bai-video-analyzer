import { z } from 'zod';
import { parseJsonWithRepair } from '@core/analysis/video-analysis-json-repair';
import { stripJsonFence } from '@core/analysis/video-analysis-schema';
import type {
  LearningGuide,
  LearningGuideDecision,
  LearningGuideDecisionRating,
  LearningGuideDecisionSegment,
  LearningGuideTimePlan,
  LearningGuideValueProfile,
  LearningGuideValueProfileKind,
} from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import { normalizeValueProfileCriteria } from './value-profile-criteria';

const optionalText = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}, z.string().optional());

const optionalTimestamp = z
  .preprocess((value) => {
    if (value === null || value === undefined || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }, z.number().nonnegative().optional())
  .catch(undefined);

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

const MAX_VALUE_PROFILE_CRITERIA = 5;

const decisionSegmentSchema = z.object({
  title: optionalText,
  tag: z.preprocess(normalizeValueTagInput, valueTagSchema).catch('uncertain'),
  reason: optionalText,
  startTimestamp: optionalTimestamp,
  endTimestamp: optionalTimestamp,
});

const textArraySchema = z.array(z.unknown()).max(8).default([]).catch([]);

const rawTimePlanSchema = z.object({
  budget: z.enum(['10min', '20min', '40min', 'full']).default('full').catch('full'),
  label: optionalText,
  instruction: optionalText,
  segments: z.array(z.unknown()).max(8).default([]).catch([]),
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
  timePlans: z.array(z.unknown()).max(6).default([]).catch([]),
  mustWatch: z.array(z.unknown()).max(10).default([]).catch([]),
  canWatch: z.array(z.unknown()).max(10).default([]).catch([]),
  canSkim: z.array(z.unknown()).max(10).default([]).catch([]),
  canSkip: z.array(z.unknown()).max(10).default([]).catch([]),
  reservations: textArraySchema,
});

const rawLearningGuideSchema = z.object({
  decision: decisionSchema,
  contentType: optionalText,
  contentTypeReason: optionalText,
  suggestedStance: optionalText,
});

export function parseLearningGuideJson(input: {
  readonly content: string;
  readonly generatedAt: number;
  readonly modelUsed: string;
  readonly outputLocale?: UiLocale;
}): LearningGuide {
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const jsonText = stripJsonFence(input.content);
  const parsed = rawLearningGuideSchema.parse(
    unwrapLearningGuideJson(parseJsonWithRepair(jsonText)),
  );
  const decision = normalizeDecision(parsed.decision, outputLocale);
  return {
    decision,
    contentType: parsed.contentType ?? getDefaultContentType(outputLocale),
    contentTypeReason: parsed.contentTypeReason ?? getDefaultContentTypeReason(outputLocale),
    suggestedStance: parsed.suggestedStance ?? decision.verdict,
    generatedAt: input.generatedAt,
    modelUsed: input.modelUsed,
  };
}

function unwrapLearningGuideJson(value: unknown): unknown {
  const record = getRecord(value);
  if (!record) return value;
  if (getRecord(record.decision)) return value;
  return (
    getRecord(record.guide) ??
    getRecord(record.learningGuide) ??
    getRecord(record.analysisGuide) ??
    getRecord(record.watchGuide) ??
    getRecord(record.result) ??
    value
  );
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeDecision(
  decision: z.infer<typeof decisionSchema>,
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
  const worthReasons = limitDecisionItems(decision.worthReasons, 3);
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
    bestFor: limitDecisionItems(decision.bestFor, 3),
    notFor: limitDecisionItems(decision.notFor, 3),
    learningValue: limitDecisionItems(decision.learningValue, 3),
    timePlans: normalizeTimePlans(decision.timePlans, outputLocale),
    mustWatch: normalizeSegments(decision.mustWatch, outputLocale),
    canWatch: normalizeSegments(decision.canWatch, outputLocale),
    canSkim: normalizeSegments(decision.canSkim, outputLocale),
    canSkip: normalizeSegments(decision.canSkip, outputLocale),
    reservations: limitDecisionItems(decision.reservations, 3),
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

function getDefaultContentType(outputLocale: UiLocale): string {
  return outputLocale === 'en-US' ? 'Video content' : '视频内容';
}

function getDefaultContentTypeReason(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'The model did not provide a content-type reason.'
    : '模型没有补充内容类型理由。';
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

function limitDecisionItems(items: readonly unknown[], limit: number): readonly string[] {
  return items
    .map((item) => normalizeTextValue(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, limit);
}

function normalizeSegments(
  segments: readonly unknown[],
  outputLocale: UiLocale,
): readonly LearningGuideDecisionSegment[] {
  return segments
    .map((segment) => {
      const parsed = decisionSegmentSchema.safeParse(segment);
      if (!parsed.success) return null;
      return normalizeSegment(parsed.data, outputLocale);
    })
    .filter((segment): segment is LearningGuideDecisionSegment => segment !== null);
}

function normalizeTimePlans(
  rawPlans: readonly unknown[],
  outputLocale: UiLocale,
): readonly LearningGuideTimePlan[] {
  const plans: LearningGuideTimePlan[] = [];
  for (const plan of rawPlans) {
    const parsed = rawTimePlanSchema.safeParse(plan);
    if (!parsed.success) continue;
    const budget = parsed.data.budget;
    plans.push({
      budget,
      label: parsed.data.label ?? getDefaultTimePlanLabel(budget, outputLocale),
      instruction:
        parsed.data.instruction ?? getDefaultTimePlanInstruction(outputLocale),
      segments: normalizeSegments(parsed.data.segments, outputLocale).slice(0, 6),
    });
    if (plans.length >= 4) break;
  }
  return plans;
}

function getDefaultTimePlanLabel(
  budget: LearningGuideTimePlan['budget'],
  outputLocale: UiLocale,
): string {
  if (outputLocale === 'en-US') {
    if (budget === '10min') return 'Only 10 minutes';
    if (budget === '20min') return 'Only 20 minutes';
    if (budget === '40min') return '40 minutes available';
    return 'Full watch';
  }
  if (budget === '10min') return '只有 10 分钟';
  if (budget === '20min') return '只有 20 分钟';
  if (budget === '40min') return '有 40 分钟';
  return '完整看完';
}

function getDefaultTimePlanInstruction(outputLocale: UiLocale): string {
  return outputLocale === 'en-US'
    ? 'Use the segments above to decide what to watch.'
    : '按上方片段取舍观看。';
}

function normalizeSegment(
  segment: z.infer<typeof decisionSegmentSchema>,
  outputLocale: UiLocale,
): LearningGuideDecisionSegment | null {
  const title = firstNonEmpty(segment.title, segment.reason);
  if (!title) return null;
  const reason = firstNonEmpty(
    segment.reason,
    segment.title,
    outputLocale === 'en-US'
      ? 'The model did not explain this segment.'
      : '模型没有说明片段理由。',
  );
  return {
    title,
    tag: segment.tag,
    reason,
    ...(segment.startTimestamp !== undefined ? { startTimestamp: segment.startTimestamp } : {}),
    ...(segment.endTimestamp !== undefined ? { endTimestamp: segment.endTimestamp } : {}),
  };
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
