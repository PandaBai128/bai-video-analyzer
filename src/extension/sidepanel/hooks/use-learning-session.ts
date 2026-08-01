import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LearningCoachSettings,
  LearningExchange,
  LearningGoal,
  LearningMomentKind,
  LearningMomentSource,
  LearningSession,
} from '@core/types';
import { LEARNING_GUIDE_GENERATION_TIMEOUT_MS } from '@core/learning/generate-learning-guide';
import { sendRuntimeMessage } from '@shared/extension-runtime';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { AnalysisMode } from '@shared/settings';
import type { UiLocale } from '@shared/locale-settings';
import { localizeUnknownError, localizeUserMessage } from '@extension/ui/localized-error';

export interface UseLearningSessionOptions {
  readonly contextKey: string;
  readonly analysisMode?: AnalysisMode;
  readonly outputLocale?: UiLocale;
  readonly setStatus: (status: string) => void;
  readonly t?: (zh: string, en: string) => string;
  readonly sendMessage?: (message: ExtensionRequest) => Promise<ExtensionResponse>;
}

export interface UseLearningSessionResult {
  readonly session: LearningSession | null;
  readonly isMutating: boolean;
  readonly isGenerating: boolean;
  readonly isGeneratingGuide: boolean;
  readonly guideGenerationStartedAt: number | null;
  readonly guideGenerationStatus: string;
  readonly guideGenerationCharacterCount: number;
  readonly processingMomentId: string | null;
  readonly loadSession: () => Promise<void>;
  readonly updateGoal: (goal: LearningGoal) => Promise<void>;
  readonly updateCoach: (coach: LearningCoachSettings) => Promise<void>;
  readonly generateGuide: (forceRefresh?: boolean) => Promise<void>;
  readonly cancelGuideGeneration: () => void;
  readonly addMoment: (input: {
    readonly kind: LearningMomentKind;
    readonly content: string;
    readonly source?: LearningMomentSource;
    readonly originTitle?: string;
    readonly timestamp?: number;
  }) => Promise<LearningSession | null>;
  readonly updateMoment: (input: {
    readonly momentId: string;
    readonly kind: LearningMomentKind;
    readonly content: string;
  }) => Promise<void>;
  readonly removeMoment: (momentId: string) => Promise<void>;
  readonly processMoment: (momentId: string) => Promise<void>;
  readonly toggleExchangeInReview: (
    exchange: LearningExchange,
    includedInReview: boolean,
  ) => Promise<void>;
  readonly generateReview: (forceRefresh?: boolean) => Promise<void>;
}

const defaultSendMessage = (message: ExtensionRequest): Promise<ExtensionResponse> =>
  sendRuntimeMessage(message);

export const SIDE_PANEL_GUIDE_REQUEST_TIMEOUT_MS = LEARNING_GUIDE_GENERATION_TIMEOUT_MS;
type GuideGenerationCancelReason = 'user' | 'context_changed';
type GuideGenerationRaceResult =
  | { readonly kind: 'response'; readonly response: ExtensionResponse }
  | { readonly kind: 'transport_error'; readonly message: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled'; readonly reason: GuideGenerationCancelReason };

interface GuideGenerationSnapshot {
  readonly requestId: number;
  readonly startedAt: number;
  readonly status: string;
  readonly characterCount: number;
  readonly cancel: (reason: GuideGenerationCancelReason) => void;
}

export function useLearningSession(options: UseLearningSessionOptions): UseLearningSessionResult {
  const {
    contextKey,
    analysisMode = 'subtitle',
    outputLocale = 'zh-CN',
    setStatus,
    sendMessage = defaultSendMessage,
    t = (zh: string) => zh,
  } = options;
  const [session, setSession] = useState<LearningSession | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingGuide, setIsGeneratingGuide] = useState(false);
  const [guideGenerationStartedAt, setGuideGenerationStartedAt] = useState<number | null>(null);
  const [guideGenerationStatus, setGuideGenerationStatus] = useState('');
  const [guideGenerationCharacterCount, setGuideGenerationCharacterCount] = useState(0);
  const [processingMomentId, setProcessingMomentId] = useState<string | null>(null);
  const contextKeyRef = useRef(contextKey);
  const callbacksRef = useRef({ setStatus, sendMessage, outputLocale });
  const nextGuideRequestIdRef = useRef(0);
  const guideGenerationByContextRef = useRef<Map<string, GuideGenerationSnapshot>>(new Map());
  const sessionByContextRef = useRef<Map<string, LearningSession | null>>(new Map());
  callbacksRef.current = { setStatus, sendMessage, outputLocale };

  const clearGuideGenerationState = useCallback((): void => {
    setIsGeneratingGuide(false);
    setGuideGenerationStartedAt(null);
    setGuideGenerationStatus('');
    setGuideGenerationCharacterCount(0);
  }, []);

  const cancelGuideGeneration = useCallback((): void => {
    guideGenerationByContextRef.current.get(contextKeyRef.current)?.cancel('user');
  }, []);

  const loadSession = useCallback(async (): Promise<void> => {
    const requestedKey = contextKeyRef.current;
    const response = await callbacksRef.current.sendMessage({
      type: 'GET_LEARNING_SESSION',
    });
    if (contextKeyRef.current !== requestedKey) return;
    if (response.ok && response.type === 'LEARNING_SESSION') {
      sessionByContextRef.current.set(requestedKey, response.payload);
      setSession(response.payload);
    }
  }, []);

  useEffect(() => {
    contextKeyRef.current = contextKey;
    setSession(sessionByContextRef.current.get(contextKey) ?? null);
    const activeGuide = guideGenerationByContextRef.current.get(contextKey);
    if (activeGuide) {
      setIsGeneratingGuide(true);
      setGuideGenerationStartedAt(activeGuide.startedAt);
      setGuideGenerationStatus(activeGuide.status);
      setGuideGenerationCharacterCount(activeGuide.characterCount);
    } else {
      clearGuideGenerationState();
    }
    if (contextKey) {
      void loadSession();
    }
  }, [clearGuideGenerationState, contextKey, loadSession]);

  const runMutation = useCallback(
    async (message: ExtensionRequest): Promise<LearningSession | null> => {
      const requestedKey = contextKeyRef.current;
      setIsMutating(true);
      try {
        const response = await callbacksRef.current.sendMessage(message);
        if (contextKeyRef.current !== requestedKey) return null;
        if (!response.ok) {
          callbacksRef.current.setStatus(
            localizeUserMessage(response.error, callbacksRef.current.outputLocale),
          );
          return null;
        }
        if (response.type === 'LEARNING_SESSION') {
          setSession(response.payload);
          return response.payload;
        }
        return null;
      } finally {
        if (contextKeyRef.current === requestedKey) {
          setIsMutating(false);
        }
      }
    },
    [],
  );

  const updateGoal = useCallback(
    async (goal: LearningGoal): Promise<void> => {
      await runMutation({ type: 'UPDATE_LEARNING_GOAL', payload: goal });
    },
    [runMutation],
  );

  const updateCoach = useCallback(
    async (coach: LearningCoachSettings): Promise<void> => {
      await runMutation({ type: 'UPDATE_LEARNING_COACH', payload: coach });
    },
    [runMutation],
  );

  const generateGuide = useCallback(async (forceRefresh = false): Promise<void> => {
    const requestedKey = contextKeyRef.current;
    guideGenerationByContextRef.current.get(requestedKey)?.cancel('user');
    const requestId = nextGuideRequestIdRef.current + 1;
    nextGuideRequestIdRef.current = requestId;
    const startedAt = Date.now();
    const initialStatus = t('正在生成视频分析...', 'Generating video analysis...');
    setIsGeneratingGuide(true);
    setGuideGenerationStartedAt(startedAt);
    setGuideGenerationCharacterCount(0);
    setGuideGenerationStatus(initialStatus);
    callbacksRef.current.setStatus(initialStatus);
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
      const responsePromise: Promise<GuideGenerationRaceResult> =
        callbacksRef.current
          .sendMessage({
            type: 'GENERATE_LEARNING_GUIDE',
            payload: { forceRefresh, analysisMode, outputLocale },
          })
          .then((response) => ({ kind: 'response', response }) as const)
          .catch((error: unknown) => ({
            kind: 'transport_error',
            message: localizeUnknownError(error, callbacksRef.current.outputLocale),
          }));
      const timeoutPromise = new Promise<GuideGenerationRaceResult>((resolve) => {
        timeoutId = globalThis.setTimeout(() => {
          resolve({ kind: 'timeout' });
        }, SIDE_PANEL_GUIDE_REQUEST_TIMEOUT_MS);
      });
      const cancelPromise = new Promise<GuideGenerationRaceResult>((resolve) => {
        const cancel = (reason: GuideGenerationCancelReason): void => {
          resolve({ kind: 'cancelled', reason });
        };
        guideGenerationByContextRef.current.set(requestedKey, {
          requestId,
          startedAt,
          status: initialStatus,
          characterCount: 0,
          cancel,
        });
      });

      const result = await Promise.race([responsePromise, timeoutPromise, cancelPromise]);
      if (guideGenerationByContextRef.current.get(requestedKey)?.requestId !== requestId) return;

      if (result.kind === 'cancelled') {
        if (result.reason === 'user' && contextKeyRef.current === requestedKey) {
          callbacksRef.current.setStatus(
            t('已停止本次分析生成，可以重新开始', 'Analysis generation stopped. You can start again.'),
          );
        }
        return;
      }
      if (result.kind === 'timeout') {
        if (contextKeyRef.current === requestedKey) {
          callbacksRef.current.setStatus(
            t(
              '分析生成等待超时：当前请求长时间没有返回，可以重新开始。',
              'Analysis generation timed out. The request did not return for a long time; you can start again.',
            ),
          );
        }
        return;
      }
      if (result.kind === 'transport_error') {
        if (contextKeyRef.current === requestedKey) {
          callbacksRef.current.setStatus(result.message);
        }
        return;
      }
      if (!result.response.ok) {
        if (contextKeyRef.current === requestedKey) {
          callbacksRef.current.setStatus(
            localizeUserMessage(result.response.error, callbacksRef.current.outputLocale),
          );
        }
        return;
      }
      if (result.response.type === 'LEARNING_SESSION') {
        sessionByContextRef.current.set(requestedKey, result.response.payload);
        if (contextKeyRef.current === requestedKey) {
          setSession(result.response.payload);
          callbacksRef.current.setStatus(t('分析已生成', 'Analysis generated'));
        }
      }
    } finally {
      if (timeoutId) {
        globalThis.clearTimeout(timeoutId);
      }
      if (guideGenerationByContextRef.current.get(requestedKey)?.requestId === requestId) {
        guideGenerationByContextRef.current.delete(requestedKey);
        if (contextKeyRef.current === requestedKey) {
          clearGuideGenerationState();
        }
      }
    }
  }, [analysisMode, clearGuideGenerationState, outputLocale, t]);

  const addMoment = useCallback(
    async (input: {
      readonly kind: LearningMomentKind;
      readonly content: string;
      readonly source?: LearningMomentSource;
      readonly originTitle?: string;
      readonly timestamp?: number;
    }): Promise<LearningSession | null> => {
      const payload = {
        kind: input.kind,
        content: input.content,
        ...(input.source ? { source: input.source } : {}),
        ...(input.originTitle ? { originTitle: input.originTitle } : {}),
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      };
      const result = await runMutation({
        type: 'ADD_LEARNING_MOMENT',
        payload,
      });
      if (result) callbacksRef.current.setStatus(t('已记入学习轨迹', 'Saved to learning trace'));
      return result;
    },
    [runMutation, t],
  );

  const updateMoment = useCallback(
    async (input: {
      readonly momentId: string;
      readonly kind: LearningMomentKind;
      readonly content: string;
    }): Promise<void> => {
      const result = await runMutation({
        type: 'UPDATE_LEARNING_MOMENT',
        payload: input,
      });
      if (result) callbacksRef.current.setStatus(t('已更新这条记录', 'Record updated'));
    },
    [runMutation, t],
  );

  const removeMoment = useCallback(
    async (momentId: string): Promise<void> => {
      await runMutation({
        type: 'REMOVE_LEARNING_MOMENT',
        payload: { momentId },
      });
    },
    [runMutation],
  );

  const processMoment = useCallback(async (momentId: string): Promise<void> => {
    const requestedKey = contextKeyRef.current;
    setProcessingMomentId(momentId);
    callbacksRef.current.setStatus(t('正在补充说明这条记录...', 'Adding explanation to this record...'));
    try {
      const response = await callbacksRef.current.sendMessage({
        type: 'PROCESS_LEARNING_MOMENT',
        payload: { momentId, analysisMode },
      });
      if (contextKeyRef.current !== requestedKey) return;
      if (!response.ok) {
        callbacksRef.current.setStatus(
          localizeUserMessage(response.error, callbacksRef.current.outputLocale),
        );
        return;
      }
      if (response.type === 'LEARNING_SESSION') {
        setSession(response.payload);
        callbacksRef.current.setStatus(t('已补充说明这条记录', 'Explanation added to this record'));
      }
    } finally {
      if (contextKeyRef.current === requestedKey) {
        setProcessingMomentId(null);
      }
    }
  }, [analysisMode, t]);

  const toggleExchangeInReview = useCallback(
    async (exchange: LearningExchange, includedInReview: boolean): Promise<void> => {
      const result = await runMutation({
        type: 'SAVE_LEARNING_EXCHANGE',
        payload: {
          ...exchange,
          includedInReview,
        },
      });
      if (result) {
        callbacksRef.current.setStatus(
          includedInReview
            ? t('已加入学习笔记', 'Added to study notes')
            : t('已从学习笔记移除', 'Removed from study notes'),
        );
      }
    },
    [runMutation, t],
  );

  const generateReview = useCallback(async (forceRefresh = false): Promise<void> => {
    const requestedKey = contextKeyRef.current;
    setIsGenerating(true);
    callbacksRef.current.setStatus(t('正在整理你的学习笔记...', 'Organizing your study notes...'));
    try {
      const response = await callbacksRef.current.sendMessage({
        type: 'GENERATE_LEARNING_REVIEW',
        payload: { forceRefresh, analysisMode, outputLocale },
      });
      if (contextKeyRef.current !== requestedKey) return;
      if (!response.ok) {
        callbacksRef.current.setStatus(
          localizeUserMessage(response.error, callbacksRef.current.outputLocale),
        );
        return;
      }
      if (response.type === 'LEARNING_SESSION') {
        setSession(response.payload);
        callbacksRef.current.setStatus(t('学习笔记已生成', 'Study notes generated'));
      }
    } finally {
      if (contextKeyRef.current === requestedKey) {
        setIsGenerating(false);
      }
    }
  }, [analysisMode, outputLocale, t]);

  return {
    session,
    isMutating,
    isGenerating,
    isGeneratingGuide,
    guideGenerationStartedAt,
    guideGenerationStatus,
    guideGenerationCharacterCount,
    processingMomentId,
    loadSession,
    updateGoal,
    updateCoach,
    generateGuide,
    cancelGuideGeneration,
    addMoment,
    updateMoment,
    removeMoment,
    processMoment,
    toggleExchangeInReview,
    generateReview,
  };
}
