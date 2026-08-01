import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  VIDEO_FOLLOWUP_PORT_NAME,
  type FollowupAnswerBasis,
  type FollowupConversationMessage,
  type VideoFollowupPortMessage,
} from '@shared/messages';
import type { PlaybackState } from '@shared/playback-state';
import type { AnalysisMode } from '@shared/settings';
import { detectQuestionLocale, type UiLocale } from '@shared/locale-settings';
import {
  applyAbort,
  applyContextCleared,
  applyContextReady,
  applyInputChange,
  applyLocalError,
  applyPortDisconnected,
  applyPortMessage,
  applyPostMessageFailed,
  applySubmitQuestion,
  applyWatchdogTimeout,
  createFreshFollowupState,
  createInitialFollowupState,
  getWatchdogTimer,
  type FollowupPhase,
  type FollowupMessage,
  type FollowupState,
} from '../followup-state';
import {
  detectCurrentSegmentIntent,
  detectSelectedSegmentIntent,
} from '@core/followup/intent-detection';
import { pickConversationHistory } from '@core/followup/conversation-history';

/**
 * 追问 session hook。
 *
 * 集中负责 video-followup Port 生命周期、当前 requestId、watchdog、CHUNK /
 * DONE / ERROR / disconnect 收口、payload 构造（current / selected / global intent 路由）、
 * 本地 missing currentTime 拦截、cancel / retry。
 *
 * 不负责：
 * - 渲染 UI（由 FollowupTab 拿到 state 后组合 QuickQuestions / Messages / Composer）
 * - App.tsx 的 mount / visibility 决策（hook 一次性建立 Port，依赖父组件 mount/unmount）
 * - Provider 设置、页面上下文、内容底座、播放状态轮询
 *
 * FollowupTab 必须传入：
 * - hasContentContext / playbackState / contextKey / selectedTimestamp（重置 + intent 路由）
 *
 * 测试可注入：
 * - firstByteTimeoutMs / streamIdleTimeoutMs（默认 30s / 60s）
 * - requestIdFactory（默认 crypto.randomUUID / fallback）
 * - connectPort（默认 chrome.runtime.connect({ name: VIDEO_FOLLOWUP_PORT_NAME })）
 */

export interface SubmitQuestionOptions {
  /** 用户问题显式要求当前播放时间（如"解释当前片段"快捷问题）。 */
  readonly requiresCurrentTime?: boolean;
  /** 强制使用当前片段上下文，不依赖文本意图识别。 */
  readonly forceCurrentSegment?: boolean;
  /** 显式允许把 selectedTimestamp 作为提问焦点；普通输入会再走意图识别。 */
  readonly useSelectedTimestamp?: boolean;
}

export interface UseFollowupSessionOptions {
  readonly hasContentContext: boolean;
  readonly analysisMode?: AnalysisMode;
  readonly playbackState: PlaybackState | null;
  readonly contextKey: string;
  /** 显式点选的时间线节点；只有明确询问选中片段时才传给后端。 */
  readonly selectedTimestamp?: number | null;
  /** watchdog 首字节超时。默认 30s。 */
  readonly firstByteTimeoutMs?: number;
  /** watchdog 流式静默超时。默认 60s。 */
  readonly streamIdleTimeoutMs?: number;
  /** 测试可注入：requestId 生成器。默认走模块级 generateRequestId。 */
  readonly requestIdFactory?: () => string;
  /** 测试可注入：Port 连接。默认 chrome.runtime.connect({ name: VIDEO_FOLLOWUP_PORT_NAME })。 */
  readonly connectPort?: () => chrome.runtime.Port | null;
}

export interface UseFollowupSessionResult {
  readonly state: FollowupState;
  readonly phase: FollowupPhase;
  readonly isBusy: boolean;
  /** 当前选中的回答依据（默认 `video_only`）。按 contextKey 保存和恢复。 */
  readonly answerBasis: FollowupAnswerBasis;
  /**
   * 发送追问请求。
   *
   * requestId 由 hook 内部生成一次贯穿 UI state 和 Port payload；
   * postMessage 失败时把 loading/streaming 切回 error，避免界面卡住。
   * 回答依据按发送瞬间的 `answerBasis` 快照写入 Port payload，
   * 流式期间再切换不会影响已发送请求。
   */
  readonly submitQuestion: (question: string, options?: SubmitQuestionOptions) => void;
  /** 用户主动停止当前回答。切视频不会调用它。 */
  readonly cancelQuestion: () => void;
  /** 输入框文本更新。 */
  readonly changeInputDraft: (value: string) => void;
  /** 切换回答依据。流式期间调用仅影响后续提交瞬间的快照。 */
  readonly changeAnswerBasis: (next: FollowupAnswerBasis) => void;
}

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const FOLLOWUP_SESSION_STORAGE_PREFIX = 'bai.followup.session.v1:';
const MAX_PERSISTED_MESSAGES = 20;

interface RestoredFollowupSession {
  readonly state: FollowupState;
  readonly answerBasis: FollowupAnswerBasis;
}

interface PersistedFollowupSession {
  readonly version: 1;
  readonly state: FollowupState;
  readonly answerBasis: FollowupAnswerBasis;
  readonly updatedAt: number;
}

interface FollowupSessionSnapshot {
  readonly state: FollowupState;
  readonly answerBasis: FollowupAnswerBasis;
  readonly activeRequestId: string | null;
  readonly lastChunkAt: number | null;
}

const defaultConnectPort = (): chrome.runtime.Port | null => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
    return null;
  }
  return chrome.runtime.connect({ name: VIDEO_FOLLOWUP_PORT_NAME });
};

/**
 * requestId 默认生成器。crypto.randomUUID 优先；测试 / 老浏览器 fallback 到时间戳 + 随机串。
 */
function defaultGenerateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把秒数格式化成 mm:ss / h:mm:ss（缺省走"未播放"）。
 */
function formatClock(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return '未播放';
  }
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCurrentTimeAnchor(seconds: number, locale: UiLocale): string {
  const time = formatClock(seconds);
  return locale === 'en-US'
    ? ` (current playback time: ${time})`
    : `（当前播放时间：${time}）`;
}

function getSessionStorage(): Storage | null {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function shouldPersistContextKey(contextKey: string): boolean {
  return !contextKey.startsWith('none:') && !contextKey.includes(':none:');
}

function getFollowupSessionStorageKey(contextKey: string): string {
  return `${FOLLOWUP_SESSION_STORAGE_PREFIX}${contextKey}`;
}

function normalizePhaseForRestore(hasContentContext: boolean): FollowupPhase {
  return hasContentContext ? { kind: 'idle' } : { kind: 'no_context' };
}

function normalizeMessageForPersistence(message: FollowupMessage): FollowupMessage {
  if (message.role !== 'assistant' || message.streaming !== true) {
    return message;
  }
  return {
    ...message,
    streaming: false,
    error: message.error ?? {
      code: 'SESSION_INTERRUPTED',
      message: '连接中断导致这次回答中断，请重新提问。',
    },
  };
}

function normalizeStateForPersistence(
  state: FollowupState,
  hasContentContext: boolean,
): FollowupState {
  return {
    ...state,
    phase: normalizePhaseForRestore(hasContentContext),
    messages: state.messages
      .slice(-MAX_PERSISTED_MESSAGES)
      .map((message) => normalizeMessageForPersistence(message)),
  };
}

function isValidAnswerBasis(value: unknown): value is FollowupAnswerBasis {
  return value === 'video_only' || value === 'video_plus_general' || value === 'video_plus_web';
}

function isPersistedFollowupSession(value: unknown): value is PersistedFollowupSession {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as {
    version?: unknown;
    state?: { messages?: unknown; inputDraft?: unknown };
    answerBasis?: unknown;
  };
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.state?.messages) &&
    typeof candidate.state?.inputDraft === 'string' &&
    isValidAnswerBasis(candidate.answerBasis)
  );
}

function restorePersistedFollowupSession(
  contextKey: string,
  hasContentContext: boolean,
): RestoredFollowupSession | null {
  if (!shouldPersistContextKey(contextKey)) {
    return null;
  }
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }
  const key = getFollowupSessionStorageKey(contextKey);
  const raw = storage.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPersistedFollowupSession(parsed)) {
      storage.removeItem(key);
      return null;
    }
    return {
      state: {
        ...parsed.state,
        phase: normalizePhaseForRestore(hasContentContext),
        messages: parsed.state.messages.map((message) =>
          normalizeMessageForPersistence(message),
        ),
      },
      answerBasis: parsed.answerBasis,
    };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function persistFollowupSession(input: {
  readonly contextKey: string;
  readonly state: FollowupState;
  readonly answerBasis: FollowupAnswerBasis;
  readonly hasContentContext: boolean;
}): void {
  if (!shouldPersistContextKey(input.contextKey)) {
    return;
  }
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }
  const key = getFollowupSessionStorageKey(input.contextKey);
  const hasContent =
    input.state.messages.length > 0 || input.state.inputDraft.trim().length > 0;
  if (!hasContent) {
    storage.removeItem(key);
    return;
  }
  const payload: PersistedFollowupSession = {
    version: 1,
    state: normalizeStateForPersistence(input.state, input.hasContentContext),
    answerBasis: input.answerBasis,
    updatedAt: Date.now(),
  };
  try {
    storage.setItem(key, JSON.stringify(payload));
  } catch {
    // sessionStorage 写满或不可用时，不影响提问主流程。
  }
}

/**
 * FollowupTab 使用的 session hook。
 *
 * mount 时一次性建立 Port；卸载时断开。
 * 上下文变化（视频、模式、缓存命中）→ 切换对应 session 快照；
 * 旧 context 的 in-flight 请求继续写回旧快照，用户主动停止才取消。
 */
export function useFollowupSession(options: UseFollowupSessionOptions): UseFollowupSessionResult {
  const {
    hasContentContext,
    analysisMode = 'subtitle',
    playbackState,
    contextKey,
    selectedTimestamp,
    firstByteTimeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    requestIdFactory = defaultGenerateRequestId,
    connectPort = defaultConnectPort,
  } = options;

  const initialRestoredRef = useRef<RestoredFollowupSession | null | undefined>(undefined);
  if (initialRestoredRef.current === undefined) {
    initialRestoredRef.current = restorePersistedFollowupSession(contextKey, hasContentContext);
  }

  const [state, setState] = useState<FollowupState>(
    () => initialRestoredRef.current?.state ?? createInitialFollowupState(),
  );
  /**
   * 当前选中的回答依据。`video_only` 是新 context 的默认值；切回已有 context 时
   * 恢复该 context 的选择。流式期间切换只影响后续提交瞬间快照，不影响已发送请求。
   *
   * 不放进 FollowupState：它不属于 phase / messages / watchdog 状态机，而是
   * UI 选项状态——和 inputDraft 同性质，但放在 hook 内（避免组件层重复声明）。
   */
  const [answerBasis, setAnswerBasis] = useState<FollowupAnswerBasis>(
    () => initialRestoredRef.current?.answerBasis ?? 'video_only',
  );

  const portRef = useRef<chrome.runtime.Port | null>(null);
  /** 当前活动 requestId：submitQuestion 生成一次后写入，发包前再校对一次。 */
  const activeRequestIdRef = useRef<string | null>(null);
  const activeRequestIdByContextRef = useRef<Map<string, string>>(new Map());
  const requestContextByIdRef = useRef<Map<string, string>>(new Map());
  const sessionByContextRef = useRef<Map<string, FollowupSessionSnapshot>>(new Map());
  const currentContextKeyRef = useRef(contextKey);
  /**
   * 上一段 chunk 到达时间（Date.now()）。Watchdog 用来计算 stream_idle 阶段剩余超时。
   * 每次收到 VIDEO_ANSWER_CHUNK / REASONING_CHUNK 都重置。
   */
  const lastChunkAtRef = useRef<number | null>(null);
  const lastChunkAtByContextRef = useRef<Map<string, number | null>>(new Map());
  /** Watchdog timer 句柄。跟随 phase 切换重新起 / 清。 */
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Phase watcher：每次 setState 后调用，决定起 / 清 watchdog timer。 */
  const watchdogStartRef = useRef<(() => void) | null>(null);
  /** 当前 state 在 watchdog 计算时的快照。避免闭包抓到旧值。 */
  const stateRef = useRef<FollowupState>(state);
  /** 回答依据 ref：submitQuestion 快照时取最新值，避免闭包抓到旧值。 */
  const answerBasisRef = useRef<FollowupAnswerBasis>(answerBasis);
  /** 注入项 ref：避免 effect 重建时捕到过期闭包。 */
  const optionsRef = useRef({
    firstByteTimeoutMs,
    streamIdleTimeoutMs,
    requestIdFactory,
    selectedTimestamp,
    hasContentContext,
  });
  optionsRef.current = {
    firstByteTimeoutMs,
    streamIdleTimeoutMs,
    requestIdFactory,
    selectedTimestamp,
    hasContentContext,
  };

  const saveCurrentSessionSnapshot = useCallback(
    (nextState = stateRef.current, nextAnswerBasis = answerBasisRef.current): void => {
      const key = currentContextKeyRef.current;
      sessionByContextRef.current.set(key, {
        state: nextState,
        answerBasis: nextAnswerBasis,
        activeRequestId: activeRequestIdByContextRef.current.get(key) ?? null,
        lastChunkAt: lastChunkAtByContextRef.current.get(key) ?? null,
      });
    },
    [],
  );

  const restoreSessionSnapshot = useCallback(
    (nextContextKey: string, nextHasContentContext: boolean): FollowupSessionSnapshot => {
      const existing = sessionByContextRef.current.get(nextContextKey);
      if (existing) return existing;
      const restored = restorePersistedFollowupSession(nextContextKey, nextHasContentContext);
      const snapshot: FollowupSessionSnapshot = {
        state: restored?.state ?? createFreshFollowupState(nextHasContentContext),
        answerBasis: restored?.answerBasis ?? 'video_only',
        activeRequestId: null,
        lastChunkAt: null,
      };
      sessionByContextRef.current.set(nextContextKey, snapshot);
      return snapshot;
    },
    [],
  );

  const renderedSnapshot =
    currentContextKeyRef.current === contextKey
      ? null
      : restoreSessionSnapshot(contextKey, hasContentContext);
  const renderedState = renderedSnapshot?.state ?? state;
  const renderedAnswerBasis = renderedSnapshot?.answerBasis ?? answerBasis;

  // 上下文变化（视频、模式、缓存命中）：
  // - contextKey 变化 → 保存旧 context 的 session 快照，恢复新 context 的快照；
  //   不取消旧 in-flight，旧 CHUNK / DONE 会继续写入旧 context 快照。
  // - 仅 hasContentContext 翻转（contextKey 不变）→ 用现有语义（no_context ↔ idle）。
  const prevContextKeyRef = useRef(contextKey);
  useLayoutEffect(() => {
    if (currentContextKeyRef.current === contextKey) {
      return;
    }

    saveCurrentSessionSnapshot();
    if (watchdogTimerRef.current !== null) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    currentContextKeyRef.current = contextKey;
    prevContextKeyRef.current = contextKey;
    const restored = restoreSessionSnapshot(contextKey, hasContentContext);
    stateRef.current = restored.state;
    answerBasisRef.current = restored.answerBasis;
    activeRequestIdRef.current = restored.activeRequestId;
    lastChunkAtRef.current = restored.lastChunkAt;
    setState(() => restored.state);
    setAnswerBasis(restored.answerBasis);
  }, [
    contextKey,
    hasContentContext,
    restoreSessionSnapshot,
    saveCurrentSessionSnapshot,
  ]);

  useEffect(() => {
    const contextKeyChanged = prevContextKeyRef.current !== contextKey;
    prevContextKeyRef.current = contextKey;

    if (contextKeyChanged) {
      return;
    }

    // hasContentContext 翻转（contextKey 不变）：保留现有语义，仅切 no_context ↔ idle
    setState((current) => {
      const next = hasContentContext ? applyContextReady(current) : applyContextCleared(current);
      stateRef.current = next;
      saveCurrentSessionSnapshot(next);
      return next;
    });
  }, [
    contextKey,
    hasContentContext,
    restoreSessionSnapshot,
    saveCurrentSessionSnapshot,
  ]);

  // 把 state 同步到 ref，让 watchdog 拿到最新 phase
  useEffect(() => {
    if (state !== stateRef.current) {
      return;
    }
    stateRef.current = state;
    saveCurrentSessionSnapshot(state);
  }, [saveCurrentSessionSnapshot, state]);

  // 把 answerBasis 同步到 ref，submitQuestion 快照时拿最新值
  useEffect(() => {
    if (answerBasis !== answerBasisRef.current) {
      return;
    }
    answerBasisRef.current = answerBasis;
    saveCurrentSessionSnapshot(stateRef.current, answerBasis);
  }, [answerBasis, saveCurrentSessionSnapshot]);

  useEffect(() => {
    if (
      contextKey !== currentContextKeyRef.current ||
      state !== stateRef.current ||
      answerBasis !== answerBasisRef.current
    ) {
      return;
    }
    persistFollowupSession({
      contextKey,
      state: stateRef.current,
      answerBasis: answerBasisRef.current,
      hasContentContext,
    });
  }, [answerBasis, contextKey, hasContentContext, state]);

  // 每次 setState 后跑一次 watchdog 重新评估。
  // 关键点：watchdog 起 / 清应该和 state.phase 同步，不能依赖 useEffect deps（避免 setState
  // 触发的 effect 顺序与 timer 时机不一致）。
  watchdogStartRef.current = (): void => {
    const decided = getWatchdogTimer({
      state: stateRef.current,
      now: Date.now(),
      firstByteTimeoutMs: optionsRef.current.firstByteTimeoutMs,
      streamIdleTimeoutMs: optionsRef.current.streamIdleTimeoutMs,
      lastChunkAt: lastChunkAtRef.current,
    });
    if (watchdogTimerRef.current !== null) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (!decided) {
      return;
    }
    watchdogTimerRef.current = setTimeout(
      () => {
        watchdogTimerRef.current = null;
        const key = currentContextKeyRef.current;
        const timedOutRequestId = activeRequestIdByContextRef.current.get(key) ?? null;
        setState((current) => {
          const next = applyWatchdogTimeout(current);
          stateRef.current = next;
          saveCurrentSessionSnapshot(next);
          return next;
        });
        if (timedOutRequestId) {
          requestContextByIdRef.current.delete(timedOutRequestId);
        }
        activeRequestIdByContextRef.current.delete(key);
        lastChunkAtByContextRef.current.delete(key);
        activeRequestIdRef.current = null;
        lastChunkAtRef.current = null;
      },
      Math.max(0, decided.fireAt - Date.now()),
    );
  };

  // 建立 Port：side panel 打开时一次性 connect，关闭时 disconnect。
  // 注意：这里只在 followup tab 渲染时（mount）才 connect，离开 tab 不 disconnect，
  // 保证切 tab 时不丢失流。卸载组件时 disconnect。
  useEffect(() => {
    const port = connectPort();
    if (!port) {
      return;
    }
    portRef.current = port;
    const handleMessage = (raw: unknown): void => {
      const message = raw as VideoFollowupPortMessage;
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return;
      }
      const messageRequestId = 'requestId' in message ? message.requestId : undefined;
      if (messageRequestId === undefined) {
        return;
      }
      const targetContextKey = requestContextByIdRef.current.get(messageRequestId);
      if (!targetContextKey) return;
      const isCurrentContext = targetContextKey === currentContextKeyRef.current;
      const baseSnapshot =
        isCurrentContext
          ? {
              state: stateRef.current,
              answerBasis: answerBasisRef.current,
              activeRequestId: activeRequestIdRef.current,
              lastChunkAt: lastChunkAtRef.current,
            }
          : restoreSessionSnapshot(targetContextKey, true);
      // 收到任何 chunk 类消息都更新 lastChunkAt，让 watchdog 进入 stream_idle 阶段
      if (
        message.type === 'VIDEO_ANSWER_CHUNK' ||
        message.type === 'VIDEO_ANSWER_REASONING_CHUNK'
      ) {
        if (baseSnapshot.activeRequestId === messageRequestId) {
          const now = Date.now();
          lastChunkAtByContextRef.current.set(targetContextKey, now);
          if (isCurrentContext) {
            lastChunkAtRef.current = now;
          }
        }
      }
      const nextState = applyPortMessage(baseSnapshot.state, message);
      if (message.type === 'VIDEO_ANSWER_DONE' || message.type === 'VIDEO_ANSWER_ERROR') {
        if (activeRequestIdByContextRef.current.get(targetContextKey) === messageRequestId) {
          activeRequestIdByContextRef.current.delete(targetContextKey);
          lastChunkAtByContextRef.current.delete(targetContextKey);
        }
        requestContextByIdRef.current.delete(messageRequestId);
        if (isCurrentContext) {
          activeRequestIdRef.current =
            activeRequestIdByContextRef.current.get(targetContextKey) ?? null;
          lastChunkAtRef.current = lastChunkAtByContextRef.current.get(targetContextKey) ?? null;
        }
      }
      sessionByContextRef.current.set(targetContextKey, {
        state: nextState,
        answerBasis: baseSnapshot.answerBasis,
        activeRequestId: activeRequestIdByContextRef.current.get(targetContextKey) ?? null,
        lastChunkAt: lastChunkAtByContextRef.current.get(targetContextKey) ?? null,
      });
      if (isCurrentContext) {
        stateRef.current = nextState;
        setState(nextState);
      }
    };
    const handleDisconnect = (): void => {
      portRef.current = null;
      if (watchdogTimerRef.current !== null) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }

      const currentContextKey = currentContextKeyRef.current;
      const contextsToClose = new Set<string>([
        currentContextKey,
        ...activeRequestIdByContextRef.current.keys(),
      ]);
      for (const [snapshotContextKey, snapshot] of sessionByContextRef.current) {
        if (snapshot.state.phase.kind === 'loading' || snapshot.state.phase.kind === 'streaming') {
          contextsToClose.add(snapshotContextKey);
        }
      }

      let nextCurrentState = stateRef.current;
      for (const snapshotContextKey of contextsToClose) {
        const isCurrentContext = snapshotContextKey === currentContextKey;
        const snapshot: FollowupSessionSnapshot | null = isCurrentContext
          ? {
              state: stateRef.current,
              answerBasis: answerBasisRef.current,
              activeRequestId: activeRequestIdRef.current,
              lastChunkAt: lastChunkAtRef.current,
            }
          : sessionByContextRef.current.get(snapshotContextKey) ?? null;
        if (!snapshot) {
          continue;
        }
        const nextState = applyPortDisconnected(snapshot.state);
        sessionByContextRef.current.set(snapshotContextKey, {
          state: nextState,
          answerBasis: snapshot.answerBasis,
          activeRequestId: null,
          lastChunkAt: null,
        });
        if (isCurrentContext) {
          nextCurrentState = nextState;
        }
      }

      stateRef.current = nextCurrentState;
      setState(nextCurrentState);
      activeRequestIdByContextRef.current.clear();
      requestContextByIdRef.current.clear();
      lastChunkAtByContextRef.current.clear();
      activeRequestIdRef.current = null;
      lastChunkAtRef.current = null;
    };
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    return () => {
      port.onMessage.removeListener(handleMessage);
      port.onDisconnect.removeListener(handleDisconnect);
      try {
        port.disconnect();
      } catch {
        // 忽略：port 已关闭
      }
      portRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // state 变化时重新评估 watchdog。注意把 lastChunkAt / phase 都纳入 deps。
  useEffect(() => {
    watchdogStartRef.current?.();
  }, [state, firstByteTimeoutMs, streamIdleTimeoutMs]);

  /**
   * 发送追问请求（Port payload 构造）。
   *
   * requestId 必须由 caller 生成一次并贯穿 UI state 和 port payload；
   * postMessage 失败时把 loading/streaming 切回 error，避免 UI 永远卡住。
   * 回答依据按发送瞬间从 answerBasisRef 快照，避免流式期间切换影响已发送请求。
   * 对话历史按发送瞬间从 `pickConversationHistory(state.messages)` 快照；
   * 流式期间再生成的消息不影响已发送请求。
   */
  const sendAsk = useCallback(
    (input: {
      readonly requestId: string;
      readonly question: string;
      readonly answerLocale?: UiLocale;
      readonly currentTime?: number;
      readonly selectedTimestamp?: number;
      readonly forceCurrentSegment?: boolean;
      readonly conversationHistory?: readonly FollowupConversationMessage[];
    }): boolean => {
      const port = portRef.current;
      if (!port) {
        setState((current) => {
          const next = applyPostMessageFailed(current, new Error('port 未连接'));
          stateRef.current = next;
          saveCurrentSessionSnapshot(next);
          return next;
        });
        return false;
      }
      // 在写入 ref 之前先把 requestId 锁住，避免跟"phase.requestId"对不上
      const requestContextKey = currentContextKeyRef.current;
      activeRequestIdRef.current = input.requestId;
      activeRequestIdByContextRef.current.set(requestContextKey, input.requestId);
      requestContextByIdRef.current.set(input.requestId, requestContextKey);
      lastChunkAtRef.current = null;
      lastChunkAtByContextRef.current.set(requestContextKey, null);
      const payload: VideoFollowupPortMessage = {
        type: 'ASK_VIDEO_QUESTION',
        requestId: input.requestId,
        question: input.question,
        includeCurrentSegment: stateRef.current.includeCurrentSegment,
        analysisMode,
        ...(typeof input.currentTime === 'number' ? { currentTime: input.currentTime } : {}),
        ...(typeof input.selectedTimestamp === 'number'
          ? { selectedTimestamp: input.selectedTimestamp }
          : {}),
        ...(input.forceCurrentSegment === true ? { forceCurrentSegment: true } : {}),
        answerBasis: answerBasisRef.current,
        answerLocale: input.answerLocale ?? detectQuestionLocale(input.question),
        ...(input.conversationHistory && input.conversationHistory.length > 0
          ? { conversationHistory: input.conversationHistory }
          : {}),
      };
      try {
        port.postMessage(payload);
        return true;
      } catch (error) {
        console.warn('[bAI] 追问 port.postMessage 失败：', error);
        // 失败时把当前正在 loading / streaming 的 state 切到 error，避免 UI 永远卡住
        setState((current) => {
          const next = applyPostMessageFailed(current, error);
          stateRef.current = next;
          saveCurrentSessionSnapshot(next);
          return next;
        });
        activeRequestIdByContextRef.current.delete(requestContextKey);
        requestContextByIdRef.current.delete(input.requestId);
        lastChunkAtByContextRef.current.delete(requestContextKey);
        activeRequestIdRef.current = null;
        lastChunkAtRef.current = null;
        return false;
      }
    },
    [analysisMode, saveCurrentSessionSnapshot],
  );

  const cancelInFlight = useCallback(
    (requestId: string | null = activeRequestIdRef.current): void => {
      const port = portRef.current;
      if (!port || !requestId) {
        return;
      }
      try {
        port.postMessage({ type: 'CANCEL_VIDEO_QUESTION', requestId });
      } catch {
        // 忽略
      }
    },
    [],
  );

  const cancelQuestion = useCallback((): void => {
    const key = currentContextKeyRef.current;
    const requestId = activeRequestIdByContextRef.current.get(key) ?? null;
    cancelInFlight(requestId);
    if (requestId) {
      requestContextByIdRef.current.delete(requestId);
    }
    activeRequestIdByContextRef.current.delete(key);
    lastChunkAtByContextRef.current.delete(key);
    activeRequestIdRef.current = null;
    lastChunkAtRef.current = null;
    setState((current) => {
      const next = applyAbort(current);
      stateRef.current = next;
      saveCurrentSessionSnapshot(next);
      return next;
    });
  }, [cancelInFlight, saveCurrentSessionSnapshot]);

  const submitQuestion = useCallback(
    (question: string, options?: SubmitQuestionOptions): void => {
      if (!question.trim()) {
        return;
      }
      if (!optionsRef.current.hasContentContext) {
        return;
      }
      const currentTime = playbackState?.currentTime;
      const hasValidCurrentTime = typeof currentTime === 'number' && Number.isFinite(currentTime);
      // 命中"当前片段"意图但拿不到播放时间时，本地拦截，避免模型猜测上下文。
      const requiresCurrentAnchor =
        options?.requiresCurrentTime === true || detectCurrentSegmentIntent(question);
      if (requiresCurrentAnchor && !hasValidCurrentTime) {
        setState((current) => {
          const next = applyLocalError(current, {
            code: 'MISSING_CURRENT_TIME',
            message: '还没有拿到当前播放位置，请先播放视频或在菜单里刷新页面状态后重试。',
          });
          stateRef.current = next;
          saveCurrentSessionSnapshot(next);
          return next;
        });
        return;
      }
      const answerLocale = detectQuestionLocale(question);
      // 把当前播放时间补进问题文本，作为 prompt 侧锚点兜底。
      const finalQuestion =
        requiresCurrentAnchor && hasValidCurrentTime
          ? `${question}${formatCurrentTimeAnchor(currentTime as number, answerLocale)}`
          : question;
      // selectedTimestamp 只代表用户显式点选的片段，不能默认劫持全局问题。
      const validSelectedTimestamp = optionsRef.current.selectedTimestamp;
      const hasValidSelectedTimestamp =
        typeof validSelectedTimestamp === 'number' && Number.isFinite(validSelectedTimestamp);
      const explicitUseSelectedTimestamp = options?.useSelectedTimestamp;
      const inferredUseSelectedTimestamp =
        explicitUseSelectedTimestamp ?? detectSelectedSegmentIntent(question);
      const wantsSelectedTimestamp = inferredUseSelectedTimestamp === true;
      const shouldSendSelectedTimestamp =
        options?.forceCurrentSegment !== true &&
        hasValidSelectedTimestamp &&
        wantsSelectedTimestamp;
      // 发送瞬间快照：用户可见的当前 messages 数组用于 pickConversationHistory。
      // 这里**不**用 retried 后的 state.messages（retried 走的是 applySubmitQuestion
      // 把新 user/assistant 占位插入数组后的 state，**不应**作为已完成的对话历史）。
      // 关键不变量：streaming / error / 空 assistant **不**进入历史；按 MAX_CONVERSATION_*
      // 限额选取。
      const conversationHistory = pickConversationHistory({
        messages: stateRef.current.messages,
      });
      // 保存旧活动 requestId：retry 路径的 CANCEL 必须取消 background 那边仍在 in-flight
      // 的旧 ASK（新生成的 requestId 在 background 还没注册，cancel 它无效）。
      const requestContextKey = currentContextKeyRef.current;
      const oldActiveRequestId =
        activeRequestIdByContextRef.current.get(requestContextKey) ?? activeRequestIdRef.current;
      const requestId = optionsRef.current.requestIdFactory();
      const requestAnswerBasis = answerBasisRef.current;
      activeRequestIdRef.current = requestId;
      lastChunkAtRef.current = null;
      const submitted = applySubmitQuestion({
        question: finalQuestion,
        answerBasis: requestAnswerBasis,
        generateRequestId: () => requestId,
        previousState: stateRef.current,
      });
      if (!submitted) {
        // 当前不是 idle（可能上一次还没完成）；用旧 requestId 取消旧 in-flight
        cancelInFlight(oldActiveRequestId);
        if (oldActiveRequestId) {
          requestContextByIdRef.current.delete(oldActiveRequestId);
        }
        activeRequestIdByContextRef.current.delete(requestContextKey);
        lastChunkAtByContextRef.current.delete(requestContextKey);
        const after = applyAbort(stateRef.current);
        const retried = applySubmitQuestion({
          question: finalQuestion,
          answerBasis: requestAnswerBasis,
          generateRequestId: () => requestId,
          previousState: after,
        });
        if (!retried) {
          return;
        }
        stateRef.current = retried.state;
        saveCurrentSessionSnapshot(retried.state);
        setState(retried.state);
        // 写完 state 后同步给 ref（确保 sendAsk 之前 ref 也是新的 requestId）
        activeRequestIdRef.current = requestId;
        sendAsk({
          requestId,
          question: retried.userMessage.content,
          answerLocale,
          ...(hasValidCurrentTime ? { currentTime: currentTime as number } : {}),
          ...(shouldSendSelectedTimestamp
            ? { selectedTimestamp: validSelectedTimestamp as number }
            : {}),
          ...(options?.forceCurrentSegment === true ? { forceCurrentSegment: true } : {}),
          ...(conversationHistory.length > 0 ? { conversationHistory } : {}),
        });
        return;
      }
      stateRef.current = submitted.state;
      saveCurrentSessionSnapshot(submitted.state);
      setState(submitted.state);
      sendAsk({
        requestId,
        question: submitted.userMessage.content,
        answerLocale,
        ...(hasValidCurrentTime ? { currentTime: currentTime as number } : {}),
        ...(shouldSendSelectedTimestamp
          ? { selectedTimestamp: validSelectedTimestamp as number }
          : {}),
        ...(options?.forceCurrentSegment === true ? { forceCurrentSegment: true } : {}),
        ...(conversationHistory.length > 0 ? { conversationHistory } : {}),
      });
    },
    [cancelInFlight, playbackState, saveCurrentSessionSnapshot, sendAsk],
  );

  const changeInputDraft = useCallback(
    (value: string): void => {
      setState((current) => {
        const next = applyInputChange(current, value);
        stateRef.current = next;
        saveCurrentSessionSnapshot(next);
        return next;
      });
    },
    [saveCurrentSessionSnapshot],
  );

  /**
   * 切换回答依据。只更新本地 state + ref；不触发新的 ASK_VIDEO_QUESTION。
   * submitQuestion 在发送瞬间会从 answerBasisRef 快照当前值；流式期间
   * 切换不影响已发送请求。
   */
  const changeAnswerBasis = useCallback((next: FollowupAnswerBasis): void => {
    setAnswerBasis(next);
    answerBasisRef.current = next;
    saveCurrentSessionSnapshot(stateRef.current, next);
  }, [saveCurrentSessionSnapshot]);

  const phase = renderedState.phase;
  const isBusy = phase.kind === 'loading' || phase.kind === 'streaming';

  return useMemo(
    () => ({
      state: renderedState,
      phase,
      isBusy,
      answerBasis: renderedAnswerBasis,
      submitQuestion,
      cancelQuestion,
      changeInputDraft,
      changeAnswerBasis,
    }),
    [
      renderedState,
      phase,
      isBusy,
      renderedAnswerBasis,
      submitQuestion,
      cancelQuestion,
      changeInputDraft,
      changeAnswerBasis,
    ],
  );
}
