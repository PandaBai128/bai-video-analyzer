import { LearningGuideGenerationTimeoutError, LEARNING_GUIDE_GENERATION_TIMEOUT_MS } from '@core/learning/generate-learning-guide';
import { generateWatchDecisionPackage } from '@core/learning/generate-watch-decision-package';
import type { WatchDecisionPackage } from '@core/learning/watch-decision-package-schema';
import type { LearningSession } from '@core/types';
import type { WatchDecisionPortMessage } from '@shared/messages';
import type { LegacyAnalysisMode } from '@shared/settings';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import {
  createWatchDecisionPackageGenerationErrorResponse,
  isReusableWatchDecisionPackage,
  prepareAiLearningInput,
  saveWatchDecisionPackageResult,
  type ActiveLearningContext,
  type LearningReviewHandlerDeps,
  type PreparedLearningInput,
} from './handlers/learning-review-handler';

export interface WatchDecisionControllerDeps
  extends Pick<
    LearningReviewHandlerDeps,
    | 'getActiveVideoContext'
    | 'readSettings'
    | 'getContentContext'
    | 'getCachedAnalysis'
    | 'getOrCreateLearningSession'
    | 'saveCachedAnalysis'
    | 'saveLearningGuide'
    | 'getSubtitleLanguages'
    | 'createErrorResponse'
  > {
  readonly postMessage: (message: WatchDecisionPortMessage) => void;
  readonly now?: () => number;
  readonly generatePackage?: (input: {
    readonly prepared: PreparedLearningInput;
    readonly signal: AbortSignal;
  }) => Promise<WatchDecisionPackage>;
}

export interface WatchDecisionController {
  handleRequest(input: {
    readonly requestId: string;
    readonly analysisMode?: LegacyAnalysisMode;
    readonly forceRefresh?: boolean;
    readonly outputLocale?: UiLocale;
  }): Promise<void>;
  handleCancel(input: { readonly requestId: string }): void;
  handleDisconnect(): void;
}

interface InFlightRequest {
  readonly requestId: string;
  readonly abort: AbortController;
}

const PHASES = {
  context: '正在读取当前视频',
  prepare: '正在准备字幕和缓存',
  cacheHit: '已恢复上次判断和时间线',
  llm: '正在稳定生成结构化结果，完成后一次性展示',
  save: '正在保存判断和时间线',
} as const;

export function createWatchDecisionController(
  deps: WatchDecisionControllerDeps,
): WatchDecisionController {
  const now = deps.now ?? Date.now;
  let inFlight: InFlightRequest | null = null;

  function abortInFlight(): void {
    if (!inFlight) return;
    inFlight.abort.abort();
    inFlight = null;
  }

  function isCurrent(requestId: string): boolean {
    return inFlight?.requestId === requestId;
  }

  function postStatus(requestId: string, text: string): void {
    deps.postMessage({ type: 'WATCH_DECISION_STATUS', requestId, text });
  }

  function postDone(input: {
    readonly requestId: string;
    readonly session: LearningSession | null;
    readonly elapsedMs: number;
    readonly receivedCharacters: number;
    readonly reused?: boolean;
  }): void {
    deps.postMessage({
      type: 'WATCH_DECISION_DONE',
      requestId: input.requestId,
      session: input.session,
      elapsedMs: input.elapsedMs,
      receivedCharacters: input.receivedCharacters,
      ...(input.reused === true ? { reused: true } : {}),
    });
  }

  function postError(requestId: string, code: string, message: string): void {
    deps.postMessage({ type: 'WATCH_DECISION_ERROR', requestId, code, message });
  }

  async function handleRequest(input: {
    readonly requestId: string;
    readonly analysisMode?: LegacyAnalysisMode;
    readonly forceRefresh?: boolean;
    readonly outputLocale?: UiLocale;
  }): Promise<void> {
    if (inFlight && inFlight.requestId !== input.requestId) {
      abortInFlight();
    }
    if (inFlight?.requestId === input.requestId) {
      return;
    }

    const abort = new AbortController();
    inFlight = { requestId: input.requestId, abort };
    const startedAt = now();
    let timedOut = false;
    let receivedCharacters = 0;
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, LEARNING_GUIDE_GENERATION_TIMEOUT_MS);

    try {
      postStatus(input.requestId, PHASES.context);
      const context = await deps.getActiveVideoContext();
      if (!context) {
        postError(input.requestId, 'NO_PAGE_CONTEXT', '还没有检测到当前视频页面');
        return;
      }
      const identity = toLearningIdentity(context);

      postStatus(input.requestId, PHASES.prepare);
      const prepared = await prepareAiLearningInput(
        deps,
        context,
        identity,
        input.analysisMode,
        input.outputLocale ?? DEFAULT_UI_LOCALE,
      );
      if (!prepared.ok) {
        const error = prepared.error.ok === false ? prepared.error.error : null;
        postError(
          input.requestId,
          error?.code ?? 'WATCH_DECISION_PREPARE_FAILED',
          error?.message ?? '观看判断生成前置检查失败',
        );
        return;
      }

      if (
        prepared.session.guide &&
        prepared.analysis &&
        input.forceRefresh !== true &&
        isReusableWatchDecisionPackage({
          guide: prepared.session.guide,
          analysis: prepared.analysis,
          contextDigest: prepared.contextDigest,
          outputLocale: prepared.outputLocale,
        })
      ) {
        postStatus(input.requestId, PHASES.cacheHit);
        postDone({
          requestId: input.requestId,
          session: prepared.session,
          elapsedMs: Math.max(0, now() - startedAt),
          receivedCharacters,
          reused: true,
        });
        return;
      }

      postStatus(input.requestId, PHASES.llm);
      const generated = await runGeneratePackage({
        deps,
        prepared: prepared,
        signal: abort.signal,
      });
      if (!isCurrent(input.requestId)) return;

      postStatus(input.requestId, PHASES.save);
      const generationDurationMs = Math.max(0, now() - startedAt);
      const saved = await saveWatchDecisionPackageResult({
        deps,
        identity,
        prepared,
        generated,
        generationDurationMs,
      });
      if (!isCurrent(input.requestId)) return;
      postDone({
        requestId: input.requestId,
        session: saved,
        elapsedMs: generationDurationMs,
        receivedCharacters,
      });
    } catch (error) {
      if (abort.signal.aborted && !timedOut) {
        return;
      }
      if (!isCurrent(input.requestId)) return;
      const response = createWatchDecisionPackageGenerationErrorResponse(
        deps,
        timedOut ? new LearningGuideGenerationTimeoutError(LEARNING_GUIDE_GENERATION_TIMEOUT_MS) : error,
      );
      if (response.ok === false) {
        postError(input.requestId, response.error.code, response.error.message);
      }
    } finally {
      globalThis.clearTimeout(timeoutId);
      if (inFlight?.requestId === input.requestId) {
        inFlight = null;
      }
    }
  }

  function handleCancel(input: { readonly requestId: string }): void {
    if (inFlight?.requestId === input.requestId) {
      abortInFlight();
    }
  }

  function handleDisconnect(): void {
    abortInFlight();
  }

  return {
    handleRequest,
    handleCancel,
    handleDisconnect,
  };
}

function toLearningIdentity(context: ActiveLearningContext): {
  readonly platform: ActiveLearningContext['platform'];
  readonly contentKey: string;
} {
  return {
    platform: context.platform,
    contentKey: context.contentKey,
  };
}

async function runGeneratePackage(input: {
  readonly deps: WatchDecisionControllerDeps;
  readonly prepared: PreparedLearningInput;
  readonly signal: AbortSignal;
}): Promise<WatchDecisionPackage> {
  if (input.deps.generatePackage) {
    return input.deps.generatePackage({
      prepared: input.prepared,
      signal: input.signal,
    });
  }
  return generateWatchDecisionPackage({
    settings: input.prepared.settings,
    metadata: input.prepared.metadata,
    transcriptCues: input.prepared.transcriptCues,
    session: input.prepared.session,
    outputLocale: input.prepared.outputLocale,
    signal: input.signal,
  });
}
