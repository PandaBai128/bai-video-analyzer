import type { FollowupAnswerBasis, VideoFollowupPortMessage } from '@shared/messages';

/**
 * 追问 tab 的 5 个状态（与 AGENT_HANDOFF 任务 5 对齐）：
 * 1. `no_context`：没有分析结果 / 缓存
 * 2. `idle`：有上下文，等待用户输入
 * 3. `loading`：已发出问题，等服务端首字节
 * 4. `streaming`：已开始收到 chunk，追加到当前 assistant message
 * 5. `error`：当前请求失败（错误局部化在追问 tab）
 */
export type FollowupPhase =
  | { readonly kind: 'no_context' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly requestId: string; readonly userMessageId: string; readonly assistantMessageId: string }
  | { readonly kind: 'streaming'; readonly requestId: string; readonly userMessageId: string; readonly assistantMessageId: string; readonly text: string; readonly reasoning: string }
  | { readonly kind: 'error'; readonly requestId: string | null; readonly userMessageId: string | null; readonly assistantMessageId: string | null; readonly code: string; readonly message: string };

export interface FollowupMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: number;
  /** 流式未完成（loading/streaming 阶段） */
  readonly streaming?: boolean;
  /** 错误占位（仅在 assistant message 上） */
  readonly error?: { readonly code: string; readonly message: string };
  /** 该条助手回答提交瞬间使用的回答依据。 */
  readonly answerBasis?: FollowupAnswerBasis;
}

export interface FollowupState {
  readonly phase: FollowupPhase;
  readonly messages: readonly FollowupMessage[];
  /** 消息协议兼容字段；实际上下文选择由 forceCurrentSegment 和意图识别决定。 */
  readonly includeCurrentSegment: boolean;
  /** 当前的输入框文本。 */
  readonly inputDraft: string;
}

/**
 * 状态机的初始值。
 */
export function createInitialFollowupState(): FollowupState {
  return {
    phase: { kind: 'no_context' },
    messages: [],
    includeCurrentSegment: true,
    inputDraft: '',
  };
}

/**
 * 切换 contextKey（视频 / 内容身份）时使用的"全新 session"初始状态。
 *
 * 与 createInitialFollowupState 的区别：本函数**按当前 hasContentContext 决定 phase**，
 * 用来覆盖旧 in-flight session 的 messages / inputDraft / active requestId。
 *
 * - hasContentContext=true → phase=idle（可立即接受用户输入）
 * - hasContentContext=false → phase=no_context（无内容底座时显示 CTA）
 *
 * 调用方需要在 effect 里**同时**清掉 ref / watchdog / port CANCEL，
 * 否则旧 chunk 仍可能串入新 session（这条不变量由 hook 维护）。
 */
export function createFreshFollowupState(hasContentContext: boolean): FollowupState {
  return {
    phase: { kind: hasContentContext ? 'idle' : 'no_context' },
    messages: [],
    includeCurrentSegment: true,
    inputDraft: '',
  };
}

let idCounter = 0;
/** 测试可注入 */
export function setFollowupIdGenerator(fn: () => string): void {
  idCounter = -1;
  followupIdGenerator = fn;
}

let followupIdGenerator: () => string = () => {
  idCounter += 1;
  return `msg-${idCounter}`;
};

function nextId(): string {
  return followupIdGenerator();
}

// ---------------------------------------------------------------------------
// 用户操作 → 新 state
// ---------------------------------------------------------------------------

/**
 * 当有分析结果时（cached analysis 已就绪）调用：phase 从 no_context 切到 idle。
 * 不会清空现有 messages（用户可能切走切回，message 历史应当保留在内存里；
 * 真要持久化是后续话题）。
 */
export function applyContextReady(state: FollowupState): FollowupState {
  if (state.phase.kind === 'no_context') {
    return { ...state, phase: { kind: 'idle' } };
  }
  return state;
}

/**
 * 当分析结果清空 / 切到不支持的视频时调用：回到 no_context。
 * 进行中的请求会被 Port 关闭驱动 abort（side panel 端会收到 abort 的 effect）。
 */
export function applyContextCleared(state: FollowupState): FollowupState {
  return { ...state, phase: { kind: 'no_context' } };
}

export function applyInputChange(state: FollowupState, draft: string): FollowupState {
  return { ...state, inputDraft: draft };
}

/**
 * 用户提交问题。返回 `{ state, requestId, userMessage, assistantMessage }`：
 * - state：进入 loading 阶段
 * - requestId：交给 controller 的请求 id
 * - userMessage / assistantMessage：构造好的两条 message（assistant 是空文本，等待 chunk）
 *
 * 如果当前不是 idle 状态，直接返回 null —— 调用方应先 abort 旧请求。
 */
export interface SubmitQuestionResult {
  readonly state: FollowupState;
  readonly requestId: string;
  readonly userMessage: FollowupMessage;
  readonly assistantMessage: FollowupMessage;
}

export function applySubmitQuestion(input: {
  readonly question: string;
  readonly answerBasis?: FollowupAnswerBasis;
  readonly generateRequestId: () => string;
  readonly now?: () => number;
  readonly previousState: FollowupState;
}): SubmitQuestionResult | null {
  const question = input.question.trim();
  if (!question) {
    return null;
  }
  if (input.previousState.phase.kind !== 'idle') {
    return null;
  }
  const now = input.now ?? Date.now;
  const requestId = input.generateRequestId();
  const userMessage: FollowupMessage = {
    id: nextId(),
    role: 'user',
    content: question,
    createdAt: now(),
  };
  const assistantMessage: FollowupMessage = {
    id: nextId(),
    role: 'assistant',
    content: '',
    createdAt: now(),
    streaming: true,
    ...(input.answerBasis ? { answerBasis: input.answerBasis } : {}),
  };
  const state: FollowupState = {
    phase: {
      kind: 'loading',
      requestId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    },
    messages: [...input.previousState.messages, userMessage, assistantMessage],
    includeCurrentSegment: input.previousState.includeCurrentSegment,
    inputDraft: '',
  };
  return { state, requestId, userMessage, assistantMessage };
}

// ---------------------------------------------------------------------------
// 服务端推送 → 新 state
// ---------------------------------------------------------------------------

/**
 * 处理从 Port 收到的 message。核心规则：
 * - requestId 不匹配当前活动 requestId → 整条消息丢弃（防串流污染）
 * - VIDEO_ANSWER_CHUNK → 追加到当前 assistant message 内容
 * - VIDEO_ANSWER_REASONING_CHUNK → 追加到 reasoning
 * - VIDEO_ANSWER_DONE → 标记 streaming=false
 * - VIDEO_ANSWER_ERROR → 标记 streaming=false，写入 error
 */
export function applyPortMessage(state: FollowupState, message: VideoFollowupPortMessage): FollowupState {
  const phase = state.phase;

  // requestId 不匹配 → 丢弃（关键的"旧 requestId 不会被显示"不变量）
  const activeRequestId = getActiveRequestId(phase);
  if (activeRequestId !== null && 'requestId' in message && message.requestId !== activeRequestId) {
    return state;
  }

  switch (message.type) {
    case 'ASK_VIDEO_QUESTION':
    case 'CANCEL_VIDEO_QUESTION':
      // Port 上不会有这俩；side panel 只发送，background 只接收
      return state;

    case 'VIDEO_ANSWER_CHUNK':
      return appendAssistantText(state, message.text, false);

    case 'VIDEO_ANSWER_REASONING_CHUNK':
      return appendAssistantText(state, message.text, true);

    case 'VIDEO_ANSWER_DONE':
      return finalizeAssistant(state, null);

    case 'VIDEO_ANSWER_ERROR':
      return finalizeAssistant(state, { code: message.code, message: message.message });
  }
}

function getActiveRequestId(phase: FollowupPhase): string | null {
  if (phase.kind === 'loading' || phase.kind === 'streaming' || phase.kind === 'error') {
    return phase.requestId;
  }
  return null;
}

function appendAssistantText(state: FollowupState, delta: string, isReasoning: boolean): FollowupState {
  const phase = state.phase;
  if (phase.kind !== 'loading' && phase.kind !== 'streaming') {
    return state;
  }
  const targetId = phase.assistantMessageId;
  const newMessages = state.messages.map((m) => {
    if (m.id !== targetId) {
      return m;
    }
    if (isReasoning) {
      // reasoning 不进 content，单独累积在 phase
      return m;
    }
    return { ...m, content: m.content + delta };
  });
  if (phase.kind === 'loading') {
    return {
      ...state,
      messages: newMessages,
      phase: {
        kind: 'streaming',
        requestId: phase.requestId,
        userMessageId: phase.userMessageId,
        assistantMessageId: phase.assistantMessageId,
        text: isReasoning ? '' : delta,
        reasoning: isReasoning ? delta : '',
      },
    };
  }
  // streaming
  return {
    ...state,
    messages: newMessages,
    phase: {
      kind: 'streaming',
      requestId: phase.requestId,
      userMessageId: phase.userMessageId,
      assistantMessageId: phase.assistantMessageId,
      text: isReasoning ? phase.text : phase.text + delta,
      reasoning: isReasoning ? phase.reasoning + delta : phase.reasoning,
    },
  };
}

function finalizeAssistant(
  state: FollowupState,
  error: { readonly code: string; readonly message: string } | null,
): FollowupState {
  const phase = state.phase;
  if (phase.kind !== 'loading' && phase.kind !== 'streaming') {
    return state;
  }
  const targetId = phase.assistantMessageId;
  const newMessages = state.messages.map((m) => {
    if (m.id !== targetId) {
      return m;
    }
    if (error) {
      return { ...m, streaming: false, error };
    }
    return { ...m, streaming: false };
  });

  if (error) {
    return {
      ...state,
      messages: newMessages,
      phase: {
        kind: 'error',
        requestId: phase.requestId,
        userMessageId: phase.userMessageId,
        assistantMessageId: phase.assistantMessageId,
        code: error.code,
        message: error.message,
      },
    };
  }
  return {
    ...state,
    messages: newMessages,
    phase: { kind: 'idle' },
  };
}

/**
 * 用户主动停止 / 重新提问：把 phase 切回 idle 并清掉进行中状态。
 * 实际 abort 由调用方发 CANCEL_VIDEO_QUESTION；这里只清理 UI。
 */
export function applyAbort(state: FollowupState): FollowupState {
  if (state.phase.kind === 'idle' || state.phase.kind === 'no_context') {
    return state;
  }
  return { ...state, phase: { kind: 'idle' } };
}

// ---------------------------------------------------------------------------
// Watchdog：纯函数，负责判定"该开哪个 timer"和"timer 触发后怎么改 state"。
// ---------------------------------------------------------------------------

/**
 * Watchdog 阶段：
 * - `first_byte`：从发出 ASK 起算的"首字节超时"。背景在收到第一个 CHUNK / REASONING_CHUNK / DONE / ERROR 之前持续。
 * - `stream_idle`：收到过至少一个 CHUNK 之后起算的"流内静默超时"。每收到一段 chunk 都会重置。
 */
export type WatchdogStage = 'first_byte' | 'stream_idle';

/**
 * 当前应该起 / 不起的 watchdog 描述。FollowupTab 拿到这个返回值后 setTimeout / clearTimeout。
 *
 * - 处于 loading 且从未收到任何 chunk → 返 `first_byte` 的剩余 ms
 * - 处于 streaming（已收到 ≥1 段 chunk） → 返 `stream_idle` 的剩余 ms
 * - 其它 phase → 返 null（不要起 timer）
 */
export function getWatchdogTimer(input: {
  readonly state: FollowupState;
  readonly now: number;
  readonly firstByteTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly lastChunkAt: number | null;
}): { readonly stage: WatchdogStage; readonly fireAt: number } | null {
  const { state, now, firstByteTimeoutMs, streamIdleTimeoutMs, lastChunkAt } = input;
  if (state.phase.kind === 'loading') {
    return { stage: 'first_byte', fireAt: now + firstByteTimeoutMs };
  }
  if (state.phase.kind === 'streaming') {
    if (lastChunkAt === null) {
      // 防御：streaming phase 不应该 lastChunkAt === null，但保险起见
      return { stage: 'stream_idle', fireAt: now + streamIdleTimeoutMs };
    }
    return { stage: 'stream_idle', fireAt: lastChunkAt + streamIdleTimeoutMs };
  }
  return null;
}

/**
 * Watchdog 触发时如何把 state 切到 error。
 *
 * 关键不变量：
 * - 只在 loading / streaming phase 才切到 error，其它 phase 一律返回原 state（不变量：timer 在 race
 *   期间也可能拿到 phase 已经切到 idle / error / no_context 的 state）
 * - 切到 error 时保留 requestId / userMessageId / assistantMessageId 供 UI 展示
 * - 触发理由是 timeout 类的内部超时，code 用 `STREAM_TIMEOUT` 区别于远端 ERROR
 */
export function applyWatchdogTimeout(state: FollowupState): FollowupState {
  const phase = state.phase;
  if (phase.kind !== 'loading' && phase.kind !== 'streaming') {
    return state;
  }
  const newMessages = state.messages.map((m) => {
    if (m.id !== phase.assistantMessageId) {
      return m;
    }
    return {
      ...m,
      streaming: false,
      error: { code: 'STREAM_TIMEOUT', message: '追问响应超时，请重试。' },
    };
  });
  return {
    ...state,
    messages: newMessages,
    phase: {
      kind: 'error',
      requestId: phase.requestId,
      userMessageId: phase.userMessageId,
      assistantMessageId: phase.assistantMessageId,
      code: 'STREAM_TIMEOUT',
      message: '追问响应超时，请重试。',
    },
  };
}

/**
 * Port 断开（side panel 关闭 / service worker 接管后 port 失效）时的本地兜底。
 *
 * 与 watchTimeout 的区别：port 断开意味着远端永远不会推 chunk / done / error，UI 必须立即结束；
 * 而 timeout 是远端"可能"还在跑但我们不再等了。
 */
export function applyPortDisconnected(state: FollowupState): FollowupState {
  const phase = state.phase;
  if (phase.kind !== 'loading' && phase.kind !== 'streaming') {
    return state;
  }
  const newMessages = state.messages.map((m) => {
    if (m.id !== phase.assistantMessageId) {
      return m;
    }
    return {
      ...m,
      streaming: false,
      error: { code: 'PORT_DISCONNECTED', message: '与扩展后台的连接已断开，请重试。' },
    };
  });
  return {
    ...state,
    messages: newMessages,
    phase: {
      kind: 'error',
      requestId: phase.requestId,
      userMessageId: phase.userMessageId,
      assistantMessageId: phase.assistantMessageId,
      code: 'PORT_DISCONNECTED',
      message: '与扩展后台的连接已断开，请重试。',
    },
  };
}

/**
 * postMessage 抛错（Port 已关闭、序列化失败等）时的本地兜底。
 * 与 applyPortDisconnected 同形但 code 不同，区分"port 早已断"和"发不出消息"。
 */
export function applyPostMessageFailed(state: FollowupState, error: unknown): FollowupState {
  const phase = state.phase;
  if (phase.kind !== 'loading' && phase.kind !== 'streaming') {
    return state;
  }
  const detail = error instanceof Error ? error.message : String(error);
  const newMessages = state.messages.map((m) => {
    if (m.id !== phase.assistantMessageId) {
      return m;
    }
    return {
      ...m,
      streaming: false,
      error: { code: 'POST_MESSAGE_FAILED', message: `追问发送失败：${detail}` },
    };
  });
  return {
    ...state,
    messages: newMessages,
    phase: {
      kind: 'error',
      requestId: phase.requestId,
      userMessageId: phase.userMessageId,
      assistantMessageId: phase.assistantMessageId,
      code: 'POST_MESSAGE_FAILED',
      message: `追问发送失败：${detail}`,
    },
  };
}

/**
 * 本地校验失败：把 UI 从 idle / no_context 切到 error，**不**消耗 LLM 调用。
 *
 * 与 watchTimeout / postMessageFailed 的区别：
 * - 该函数**不要求** state 处于 loading / streaming；它是从 idle / no_context
 *   切到 error。
 * - requestId / userMessageId / assistantMessageId 都是 null（因为根本没发请求）。
 * - Phase 切到 error 后，下一次成功提交（handleSubmit 走 applySubmitQuestion
 *   走 idle 路径）会自然恢复。
 */
export function applyLocalError(
  state: FollowupState,
  input: { readonly code: string; readonly message: string },
): FollowupState {
  return {
    ...state,
    phase: {
      kind: 'error',
      requestId: null,
      userMessageId: null,
      assistantMessageId: null,
      code: input.code,
      message: input.message,
    },
  };
}

// ---------------------------------------------------------------------------
// 可测试的纯函数：applySubmitQuestion 的"轻量版"
// ---------------------------------------------------------------------------
// 可测试的纯函数：applySubmitQuestion 的"轻量版"
// ---------------------------------------------------------------------------

/**
 * applySubmitQuestion 内部使用的 helper：把 user/assistant message 插入到 state。
 * 抽出为纯函数方便单测，不依赖时间戳 / id。
 */
export function buildSubmitMessages(input: {
  readonly question: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly now: number;
  readonly previousMessages: readonly FollowupMessage[];
  readonly previousIncludeCurrentSegment: boolean;
}): {
  readonly messages: readonly FollowupMessage[];
  readonly includeCurrentSegment: boolean;
} {
  return {
    messages: [
      ...input.previousMessages,
      { id: input.userMessageId, role: 'user' as const, content: input.question, createdAt: input.now },
      {
        id: input.assistantMessageId,
        role: 'assistant' as const,
        content: '',
        createdAt: input.now,
        streaming: true,
      },
    ],
    includeCurrentSegment: input.previousIncludeCurrentSegment,
  };
}
