import type { CachedAnalysisValue } from '@core/storage/analysis-cache';
import type { ContentContextCacheValue } from '@core/storage/content-context-cache';
import { createModelAnalysisTimingLabel } from '@core/analysis/timing-labels';
import { LearningGuideGenerationTimeoutError } from '@core/learning/generate-learning-guide';
import { createContentContextDigest } from '@core/learning/content-context-digest';
import type { WatchDecisionPackage } from '@core/learning/watch-decision-package-schema';
import type {
  LearningExchange,
  LearningCoachSettings,
  LearningGuide,
  LearningGoal,
  LearningMoment,
  LearningMomentCoach,
  LearningMomentKind,
  LearningMomentSource,
  LearningReview,
  LearningSession,
  VideoAnalysis,
  VideoPlatform,
} from '@core/types';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import {
  DEFAULT_UI_LOCALE,
  getArtifactLocale,
  isGeneratedTextLikelyLocale,
  type UiLocale,
} from '@shared/locale-settings';
import {
  createTextProviderMissingMessage,
  hasConfiguredTextProvider,
  type LegacyAnalysisMode,
  type TextProviderSettings,
} from '@shared/settings';
import { createSubtitlePreferenceKey } from '@core/subtitles/language-preference';

const MAX_REVIEW_EXCHANGES = 8;
const LEARNING_GUIDE_GENERATION_FAILED_MESSAGE =
  '分析生成失败：模型输出不完整或格式异常。如已有旧分析，会继续保留；请稍后重试。';
const LEARNING_GUIDE_GENERATION_TIMEOUT_MESSAGE =
  '分析生成超时：模型这次没有在 3 分钟内完成。旧分析已保留，可以稍后重试。';

export type LearningReviewRequest = Extract<
  ExtensionRequest,
  {
    type:
      | 'UPDATE_LEARNING_GOAL'
      | 'UPDATE_LEARNING_COACH'
      | 'GENERATE_LEARNING_GUIDE'
      | 'ADD_LEARNING_MOMENT'
      | 'UPDATE_LEARNING_MOMENT'
      | 'REMOVE_LEARNING_MOMENT'
      | 'PROCESS_LEARNING_MOMENT'
      | 'SAVE_LEARNING_EXCHANGE'
      | 'GENERATE_LEARNING_REVIEW'
      | 'GET_LEARNING_SESSION';
  }
>;

export interface ActiveLearningContext {
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly contentKey: string;
}

type LearningAiInputDeps = Pick<
  LearningReviewHandlerDeps,
  | 'readSettings'
  | 'getContentContext'
  | 'getCachedAnalysis'
  | 'getOrCreateLearningSession'
  | 'createErrorResponse'
  | 'getSubtitleLanguages'
>;

type WatchDecisionSaveDeps = Pick<
  LearningReviewHandlerDeps,
  'saveCachedAnalysis' | 'saveLearningGuide'
>;

export interface PreparedLearningInput {
  readonly settings: TextProviderSettings;
  readonly metadata: ContentContextCacheValue['metadata'];
  readonly transcriptCues: ContentContextCacheValue['transcriptCues'];
  readonly analysis: CachedAnalysisValue['analysis'] | null;
  readonly session: LearningSession;
  readonly contextDigest: string;
  readonly outputLocale: UiLocale;
  readonly subtitlePreferenceKey?: string;
}

export interface LearningReviewHandlerDeps {
  readonly getActiveVideoContext: () => Promise<ActiveLearningContext | null>;
  readonly readSettings: () => Promise<TextProviderSettings>;
  readonly getContentContext: (
    context: ActiveLearningContext & { readonly subtitlePreferenceKey?: string },
  ) => Promise<ContentContextCacheValue | null>;
  readonly getCachedAnalysis: (
    context: ActiveLearningContext & {
      readonly sourceMode?: VideoAnalysis['sourceMode'];
      readonly outputLocale?: UiLocale;
      readonly subtitlePreferenceKey?: string;
    },
  ) => Promise<CachedAnalysisValue | null>;
  readonly getLearningSession: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
  }) => Promise<LearningSession | null>;
  readonly getOrCreateLearningSession: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
  }) => Promise<LearningSession>;
  readonly updateLearningGoal: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly goal: LearningGoal;
  }) => Promise<LearningSession>;
  readonly updateLearningCoach: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly coach: LearningCoachSettings;
  }) => Promise<LearningSession>;
  readonly saveLearningGuide: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly guide: LearningGuide;
  }) => Promise<LearningSession>;
  readonly saveCachedAnalysis: (value: CachedAnalysisValue) => Promise<void>;
  readonly appendLearningMoment: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly kind: LearningMomentKind;
    readonly content: string;
    readonly source?: LearningMomentSource;
    readonly originTitle?: string;
    readonly timestamp?: number;
  }) => Promise<LearningSession>;
  readonly updateLearningMoment: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly momentId: string;
    readonly kind: LearningMomentKind;
    readonly content: string;
  }) => Promise<LearningSession>;
  readonly removeLearningMoment: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly momentId: string;
  }) => Promise<LearningSession>;
  readonly saveLearningMomentCoach: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly momentId: string;
    readonly coach: LearningMomentCoach;
  }) => Promise<LearningSession>;
  readonly saveLearningExchange: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly exchange: LearningExchange;
  }) => Promise<LearningSession | null>;
  readonly saveLearningReview: (input: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
    readonly review: LearningReview;
  }) => Promise<LearningSession>;
  readonly generateLearningReview: (input: {
    readonly settings: TextProviderSettings;
    readonly metadata: ContentContextCacheValue['metadata'];
    readonly transcriptCues: ContentContextCacheValue['transcriptCues'];
    readonly analysis: CachedAnalysisValue['analysis'] | null;
    readonly session: LearningSession;
    readonly outputLocale: UiLocale;
  }) => Promise<LearningReview>;
  readonly generateLearningGuide: (input: {
    readonly settings: TextProviderSettings;
    readonly metadata: ContentContextCacheValue['metadata'];
    readonly transcriptCues: ContentContextCacheValue['transcriptCues'];
    readonly analysis: CachedAnalysisValue['analysis'] | null;
    readonly session: LearningSession;
    readonly outputLocale: UiLocale;
  }) => Promise<LearningGuide>;
  readonly generateWatchDecisionPackage: (input: {
    readonly settings: TextProviderSettings;
    readonly metadata: ContentContextCacheValue['metadata'];
    readonly transcriptCues: ContentContextCacheValue['transcriptCues'];
    readonly session: LearningSession;
    readonly outputLocale: UiLocale;
  }) => Promise<WatchDecisionPackage>;
  readonly generateLearningMomentCoach: (input: {
    readonly settings: TextProviderSettings;
    readonly metadata: ContentContextCacheValue['metadata'];
    readonly transcriptCues: ContentContextCacheValue['transcriptCues'];
    readonly analysis: CachedAnalysisValue['analysis'] | null;
    readonly session: LearningSession;
    readonly moment: LearningMoment;
  }) => Promise<LearningMomentCoach>;
  readonly createErrorResponse: (code: string, message: string) => ExtensionResponse;
  /** 扩展层读取浏览器字幕语言偏好。 */
  readonly getSubtitleLanguages?: () => Promise<readonly string[]>;
}

export function createLearningReviewHandler(
  deps: LearningReviewHandlerDeps,
): (request: LearningReviewRequest) => Promise<ExtensionResponse> {
  return async (request) => {
    const context = await deps.getActiveVideoContext();
    if (!context) {
      if (request.type === 'GET_LEARNING_SESSION') {
        return { ok: true, type: 'LEARNING_SESSION', payload: null };
      }
      return deps.createErrorResponse('NO_PAGE_CONTEXT', '还没有检测到当前视频页面');
    }

    const identity = {
      platform: context.platform,
      contentKey: context.contentKey,
    };

    switch (request.type) {
      case 'GET_LEARNING_SESSION':
        return {
          ok: true,
          type: 'LEARNING_SESSION',
          payload: dropLegacyLearningGuide(await deps.getLearningSession(identity)),
        };

      case 'UPDATE_LEARNING_GOAL': {
        const session = await deps.updateLearningGoal({
          ...identity,
          goal: request.payload,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: session };
      }

      case 'UPDATE_LEARNING_COACH': {
        const session = await deps.updateLearningCoach({
          ...identity,
          coach: request.payload,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: session };
      }

      case 'GENERATE_LEARNING_GUIDE': {
        const outputLocale = request.payload?.outputLocale ?? DEFAULT_UI_LOCALE;
        const prepared = await prepareAiLearningInput(
          deps,
          context,
          identity,
          request.payload?.analysisMode,
          outputLocale,
        );
        if (!prepared.ok) return prepared.error;
        if (
          prepared.session.guide &&
          request.payload?.forceRefresh !== true &&
          isReusableLearningGuide({
            guide: prepared.session.guide,
            analysis: prepared.analysis,
            contextDigest: prepared.contextDigest,
            outputLocale,
          })
        ) {
          return {
            ok: true,
            type: 'LEARNING_SESSION',
            payload: prepared.session,
          };
        }
        let generated: LearningGuide;
        const generationStartedAt = Date.now();
        try {
          generated = await deps.generateLearningGuide({
            settings: prepared.settings,
            metadata: prepared.metadata,
            transcriptCues: prepared.transcriptCues,
            analysis: prepared.analysis,
            session: prepared.session,
            outputLocale,
          });
        } catch (error) {
          return createLearningGuideGenerationErrorResponse(deps, error);
        }
        const generationDurationMs = Math.max(0, Date.now() - generationStartedAt);
        const guideWithMetadata: LearningGuide = {
          ...generated,
          outputLocale,
          contextDigest: prepared.contextDigest,
          generationDurationMs,
          ...(prepared.analysis?.timelineDigest
            ? { timelineDigest: prepared.analysis.timelineDigest }
            : {}),
        };
        const saved = await deps.saveLearningGuide({
          ...identity,
          guide: guideWithMetadata,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: saved };
      }

      case 'ADD_LEARNING_MOMENT': {
        if (!request.payload.content.trim()) {
          return deps.createErrorResponse('EMPTY_LEARNING_MOMENT', '记录内容不能为空');
        }
        const session = await deps.appendLearningMoment({
          ...identity,
          kind: request.payload.kind,
          content: request.payload.content,
          ...(request.payload.source ? { source: request.payload.source } : {}),
          ...(request.payload.originTitle ? { originTitle: request.payload.originTitle } : {}),
          ...(request.payload.timestamp !== undefined
            ? { timestamp: request.payload.timestamp }
            : {}),
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: session };
      }

      case 'UPDATE_LEARNING_MOMENT': {
        if (!request.payload.content.trim()) {
          return deps.createErrorResponse('EMPTY_LEARNING_MOMENT', '记录内容不能为空');
        }
        const session = await deps.updateLearningMoment({
          ...identity,
          momentId: request.payload.momentId,
          kind: request.payload.kind,
          content: request.payload.content,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: session };
      }

      case 'PROCESS_LEARNING_MOMENT': {
        const prepared = await prepareAiLearningInput(
          deps,
          context,
          identity,
          request.payload.analysisMode,
          DEFAULT_UI_LOCALE,
        );
        if (!prepared.ok) return prepared.error;
        const moment = prepared.session.moments.find(
          (item) => item.id === request.payload.momentId,
        );
        if (!moment) {
          return deps.createErrorResponse('LEARNING_MOMENT_NOT_FOUND', '没有找到这条学习记录');
        }
        const coach = await deps.generateLearningMomentCoach({
          ...prepared,
          moment,
        });
        const saved = await deps.saveLearningMomentCoach({
          ...identity,
          momentId: moment.id,
          coach,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: saved };
      }

      case 'REMOVE_LEARNING_MOMENT': {
        const session = await deps.removeLearningMoment({
          ...identity,
          momentId: request.payload.momentId,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: session };
      }

      case 'SAVE_LEARNING_EXCHANGE': {
        if (!request.payload.question.trim() || !request.payload.answer.trim()) {
          return deps.createErrorResponse(
            'EMPTY_LEARNING_EXCHANGE',
            '只有完整问答才能加入学习笔记',
          );
        }
        if (request.payload.includedInReview === true) {
          const current = await deps.getOrCreateLearningSession(identity);
          const includedCountWithoutCurrent = current.exchanges.filter(
            (exchange) => exchange.includedInReview === true && exchange.id !== request.payload.id,
          ).length;
          if (includedCountWithoutCurrent >= MAX_REVIEW_EXCHANGES) {
            return deps.createErrorResponse(
              'TOO_MANY_REVIEW_EXCHANGES',
              `最多只能加入 ${MAX_REVIEW_EXCHANGES} 条提问问答到学习笔记`,
            );
          }
        }
        const session = await deps.saveLearningExchange({
          ...identity,
          exchange: request.payload,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: session };
      }

      case 'GENERATE_LEARNING_REVIEW': {
        const outputLocale = request.payload?.outputLocale ?? DEFAULT_UI_LOCALE;
        const prepared = await prepareAiLearningInput(
          deps,
          context,
          identity,
          request.payload?.analysisMode,
          outputLocale,
        );
        if (!prepared.ok) return prepared.error;
        if (
          prepared.session.review &&
          getArtifactLocale(prepared.session.review) === outputLocale &&
          request.payload?.forceRefresh !== true
        ) {
          return {
            ok: true,
            type: 'LEARNING_SESSION',
            payload: prepared.session,
          };
        }
        let review: LearningReview;
        try {
          review = await deps.generateLearningReview(prepared);
        } catch {
          return deps.createErrorResponse(
            'LEARNING_REVIEW_GENERATION_FAILED',
            '学习笔记生成失败：模型输出不完整或格式异常，请重试。',
          );
        }
        const reviewWithDigest: LearningReview = {
          ...review,
          outputLocale,
          contextDigest: prepared.contextDigest,
          ...(prepared.analysis?.timelineDigest
            ? { timelineDigest: prepared.analysis.timelineDigest }
            : {}),
        };
        const saved = await deps.saveLearningReview({
          ...identity,
          review: reviewWithDigest,
        });
        return { ok: true, type: 'LEARNING_SESSION', payload: saved };
      }
    }
  };
}

export async function prepareAiLearningInput(
  deps: LearningAiInputDeps,
  context: ActiveLearningContext,
  identity: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
  },
  requestedAnalysisMode: LegacyAnalysisMode | undefined,
  outputLocale: UiLocale = DEFAULT_UI_LOCALE,
): Promise<
  | {
      readonly ok: true;
      readonly settings: TextProviderSettings;
      readonly metadata: ContentContextCacheValue['metadata'];
      readonly transcriptCues: ContentContextCacheValue['transcriptCues'];
      readonly analysis: CachedAnalysisValue['analysis'] | null;
      readonly session: LearningSession;
      readonly contextDigest: string;
      readonly outputLocale: UiLocale;
      readonly subtitlePreferenceKey?: string;
    }
  | { readonly ok: false; readonly error: ExtensionResponse }
> {
  const settings = await deps.readSettings();
  const effectiveMode = requestedAnalysisMode ?? settings.analysisMode;
  if (effectiveMode !== 'subtitle') {
    return {
      ok: false,
      error: deps.createErrorResponse(
        'UNSUPPORTED_ANALYSIS_MODE',
        '公开版只支持基于字幕内容生成视频分析和学习笔记；本地转写和视频理解实验已移除。',
      ),
    };
  }

  if (!hasConfiguredTextProvider(settings)) {
    return {
      ok: false,
      error: deps.createErrorResponse(
        'MINIMAX_API_KEY_MISSING',
        createTextProviderMissingMessage(settings),
      ),
    };
  }
  const rawSession = await deps.getOrCreateLearningSession(identity);

  const subtitlePreferenceKey = createSubtitlePreferenceKey(
    (await deps.getSubtitleLanguages?.()) ?? [],
  );

  const content = await deps.getContentContext({ ...context, subtitlePreferenceKey });

  if (!content) {
    return {
      ok: false,
      error: deps.createErrorResponse('CONTENT_CONTEXT_REQUIRED', '请先开启当前视频内容'),
    };
  }

  const contextDigest = createContentContextDigest({
    metadata: content.metadata,
    transcriptCues: content.transcriptCues,
  });
  const cachedAnalysis = await deps.getCachedAnalysis({
    ...context,
    sourceMode: 'subtitle',
    outputLocale,
    subtitlePreferenceKey,
  });
  const analysis =
    cachedAnalysis?.analysis.contextDigest === contextDigest ? cachedAnalysis.analysis : null;
  const session = filterSessionDerivedArtifacts({
    session: rawSession,
    analysis,
    contextDigest,
    outputLocale,
  });
  return {
    ok: true,
    settings,
    metadata: content.metadata,
    transcriptCues: content.transcriptCues,
    analysis,
    session,
    contextDigest,
    outputLocale,
    subtitlePreferenceKey,
  };
}

export async function saveWatchDecisionPackageResult(input: {
  readonly deps: WatchDecisionSaveDeps;
  readonly identity: {
    readonly platform: VideoPlatform;
    readonly contentKey: string;
  };
  readonly prepared: PreparedLearningInput;
  readonly generated: WatchDecisionPackage;
  readonly generationDurationMs: number;
}): Promise<LearningSession> {
  await input.deps.saveCachedAnalysis({
    metadata: input.prepared.metadata,
    analysis: { ...input.generated.analysis, outputLocale: input.prepared.outputLocale },
    subtitleCueCount: input.prepared.transcriptCues.length,
    transcriptCues: input.prepared.transcriptCues,
    ...(input.prepared.subtitlePreferenceKey
      ? { subtitlePreferenceKey: input.prepared.subtitlePreferenceKey }
      : {}),
    timings: [
      {
        label: createModelAnalysisTimingLabel(input.generated.analysis.modelUsed),
        durationMs: input.generationDurationMs,
      },
      { label: '总耗时', durationMs: input.generationDurationMs },
    ],
  });
  return input.deps.saveLearningGuide({
    ...input.identity,
    guide: { ...input.generated.guide, outputLocale: input.prepared.outputLocale },
  });
}

export function createWatchDecisionPackageGenerationErrorResponse(
  deps: Pick<LearningReviewHandlerDeps, 'createErrorResponse'>,
  error: unknown,
): ExtensionResponse {
  if (error instanceof LearningGuideGenerationTimeoutError) {
    return deps.createErrorResponse(
      'LEARNING_GUIDE_GENERATION_TIMEOUT',
      LEARNING_GUIDE_GENERATION_TIMEOUT_MESSAGE,
    );
  }
  return deps.createErrorResponse(
    'LEARNING_GUIDE_GENERATION_FAILED',
    LEARNING_GUIDE_GENERATION_FAILED_MESSAGE,
  );
}

export function createLearningGuideGenerationErrorResponse(
  deps: Pick<LearningReviewHandlerDeps, 'createErrorResponse'>,
  error: unknown,
): ExtensionResponse {
  return createWatchDecisionPackageGenerationErrorResponse(deps, error);
}

export function isReusableWatchDecisionPackage(input: {
  readonly guide: LearningGuide;
  readonly analysis: VideoAnalysis;
  readonly contextDigest: string;
  readonly outputLocale?: UiLocale;
}): boolean {
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  return (
    input.guide.contextDigest === input.contextDigest &&
    input.analysis.contextDigest === input.contextDigest &&
    getArtifactLocale(input.guide) === outputLocale &&
    getArtifactLocale(input.analysis) === outputLocale &&
    input.guide.timelineDigest !== undefined &&
    input.guide.timelineDigest === input.analysis.timelineDigest
  );
}

export function isReusableLearningGuide(input: {
  readonly guide: LearningGuide;
  readonly analysis: VideoAnalysis | null;
  readonly contextDigest: string;
  readonly outputLocale?: UiLocale;
}): boolean {
  if (!hasValueProfile(input.guide)) {
    return false;
  }
  if (input.guide.contextDigest !== input.contextDigest) {
    return false;
  }
  if (getArtifactLocale(input.guide) !== (input.outputLocale ?? DEFAULT_UI_LOCALE)) {
    return false;
  }
  if (
    !isGeneratedTextLikelyLocale(
      collectLearningGuideText(input.guide),
      input.outputLocale ?? DEFAULT_UI_LOCALE,
    )
  ) {
    return false;
  }
  if (input.guide.timelineDigest === undefined) {
    return true;
  }
  return input.guide.timelineDigest === input.analysis?.timelineDigest;
}

function hasValueProfile(guide: LearningGuide): boolean {
  const decision = (guide as unknown as { decision?: { valueProfile?: unknown } }).decision;
  const profile = decision?.valueProfile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return false;
  }
  const criteria = (profile as { criteria?: unknown }).criteria;
  return Array.isArray(criteria) && criteria.length >= 3;
}

function collectLearningGuideText(guide: LearningGuide): string {
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

function dropLegacyLearningGuide(session: LearningSession | null): LearningSession | null {
  if (!session?.guide || hasValueProfile(session.guide)) {
    return session;
  }
  const { guide: _guide, ...rest } = session;
  return rest;
}

function filterSessionDerivedArtifacts(input: {
  readonly session: LearningSession;
  readonly analysis: VideoAnalysis | null;
  readonly contextDigest: string;
  readonly outputLocale: UiLocale;
}): LearningSession {
  const guideCandidate = input.session.guidesByLocale?.[input.outputLocale] ?? input.session.guide;
  const reviewCandidate =
    input.session.reviewsByLocale?.[input.outputLocale] ?? input.session.review;
  const guideReusable = guideCandidate
    ? isReusableLearningGuide({
        guide: guideCandidate,
        analysis: input.analysis,
        contextDigest: input.contextDigest,
        outputLocale: input.outputLocale,
      })
    : false;
  const reviewReusable =
    reviewCandidate !== undefined &&
    reviewCandidate.contextDigest === input.contextDigest &&
    getArtifactLocale(reviewCandidate) === input.outputLocale &&
    (reviewCandidate.timelineDigest === undefined ||
      reviewCandidate.timelineDigest === input.analysis?.timelineDigest);

  if (
    guideReusable &&
    reviewReusable &&
    guideCandidate === input.session.guide &&
    reviewCandidate === input.session.review
  ) {
    return input.session;
  }

  const { guide: _guide, review: _review, ...rest } = input.session;
  return {
    ...rest,
    ...(guideReusable && guideCandidate ? { guide: guideCandidate } : {}),
    ...(reviewReusable && reviewCandidate ? { review: reviewCandidate } : {}),
  };
}
