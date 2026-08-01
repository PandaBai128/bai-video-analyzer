import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyAbort,
  applyContextCleared,
  applyContextReady,
  applyInputChange,
  applyPortDisconnected,
  applyPortMessage,
  applyPostMessageFailed,
  applySubmitQuestion,
  applyWatchdogTimeout,
  buildSubmitMessages,
  createInitialFollowupState,
  getWatchdogTimer,
  type FollowupState,
} from '@extension/sidepanel/followup-state';
import type { VideoFollowupPortMessage } from '@shared/messages';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `id-${counter}`;
}

beforeEach(() => {
  counter = 0;
});

describe('createInitialFollowupState', () => {
  it('starts in no_context phase with empty messages', () => {
    const s = createInitialFollowupState();
    expect(s.phase.kind).toBe('no_context');
    expect(s.messages).toEqual([]);
    expect(s.includeCurrentSegment).toBe(true);
    expect(s.inputDraft).toBe('');
  });
});

describe('applyContextReady / applyContextCleared', () => {
  it('applyContextReady 在 no_context 状态下切到 idle', () => {
    const s = createInitialFollowupState();
    expect(applyContextReady(s).phase.kind).toBe('idle');
  });

  it('applyContextReady 在非 no_context 状态下不变', () => {
    const s: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    expect(applyContextReady(s).phase.kind).toBe('idle');
  });

  it('applyContextCleared 任何状态下都回 no_context', () => {
    const s: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    expect(applyContextCleared(s).phase.kind).toBe('no_context');
  });
});

describe('applyInputChange', () => {
  it('applyInputChange 改写 inputDraft', () => {
    const s = createInitialFollowupState();
    const next = applyInputChange(s, '视频讲什么');
    expect(next.inputDraft).toBe('视频讲什么');
  });

  it('Round 18 必修 1：UI 删 checkbox 后，applyInputChange 不动 includeCurrentSegment', () => {
    const s = createInitialFollowupState();
    const next = applyInputChange(s, '视频讲什么');
    expect(next.includeCurrentSegment).toBe(s.includeCurrentSegment);
  });
});

describe('applySubmitQuestion', () => {
  it('空问题返回 null', () => {
    const s: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    const result = applySubmitQuestion({
      question: '   ',
      generateRequestId: nextId,
      previousState: s,
    });
    expect(result).toBeNull();
  });

  it('非 idle 状态下提交返回 null（避免在流式中插入新请求）', () => {
    const s: FollowupState = {
      ...createInitialFollowupState(),
      phase: { kind: 'loading', requestId: 'r1', userMessageId: 'u1', assistantMessageId: 'a1' },
    };
    const result = applySubmitQuestion({
      question: '问',
      generateRequestId: nextId,
      previousState: s,
    });
    expect(result).toBeNull();
  });

  it('idle 状态下提交 → 进入 loading，新增 user/assistant 两条 message', () => {
    const s: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    const result = applySubmitQuestion({
      question: '视频讲什么',
      generateRequestId: nextId,
      previousState: s,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.state.phase.kind).toBe('loading');
    expect(result.state.messages).toHaveLength(2);
    expect(result.state.messages[0]?.role).toBe('user');
    expect(result.state.messages[0]?.content).toBe('视频讲什么');
    expect(result.state.messages[1]?.role).toBe('assistant');
    expect(result.state.messages[1]?.streaming).toBe(true);
    expect(result.state.inputDraft).toBe('');
  });
});

describe('applyPortMessage: 防串流污染', () => {
  it('旧 requestId 的 CHUNK 被忽略（防旧回答污染新视频/新问题）', () => {
    const initial: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    const submitted = applySubmitQuestion({
      question: 'q1',
      generateRequestId: () => 'req-A',
      previousState: initial,
    });
    expect(submitted).not.toBeNull();
    if (!submitted) return;

    // 切到 req-B（模拟用户切视频 / 重新提问；新 submit 会 abort 旧 controller）
    const newSubmitted = applySubmitQuestion({
      question: 'q2',
      generateRequestId: () => 'req-B',
      previousState: { ...submitted.state, phase: { kind: 'idle' } },
    });
    expect(newSubmitted).not.toBeNull();
    if (!newSubmitted) return;

    // 旧 req-A 来的 chunk（理论上 controller 不会发，但 side panel 也要防御）
    const staleChunk: VideoFollowupPortMessage = {
      type: 'VIDEO_ANSWER_CHUNK',
      requestId: 'req-A',
      text: 'leaked',
    };
    const after = applyPortMessage(newSubmitted.state, staleChunk);
    // 不应有 "leaked" 出现在 messages
    const assistantContent = after.messages.find((m) => m.id === newSubmitted.assistantMessage.id)?.content ?? '';
    expect(assistantContent).toBe('');
    // phase 不应变 streaming
    expect(after.phase.kind).toBe('loading');
  });
});

describe('applyPortMessage: 正常流式链路', () => {
  function setupWithLoadingRequest(reqId = 'req-1'): FollowupState {
    const initial = createInitialFollowupState();
    const submitted = applySubmitQuestion({
      question: 'q',
      generateRequestId: () => reqId,
      previousState: { ...initial, phase: { kind: 'idle' } },
    });
    if (!submitted) throw new Error('submit failed');
    return submitted.state;
  }

  it('VIDEO_ANSWER_CHUNK 追加到当前 assistant content 并切到 streaming', () => {
    const state = setupWithLoadingRequest();
    const after = applyPortMessage(state, {
      type: 'VIDEO_ANSWER_CHUNK',
      requestId: 'req-1',
      text: '你',
    });
    expect(after.phase.kind).toBe('streaming');
    const assistant = after.messages.find((m) => m.role === 'assistant' && m.streaming);
    expect(assistant?.content).toBe('你');
  });

  it('多次 CHUNK 顺序追加', () => {
    let state = setupWithLoadingRequest();
    state = applyPortMessage(state, { type: 'VIDEO_ANSWER_CHUNK', requestId: 'req-1', text: '你' });
    state = applyPortMessage(state, { type: 'VIDEO_ANSWER_CHUNK', requestId: 'req-1', text: '好' });
    state = applyPortMessage(state, { type: 'VIDEO_ANSWER_CHUNK', requestId: 'req-1', text: '，世界' });
    const assistant = state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('你好，世界');
  });

  it('VIDEO_ANSWER_DONE 标记 streaming=false 并回 idle', () => {
    let state = setupWithLoadingRequest();
    state = applyPortMessage(state, { type: 'VIDEO_ANSWER_CHUNK', requestId: 'req-1', text: 'ok' });
    state = applyPortMessage(state, { type: 'VIDEO_ANSWER_DONE', requestId: 'req-1' });
    expect(state.phase.kind).toBe('idle');
    const assistant = state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.streaming).toBe(false);
  });

  it('VIDEO_ANSWER_ERROR 标记错误并切到 error phase', () => {
    let state = setupWithLoadingRequest();
    state = applyPortMessage(state, {
      type: 'VIDEO_ANSWER_ERROR',
      requestId: 'req-1',
      code: 'STREAM_FAILED',
      message: '网络挂了',
    });
    expect(state.phase.kind).toBe('error');
    if (state.phase.kind === 'error') {
      expect(state.phase.code).toBe('STREAM_FAILED');
      expect(state.phase.message).toBe('网络挂了');
    }
    const assistant = state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.error?.code).toBe('STREAM_FAILED');
    expect(assistant?.streaming).toBe(false);
  });

  it('REASONING_CHUNK 不写入 content（不进 user 可见文本）', () => {
    let state = setupWithLoadingRequest();
    state = applyPortMessage(state, {
      type: 'VIDEO_ANSWER_REASONING_CHUNK',
      requestId: 'req-1',
      text: 'thinking...',
    });
    const assistant = state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('');
    expect(state.phase.kind).toBe('streaming');
    if (state.phase.kind === 'streaming') {
      expect(state.phase.reasoning).toBe('thinking...');
    }
  });
});

describe('applyAbort', () => {
  it('loading 状态下 abort → 回 idle', () => {
    const state: FollowupState = {
      ...createInitialFollowupState(),
      phase: { kind: 'loading', requestId: 'r1', userMessageId: 'u1', assistantMessageId: 'a1' },
    };
    expect(applyAbort(state).phase.kind).toBe('idle');
  });

  it('idle 状态下 abort → 不变', () => {
    const state: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    expect(applyAbort(state).phase.kind).toBe('idle');
  });
});

describe('buildSubmitMessages (纯函数)', () => {
  it('插入 user + assistant 流式消息', () => {
    const result = buildSubmitMessages({
      question: '问',
      userMessageId: 'u',
      assistantMessageId: 'a',
      now: 100,
      previousMessages: [],
      previousIncludeCurrentSegment: true,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ id: 'u', role: 'user', content: '问', createdAt: 100 });
    expect(result.messages[1]).toMatchObject({
      id: 'a',
      role: 'assistant',
      content: '',
      createdAt: 100,
      streaming: true,
    });
    expect(result.includeCurrentSegment).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round13：watchdog / port 断开 / postMessage 失败 → 纯函数兜底
// ---------------------------------------------------------------------------

function makeLoadingState(reqId = 'req-wd'): FollowupState {
  const initial: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
  const submitted = applySubmitQuestion({
    question: 'q',
    generateRequestId: () => reqId,
    previousState: initial,
  });
  if (!submitted) {
    throw new Error('submit failed');
  }
  return submitted.state;
}

function makeStreamingState(reqId = 'req-stream'): FollowupState {
  const loading = makeLoadingState(reqId);
  return applyPortMessage(loading, { type: 'VIDEO_ANSWER_CHUNK', requestId: reqId, text: 'partial' });
}

describe('getWatchdogTimer', () => {
  it('loading 阶段：返 first_byte 阶段 + 距 now 30s 的 fireAt', () => {
    const state = makeLoadingState();
    const result = getWatchdogTimer({
      state,
      now: 1000,
      firstByteTimeoutMs: 30_000,
      streamIdleTimeoutMs: 60_000,
      lastChunkAt: null,
    });
    expect(result).toEqual({ stage: 'first_byte', fireAt: 31_000 });
  });

  it('streaming 阶段：返 stream_idle 阶段 + 距 lastChunkAt 60s 的 fireAt', () => {
    const state = makeStreamingState();
    const result = getWatchdogTimer({
      state,
      now: 5000,
      firstByteTimeoutMs: 30_000,
      streamIdleTimeoutMs: 60_000,
      lastChunkAt: 2000,
    });
    expect(result).toEqual({ stage: 'stream_idle', fireAt: 62_000 });
  });

  it('idle 阶段：返 null（不要起 timer）', () => {
    const state: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    const result = getWatchdogTimer({
      state,
      now: 1000,
      firstByteTimeoutMs: 30_000,
      streamIdleTimeoutMs: 60_000,
      lastChunkAt: null,
    });
    expect(result).toBeNull();
  });

  it('error / no_context 阶段：返 null', () => {
    const stateError: FollowupState = {
      ...createInitialFollowupState(),
      phase: { kind: 'error', requestId: 'r', userMessageId: 'u', assistantMessageId: 'a', code: 'X', message: 'X' },
    };
    const stateNoCtx: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'no_context' } };
    expect(
      getWatchdogTimer({
        state: stateError,
        now: 0,
        firstByteTimeoutMs: 30_000,
        streamIdleTimeoutMs: 60_000,
        lastChunkAt: null,
      }),
    ).toBeNull();
    expect(
      getWatchdogTimer({
        state: stateNoCtx,
        now: 0,
        firstByteTimeoutMs: 30_000,
        streamIdleTimeoutMs: 60_000,
        lastChunkAt: null,
      }),
    ).toBeNull();
  });
});

describe('applyWatchdogTimeout', () => {
  it('loading 阶段触发 → 进 error phase，assistant 标 streaming=false + error.code=STREAM_TIMEOUT', () => {
    const state = makeLoadingState('req-wd');
    const after = applyWatchdogTimeout(state);
    expect(after.phase.kind).toBe('error');
    if (after.phase.kind === 'error') {
      expect(after.phase.code).toBe('STREAM_TIMEOUT');
      expect(after.phase.requestId).toBe('req-wd');
    }
    const assistant = after.messages.find((m) => m.role === 'assistant');
    expect(assistant?.error?.code).toBe('STREAM_TIMEOUT');
    expect(assistant?.streaming).toBe(false);
  });

  it('streaming 阶段触发 → 进 error phase（保留 text）', () => {
    const state = makeStreamingState('req-stream');
    const after = applyWatchdogTimeout(state);
    expect(after.phase.kind).toBe('error');
    const assistant = after.messages.find((m) => m.role === 'assistant');
    expect(assistant?.error?.code).toBe('STREAM_TIMEOUT');
    expect(assistant?.content).toBe('partial');
  });

  it('idle 阶段触发 → 不变（不变量：timer race 时 phase 可能已切走）', () => {
    const state: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    const after = applyWatchdogTimeout(state);
    expect(after.phase.kind).toBe('idle');
  });
});

describe('applyPortDisconnected', () => {
  it('loading 阶段 → 进 error phase，code=PORT_DISCONNECTED', () => {
    const state = makeLoadingState('req-disc');
    const after = applyPortDisconnected(state);
    expect(after.phase.kind).toBe('error');
    if (after.phase.kind === 'error') {
      expect(after.phase.code).toBe('PORT_DISCONNECTED');
    }
    const assistant = after.messages.find((m) => m.role === 'assistant');
    expect(assistant?.error?.code).toBe('PORT_DISCONNECTED');
  });

  it('streaming 阶段 → 进 error phase', () => {
    const state = makeStreamingState('req-stream-disc');
    const after = applyPortDisconnected(state);
    expect(after.phase.kind).toBe('error');
    if (after.phase.kind === 'error') {
      expect(after.phase.code).toBe('PORT_DISCONNECTED');
    }
  });

  it('idle 阶段 → 不变', () => {
    const state: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    const after = applyPortDisconnected(state);
    expect(after.phase.kind).toBe('idle');
  });
});

describe('applyPostMessageFailed', () => {
  it('loading 阶段 → 进 error phase，code=POST_MESSAGE_FAILED + detail 信息', () => {
    const state = makeLoadingState('req-pm');
    const after = applyPostMessageFailed(state, new Error('port 已关闭'));
    expect(after.phase.kind).toBe('error');
    if (after.phase.kind === 'error') {
      expect(after.phase.code).toBe('POST_MESSAGE_FAILED');
      expect(after.phase.message).toContain('port 已关闭');
    }
    const assistant = after.messages.find((m) => m.role === 'assistant');
    expect(assistant?.error?.code).toBe('POST_MESSAGE_FAILED');
  });

  it('streaming 阶段 → 进 error phase', () => {
    const state = makeStreamingState('req-stream-pm');
    const after = applyPostMessageFailed(state, 'serialization error');
    expect(after.phase.kind).toBe('error');
    if (after.phase.kind === 'error') {
      expect(after.phase.code).toBe('POST_MESSAGE_FAILED');
      expect(after.phase.message).toContain('serialization error');
    }
  });

  it('idle 阶段 → 不变（不变量）', () => {
    const state: FollowupState = { ...createInitialFollowupState(), phase: { kind: 'idle' } };
    const after = applyPostMessageFailed(state, new Error('ignored'));
    expect(after.phase.kind).toBe('idle');
  });
});
