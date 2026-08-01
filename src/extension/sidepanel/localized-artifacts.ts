import type { LearningSession, VideoAnalysis } from '@core/types';
import {
  getArtifactLocale,
  isGeneratedTextLikelyLocale,
  type UiLocale,
} from '@shared/locale-settings';

export function filterLearningSessionForLocale(
  session: LearningSession | null,
  locale: UiLocale,
): LearningSession | null {
  if (!session) {
    return null;
  }
  const guideCandidate = session.guidesByLocale?.[locale] ?? session.guide;
  const reviewCandidate = session.reviewsByLocale?.[locale] ?? session.review;
  const guide =
    guideCandidate && isLearningGuideVisibleForLocale(guideCandidate, locale)
      ? guideCandidate
      : undefined;
  const review =
    reviewCandidate && isLearningReviewVisibleForLocale(reviewCandidate, locale)
      ? reviewCandidate
      : undefined;
  const { guide: _guide, review: _review, ...rest } = session;
  return {
    ...rest,
    ...(guide ? { guide } : {}),
    ...(review ? { review } : {}),
  };
}

export function isVideoAnalysisVisibleForLocale(
  analysis: VideoAnalysis,
  locale: UiLocale,
): boolean {
  return (
    getArtifactLocale(analysis) === locale &&
    isGeneratedTextLikelyLocale(collectVideoAnalysisText(analysis), locale)
  );
}

function isLearningGuideVisibleForLocale(
  guide: NonNullable<LearningSession['guide']>,
  locale: UiLocale,
): boolean {
  return (
    getArtifactLocale(guide) === locale &&
    isGeneratedTextLikelyLocale(collectLearningGuideText(guide), locale)
  );
}

function isLearningReviewVisibleForLocale(
  review: NonNullable<LearningSession['review']>,
  locale: UiLocale,
): boolean {
  return (
    getArtifactLocale(review) === locale &&
    isGeneratedTextLikelyLocale(collectLearningReviewText(review), locale)
  );
}

function collectVideoAnalysisText(analysis: VideoAnalysis): string {
  return [
    analysis.overview,
    ...analysis.coreTakeaways,
    analysis.reviewSummary,
    ...analysis.chapters.flatMap((chapter) => [
      chapter.title,
      chapter.summary,
      chapter.watchGuide ?? '',
      ...chapter.segments.flatMap((segment) => [
        segment.title,
        segment.summary,
        segment.watchPrompt ?? '',
      ]),
    ]),
  ].join('\n');
}

function collectLearningGuideText(guide: NonNullable<LearningSession['guide']>): string {
  const decision = guide.decision;
  return [
    guide.contentType,
    guide.contentTypeReason,
    guide.suggestedStance,
    decision.valueProfile.label,
    ...decision.valueProfile.criteria.map((criterion) => criterion.label),
    decision.verdict,
    decision.overallMeaning,
    decision.reason,
    ...(decision.worthReasons ?? []),
    ...decision.bestFor,
    ...decision.notFor,
    ...(decision.learningValue ?? []),
    ...decision.mustWatch.flatMap((segment) => [segment.title, segment.reason]),
    ...decision.canWatch.flatMap((segment) => [segment.title, segment.reason]),
    ...decision.canSkim.flatMap((segment) => [segment.title, segment.reason]),
    ...decision.canSkip.flatMap((segment) => [segment.title, segment.reason]),
    ...decision.reservations,
  ].join('\n');
}

function collectLearningReviewText(review: NonNullable<LearningSession['review']>): string {
  return [
    review.coreSummary,
    ...review.keyIdeas.flatMap((idea) => [idea.title, idea.explanation]),
    ...review.personalInsights,
    review.transferReflection ?? '',
    ...review.openQuestions,
    ...review.actionItems,
    review.finalReflection,
  ].join('\n');
}
