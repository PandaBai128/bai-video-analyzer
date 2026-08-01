import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFollowupSession } from '@extension/sidepanel/followup/use-followup-session';
import {
  BILIBILI_CTX,
  PLAYBACK,
  getAskPayload,
  installChromePortStub,
  makeRequestIdFactory,
  uninstallChromePortStub,
  type FakePort,
} from './helpers/followup-test-harness';
import type { AnalysisMode } from '@shared/settings';

/**
 * useFollowupSession hook 的行为测例。
 *
 * 拆分原则（SG-04）：FollowupTab.tsx 只做页面组合，Port 生命周期 / watchdog /
 * intent 路由 / payload 构造都迁入本 hook。测试用 renderHook 直接驱动，避免被
 * FollowupTab 集成副作用（DOM / 滚动）污染断言。
 *
 * 不变量：
 * - requestId 必须贯穿 UI state 和 Port payload（测 requestId 一致性）
 * - DONE / ERROR / disconnect / timeout / postMessage throw 后必须退出 busy
 * - currentTime / selectedTimestamp 只在明确 intent + 有效值时才透传
 * - hasContentContext=false 时不消耗 LLM
 * - contextKey 切换时隐藏旧会话但不取消；旧 chunk 只更新原 context 快照，切回可恢复
 *
 * 共享测试工具：FakePort / chrome.runtime stub 走 tests/unit/helpers/followup-test-harness。
 */

interface RenderHarness {
  port: FakePort;
  result: {
    readonly current: ReturnType<typeof useFollowupSession>;
  };
  unmount: () => void;
  rerender: (next: {
    hasContentContext?: boolean;
    contextKey?: string;
    selectedTimestamp?: number | null;
    playbackState?: typeof PLAYBACK | null;
    analysisMode?: AnalysisMode;
  }) => void;
}

interface RenderOptions {
  readonly hasContentContext?: boolean;
  readonly contextKey?: string;
  readonly selectedTimestamp?: number | null;
  readonly playbackState?: typeof PLAYBACK | null;
  readonly analysisMode?: AnalysisMode;
  readonly requestIdFactory?: () => string;
  readonly firstByteTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly onRender?: (snapshot: {
    readonly contextKey: string;
    readonly state: ReturnType<typeof useFollowupSession>['state'];
    readonly phase: ReturnType<typeof useFollowupSession>['phase'];
    readonly answerBasis: ReturnType<typeof useFollowupSession>['answerBasis'];
  }) => void;
}

function renderFollowupSession(options: RenderOptions = {}): RenderHarness {
  const port = installChromePortStub();
  const requestIdFactory = options.requestIdFactory ?? makeRequestIdFactory('req');
  const initialProps = {
    hasContentContext: options.hasContentContext ?? true,
    analysisMode: options.analysisMode ?? 'subtitle',
    playbackState: options.playbackState !== undefined ? options.playbackState : PLAYBACK,
    contextKey: options.contextKey ?? 'ctx-1',
    ...(options.selectedTimestamp !== undefined
      ? { selectedTimestamp: options.selectedTimestamp }
      : {}),
    ...(options.firstByteTimeoutMs !== undefined
      ? { firstByteTimeoutMs: options.firstByteTimeoutMs }
      : {}),
    ...(options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {}),
    requestIdFactory,
  };

  let latest: { current: ReturnType<typeof useFollowupSession> } = {
    current: undefined as unknown as ReturnType<typeof useFollowupSession>,
  };
  const view = renderHook(
    (props: typeof initialProps) => {
      const result = useFollowupSession(props);
      latest.current = result;
      options.onRender?.({
        contextKey: props.contextKey,
        state: result.state,
        phase: result.phase,
        answerBasis: result.answerBasis,
      });
      return result;
    },
    { initialProps },
  );

  return {
    port,
    result: latest,
    unmount: () => view.unmount(),
    rerender: (next) => {
      act(() => {
        view.rerender({
          ...initialProps,
          hasContentContext: next.hasContentContext ?? initialProps.hasContentContext,
          analysisMode: next.analysisMode ?? initialProps.analysisMode,
          contextKey: next.contextKey ?? initialProps.contextKey,
          ...(next.selectedTimestamp !== undefined
            ? { selectedTimestamp: next.selectedTimestamp }
            : initialProps.selectedTimestamp !== undefined
              ? { selectedTimestamp: initialProps.selectedTimestamp }
              : {}),
          ...(next.playbackState !== undefined ? { playbackState: next.playbackState } : {}),
        });
      });
    },
  };
}

beforeEach(() => {
  // 不开 fakeTimers：会让 RTL 的 act / waitFor 卡住。超时测试改用真实 setTimeout 推进。
  globalThis.sessionStorage?.clear();
});

afterEach(() => {
  globalThis.sessionStorage?.clear();
  uninstallChromePortStub();
  vi.restoreAllMocks();
});

describe('useFollowupSession 初始 state + contextKey / hasContentContext 重置', () => {
  it('初始 state：no_context + empty messages + inputDraft 为空', () => {
    const harness = renderFollowupSession({ hasContentContext: false });
    expect(harness.result.current.state.phase.kind).toBe('no_context');
    expect(harness.result.current.state.messages).toEqual([]);
    expect(harness.result.current.state.inputDraft).toBe('');
    expect(harness.result.current.isBusy).toBe(false);
  });

  it('hasContentContext 变化时 phase 跟随切到 idle / no_context', () => {
    const harness = renderFollowupSession({ hasContentContext: false });
    expect(harness.result.current.state.phase.kind).toBe('no_context');

    act(() => {
      harness.rerender({ hasContentContext: true });
    });
    expect(harness.result.current.state.phase.kind).toBe('idle');
  });

  it('contextKey 变化时隐藏旧 session，但不取消旧 in-flight；切回后恢复旧流式内容', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req'),
    });
    // 进入 streaming：submit + 一段 CHUNK
    act(() => {
      harness.result.current.submitQuestion('第一个视频的问题');
    });
    const firstRequestId = getAskPayload(harness.port).requestId;
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstRequestId,
        text: '一段回答',
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('streaming');
    expect(harness.result.current.state.messages.length).toBe(2);

    // 输入框先写一段 draft，验证切换时一并清空
    act(() => {
      harness.result.current.changeInputDraft('残留草稿');
    });
    expect(harness.result.current.state.inputDraft).toBe('残留草稿');

    // 切 contextKey → 当前 UI 显示新 session，旧请求继续在后台跑
    act(() => {
      harness.rerender({ contextKey: 'ctx-2' });
    });
    expect(harness.result.current.state.phase.kind).toBe('idle');
    expect(harness.result.current.state.messages).toEqual([]);
    expect(harness.result.current.state.inputDraft).toBe('');
    expect(
      harness.port.postMessage.mock.calls.some(
        (call) => (call[0] as { type?: string }).type === 'CANCEL_VIDEO_QUESTION',
      ),
    ).toBe(false);

    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstRequestId,
        text: ' 后续回答',
      });
    });
    expect(harness.result.current.state.messages).toEqual([]);

    act(() => {
      harness.rerender({ contextKey: 'ctx-1' });
    });
    expect(harness.result.current.state.phase.kind).toBe('streaming');
    expect(harness.result.current.state.messages.at(-1)?.content).toBe('一段回答 后续回答');
  });

  it('contextKey 变化后的首帧不渲染旧视频 state，也不把旧 state 持久化到新 contextKey', () => {
    const renders: Array<{
      readonly contextKey: string;
      readonly state: ReturnType<typeof useFollowupSession>['state'];
      readonly phase: ReturnType<typeof useFollowupSession>['phase'];
    }> = [];
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const harness = renderFollowupSession({
      contextKey: 'bilibili:ctx-1:p=1:subtitle',
      requestIdFactory: makeRequestIdFactory('req-p1'),
      onRender: (snapshot) => {
        renders.push({
          contextKey: snapshot.contextKey,
          state: snapshot.state,
          phase: snapshot.phase,
        });
      },
    });

    act(() => {
      harness.result.current.submitQuestion('ctx-1 问题');
      harness.result.current.changeInputDraft('ctx-1 草稿');
    });
    expect(harness.result.current.state.messages[0]?.content).toBe('ctx-1 问题');
    expect(harness.result.current.state.inputDraft).toBe('ctx-1 草稿');

    const beforeSwitchRenderCount = renders.length;
    harness.rerender({ contextKey: 'bilibili:ctx-2:p=1:subtitle' });

    const firstCtx2Render = renders
      .slice(beforeSwitchRenderCount)
      .find((entry) => entry.contextKey === 'bilibili:ctx-2:p=1:subtitle');
    expect(firstCtx2Render).toBeDefined();
    expect(firstCtx2Render?.phase.kind).toBe('idle');
    expect(firstCtx2Render?.state.messages).toEqual([]);
    expect(firstCtx2Render?.state.inputDraft).toBe('');

    const ctx2Writes = setItemSpy.mock.calls.filter(([key]) =>
      String(key).includes('bilibili:ctx-2:p=1:subtitle'),
    );
    expect(
      ctx2Writes.some(([, value]) => {
        const payload = String(value);
        return payload.includes('ctx-1 问题') || payload.includes('ctx-1 草稿');
      }),
    ).toBe(false);
  });

  it('contextKey 变化时清 watchdog timer：切换前启用的 first_byte watchdog 不会再触发 STREAM_TIMEOUT', async () => {
    const harness = renderFollowupSession({
      firstByteTimeoutMs: 50,
      streamIdleTimeoutMs: 50,
      requestIdFactory: makeRequestIdFactory('req-wd'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    expect(harness.result.current.state.phase.kind).toBe('loading');
    // 在 watchdog 触发前切 contextKey → 当前 context 的 watchdog 应被清掉，phase 切 idle 而不是 error
    act(() => {
      harness.rerender({ contextKey: 'ctx-2' });
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    });
    expect(harness.result.current.state.phase.kind).toBe('idle');
  });

  it('contextKey 变化时旧 requestId 的 CHUNK / DONE 不改变新 session，但会更新旧 session 快照', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req'),
    });
    act(() => {
      harness.result.current.submitQuestion('第一个视频');
    });
    const firstRequestId = getAskPayload(harness.port).requestId;
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstRequestId,
        text: '旧 chunk',
      });
    });

    // 切 contextKey → 新 session 显示为空
    act(() => {
      harness.rerender({ contextKey: 'ctx-2' });
    });
    expect(harness.result.current.state.messages).toEqual([]);

    // 新 session 提交一个不同问题，得到新 requestId
    act(() => {
      harness.result.current.submitQuestion('第二个视频');
    });
    const askCalls = harness.port.postMessage.mock.calls
      .map((c) => c[0])
      .filter(
        (m): m is { type: string; requestId: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'ASK_VIDEO_QUESTION',
      );
    expect(askCalls.at(-1)?.requestId).toBe('req-2');

    // 旧 requestId 推 CHUNK → 新 session 不变
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstRequestId,
        text: '旧 chunk 不该进',
      });
    });
    const assistant = harness.result.current.state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('');

    // 旧 requestId 推 DONE → 同样不污染当前新 session
    act(() => {
      harness.port.emitMessage({ type: 'VIDEO_ANSWER_DONE', requestId: firstRequestId });
    });
    expect(harness.result.current.state.phase.kind).toBe('loading');

    act(() => {
      harness.rerender({ contextKey: 'ctx-1' });
    });
    expect(harness.result.current.state.phase.kind).toBe('idle');
    expect(harness.result.current.state.messages.at(-1)?.content).toBe('旧 chunk旧 chunk 不该进');
  });

  it('contextKey 变化时不取消旧 in-flight；只有用户主动停止才发 CANCEL_VIDEO_QUESTION', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req'),
    });
    act(() => {
      harness.result.current.submitQuestion('第一个视频');
    });
    const firstRequestId = getAskPayload(harness.port).requestId;

    // 切 contextKey → 不发 CANCEL
    act(() => {
      harness.rerender({ contextKey: 'ctx-2' });
    });
    const cancelCalls = harness.port.postMessage.mock.calls
      .map((c) => c[0])
      .filter(
        (m): m is { type: string; requestId: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'CANCEL_VIDEO_QUESTION',
      );
    expect(cancelCalls.length).toBe(0);

    act(() => {
      harness.rerender({ contextKey: 'ctx-1' });
    });
    act(() => {
      harness.result.current.cancelQuestion();
    });

    const nextCancelCalls = harness.port.postMessage.mock.calls
      .map((call) => call[0])
      .filter(
        (m): m is { type: string; requestId: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'CANCEL_VIDEO_QUESTION',
      );
    expect(nextCancelCalls.length).toBe(1);
    expect(nextCancelCalls[0]?.requestId).toBe(firstRequestId);
    expect(harness.result.current.isBusy).toBe(false);
  });

  it('contextKey 不变 + hasContentContext 从 false → true：phase 从 no_context 切 idle（保留现有语义）', () => {
    const harness = renderFollowupSession({
      hasContentContext: false,
      contextKey: 'ctx-1',
    });
    expect(harness.result.current.state.phase.kind).toBe('no_context');
    act(() => {
      harness.rerender({ hasContentContext: true, contextKey: 'ctx-1' });
    });
    expect(harness.result.current.state.phase.kind).toBe('idle');
  });
});

describe('useFollowupSession 临时会话恢复', () => {
  it('同一 contextKey 重新挂载后恢复已完成问答、草稿和回答依据', () => {
    const first = renderFollowupSession({
      contextKey: 'bilibili:BV1persist:p=1:subtitle',
      requestIdFactory: makeRequestIdFactory('req-persist'),
    });

    act(() => {
      first.result.current.changeAnswerBasis('video_plus_general');
      first.result.current.submitQuestion('这个视频主要讲了什么？');
    });
    const ask = getAskPayload(first.port);
    act(() => {
      first.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: ask.requestId,
        text: '视频主要讲 AI 陪练式学习。',
      });
      first.port.emitMessage({ type: 'VIDEO_ANSWER_DONE', requestId: ask.requestId });
      first.result.current.changeInputDraft('下一步想问的问题');
    });

    expect(first.result.current.state.phase.kind).toBe('idle');
    expect(first.result.current.state.messages.map((message) => message.content)).toEqual([
      '这个视频主要讲了什么？',
      '视频主要讲 AI 陪练式学习。',
    ]);
    first.unmount();

    const second = renderFollowupSession({
      contextKey: 'bilibili:BV1persist:p=1:subtitle',
      requestIdFactory: makeRequestIdFactory('req-restored'),
    });

    expect(second.result.current.state.phase.kind).toBe('idle');
    expect(second.result.current.answerBasis).toBe('video_plus_general');
    expect(second.result.current.state.inputDraft).toBe('下一步想问的问题');
    expect(second.result.current.state.messages.map((message) => message.content)).toEqual([
      '这个视频主要讲了什么？',
      '视频主要讲 AI 陪练式学习。',
    ]);
  });

  it('重新挂载时把未完成的流式回答标记为中断，避免恢复成一直生成中', () => {
    const first = renderFollowupSession({
      contextKey: 'bilibili:BV1interrupt:p=1:subtitle',
      requestIdFactory: makeRequestIdFactory('req-interrupt'),
    });

    act(() => {
      first.result.current.submitQuestion('继续解释这一段');
    });
    const ask = getAskPayload(first.port);
    act(() => {
      first.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: ask.requestId,
        text: '回答开头',
      });
    });
    expect(first.result.current.state.phase.kind).toBe('streaming');
    first.unmount();

    const second = renderFollowupSession({
      contextKey: 'bilibili:BV1interrupt:p=1:subtitle',
      requestIdFactory: makeRequestIdFactory('req-restored'),
    });
    const assistant = second.result.current.state.messages.find(
      (message) => message.role === 'assistant',
    );

    expect(second.result.current.state.phase.kind).toBe('idle');
    expect(assistant?.content).toBe('回答开头');
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.error?.code).toBe('SESSION_INTERRUPTED');
  });
});

describe('useFollowupSession submitQuestion 意图路由', () => {
  it('ASK_VIDEO_QUESTION 固定带公开版字幕模式标记', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-subtitle'),
    });
    act(() => {
      harness.result.current.submitQuestion('这个视频主要讲什么？');
    });
    expect(getAskPayload(harness.port).analysisMode).toBe('subtitle');
  });

  it('"解释当前片段" + playbackState.currentTime=30 → 发包带 currentTime=30，question 含"当前播放时间：0:30"', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-anchor'),
    });
    act(() => {
      harness.result.current.submitQuestion('解释当前片段', {
        requiresCurrentTime: true,
        forceCurrentSegment: true,
      });
    });
    const ask = getAskPayload(harness.port);
    expect(ask.currentTime).toBe(30);
    expect(ask.question).toContain('当前播放时间');
    expect(ask.question).toMatch(/0:30/);
  });

  it('英文当前片段快捷问题追加时间锚点后，answerLocale 仍按原始英文问题判定', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-en-anchor'),
    });
    act(() => {
      harness.result.current.submitQuestion(
        'Explain what the current segment is saying, how it relates to the surrounding content, and the key details to catch here.',
        {
          requiresCurrentTime: true,
          forceCurrentSegment: true,
        },
      );
    });
    const ask = getAskPayload(harness.port);
    expect(ask.question).toContain('current playback time');
    expect(ask.question).not.toContain('当前播放时间');
    expect(ask.answerLocale).toBe('en-US');
  });

  it('英文自动追问即使引用中文短语，answerLocale 仍按英文提问框架判定', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-mixed-followup'),
    });
    act(() => {
      harness.result.current.submitQuestion(
        'Can you show me which exact animation frame she means by “冲刺末尾收扇”?',
      );
    });
    const ask = getAskPayload(harness.port);
    expect(ask.answerLocale).toBe('en-US');
  });

  it('"解释当前片段" + playbackState=null → 本地 MISSING_CURRENT_TIME，不发 ASK_VIDEO_QUESTION', () => {
    const harness = renderFollowupSession({
      playbackState: null,
      requestIdFactory: makeRequestIdFactory('req-missing'),
    });
    const before = harness.port.postMessage.mock.calls.length;
    act(() => {
      harness.result.current.submitQuestion('解释当前片段', {
        requiresCurrentTime: true,
        forceCurrentSegment: true,
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('MISSING_CURRENT_TIME');
    }
    const askCalls = harness.port.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'ASK_VIDEO_QUESTION',
    );
    expect(askCalls.length).toBe(0);
    expect(harness.port.postMessage.mock.calls.length).toBe(before);
  });

  it('"解释当前片段" + playbackState.currentTime=NaN（防御）→ 本地拦截', () => {
    const harness = renderFollowupSession({
      playbackState: { currentTime: Number.NaN, duration: 600, paused: true, updatedAt: 0 },
      requestIdFactory: makeRequestIdFactory('req-nan'),
    });
    act(() => {
      harness.result.current.submitQuestion('解释当前片段', {
        requiresCurrentTime: true,
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
  });

  it('自由输入"这里讲了什么？" + playbackState=null → 命中 current intent，本地拦截', () => {
    const harness = renderFollowupSession({
      playbackState: null,
      requestIdFactory: makeRequestIdFactory('req-local'),
    });
    act(() => {
      harness.result.current.submitQuestion('这里讲了什么？');
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('MISSING_CURRENT_TIME');
    }
  });

  it('自由输入"这段讲什么？" + playbackState.currentTime=30 → 发包带 currentTime=30 且 question 含 0:30', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-current'),
    });
    act(() => {
      harness.result.current.submitQuestion('这段讲什么？');
    });
    const ask = getAskPayload(harness.port);
    expect(ask.currentTime).toBe(30);
    expect(ask.question).toContain('当前播放时间');
    expect(ask.question).toMatch(/0:30/);
  });

  it('自由输入"我选的这个节点为什么重要？" + selectedTimestamp=300 → 发包带 selectedTimestamp=300', () => {
    const harness = renderFollowupSession({
      selectedTimestamp: 300,
      requestIdFactory: makeRequestIdFactory('req-sel'),
    });
    act(() => {
      harness.result.current.submitQuestion('我选的这个节点为什么重要？');
    });
    expect(getAskPayload(harness.port).selectedTimestamp).toBe(300);
  });

  it('自由输入"这个视频主要讲什么？" + selectedTimestamp=300 → 全局白名单命中，不带 selectedTimestamp', () => {
    const harness = renderFollowupSession({
      selectedTimestamp: 300,
      requestIdFactory: makeRequestIdFactory('req-global'),
    });
    act(() => {
      harness.result.current.submitQuestion('这个视频主要讲什么？');
    });
    expect(getAskPayload(harness.port).selectedTimestamp).toBeUndefined();
  });

  it('自由输入 + selectedTimestamp=null → 不带 selectedTimestamp', () => {
    const harness = renderFollowupSession({
      selectedTimestamp: null,
      requestIdFactory: makeRequestIdFactory('req-null'),
    });
    act(() => {
      harness.result.current.submitQuestion('这段讲什么？');
    });
    expect(getAskPayload(harness.port).selectedTimestamp).toBeUndefined();
  });

  it('自由输入 + selectedTimestamp=NaN（防御）→ 不带 selectedTimestamp', () => {
    const harness = renderFollowupSession({
      selectedTimestamp: Number.NaN,
      requestIdFactory: makeRequestIdFactory('req-nan-sel'),
    });
    act(() => {
      harness.result.current.submitQuestion('这个视频主要讲什么？');
    });
    expect(getAskPayload(harness.port).selectedTimestamp).toBeUndefined();
  });

  it('"解释当前片段"（forceCurrentSegment=true）+ selectedTimestamp=120 → force 压住，不带 selectedTimestamp', () => {
    const harness = renderFollowupSession({
      selectedTimestamp: 120,
      requestIdFactory: makeRequestIdFactory('req-force'),
    });
    act(() => {
      harness.result.current.submitQuestion('解释当前片段', {
        requiresCurrentTime: true,
        forceCurrentSegment: true,
      });
    });
    const ask = getAskPayload(harness.port);
    expect(ask.forceCurrentSegment).toBe(true);
    expect(ask.selectedTimestamp).toBeUndefined();
    expect(ask.currentTime).toBe(PLAYBACK.currentTime);
  });

  it('全局快捷问题 + selectedTimestamp=300 → 不带 selectedTimestamp', () => {
    const harness = renderFollowupSession({
      selectedTimestamp: 300,
      requestIdFactory: makeRequestIdFactory('req-globalsel'),
    });
    act(() => {
      harness.result.current.submitQuestion('有哪些地方值得重点回看？');
    });
    expect(getAskPayload(harness.port).selectedTimestamp).toBeUndefined();
  });

  it('自由输入"现在讲的是什么？"（explicit current）+ selectedTimestamp=300 → 不带 selectedTimestamp', () => {
    const harness = renderFollowupSession({
      selectedTimestamp: 300,
      requestIdFactory: makeRequestIdFactory('req-explicit'),
    });
    act(() => {
      harness.result.current.submitQuestion('现在讲的是什么？');
    });
    const ask = getAskPayload(harness.port);
    expect(ask.selectedTimestamp).toBeUndefined();
    expect(ask.currentTime).toBe(PLAYBACK.currentTime);
  });

  it('hasContentContext=false → submitQuestion 不发包', () => {
    const harness = renderFollowupSession({
      hasContentContext: false,
      requestIdFactory: makeRequestIdFactory('req-nocc'),
    });
    act(() => {
      harness.result.current.submitQuestion('任何问题');
    });
    const askCalls = harness.port.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'ASK_VIDEO_QUESTION',
    );
    expect(askCalls.length).toBe(0);
  });
});

describe('useFollowupSession requestId 一致性 + lifecycle', () => {
  it('applySubmitQuestion 用的 requestId 与 postMessage 的 requestId 完全一致', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-fixed'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题 1');
    });
    expect(getAskPayload(harness.port).requestId).toBe('req-fixed-1');
  });

  it('CHUNK 流式：相同 requestId 累加到 assistant content；phase 切到 streaming', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-stream'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    const ask = getAskPayload(harness.port);
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: ask.requestId,
        text: '第 1 段',
      });
    });
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: ask.requestId,
        text: '第 2 段',
      });
    });
    const assistant = harness.result.current.state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('第 1 段第 2 段');
    expect(harness.result.current.state.phase.kind).toBe('streaming');
  });

  it('CHUNK 旧 requestId 不追加到新 assistant（防串流）', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-mismatch'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: 'req-OLD',
        text: '旧 chunk 不该进',
      });
    });
    const assistant = harness.result.current.state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('');
  });

  it('DONE 后 phase 切回 idle', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-done'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    const ask = getAskPayload(harness.port);
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: ask.requestId,
        text: '一些回答',
      });
    });
    act(() => {
      harness.port.emitMessage({ type: 'VIDEO_ANSWER_DONE', requestId: ask.requestId });
    });
    expect(harness.result.current.state.phase.kind).toBe('idle');
    expect(harness.result.current.isBusy).toBe(false);
  });

  it('ERROR 后 phase 切到 error，UI 不再卡 busy', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-err'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    const ask = getAskPayload(harness.port);
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_ERROR',
        requestId: ask.requestId,
        code: 'NO_CONTENT_CONTEXT',
        message: '当前视频没有可用的字幕或转写。',
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
    expect(harness.result.current.isBusy).toBe(false);
  });

  it('cancel + retry：CANCEL_VIDEO_QUESTION 的 requestId 必须 = 第一次 ASK 的 requestId；第二次 ASK 用新 requestId', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-cancel'),
    });
    // 第一次 ASK → req-cancel-1
    act(() => {
      harness.result.current.submitQuestion('问题 A');
    });
    const firstAsk = getAskPayload(harness.port);
    expect(firstAsk.requestId).toBe('req-cancel-1');
    // 不发 DONE / ERROR，直接发第二个问题 → 走 cancel + retry
    act(() => {
      harness.result.current.submitQuestion('问题 B');
    });
    const cancelCalls = harness.port.postMessage.mock.calls
      .map((c) => c[0])
      .filter(
        (m): m is { type: string; requestId: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'CANCEL_VIDEO_QUESTION',
      );
    expect(cancelCalls.length).toBe(1);
    // 关键断言：CANCEL 的 requestId 必须是第一次 ASK 的 requestId
    expect(cancelCalls[0]?.requestId).toBe('req-cancel-1');
    // 第二次 ASK 用新 requestId
    const askCalls = harness.port.postMessage.mock.calls
      .map((c) => c[0])
      .filter(
        (m): m is { type: string; requestId: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'ASK_VIDEO_QUESTION',
      );
    expect(askCalls.length).toBe(2);
    expect(askCalls[0]?.requestId).toBe('req-cancel-1');
    expect(askCalls[1]?.requestId).toBe('req-cancel-2');
  });
});

describe('useFollowupSession 错误兜底', () => {
  it('port.postMessage 抛错 → phase 切到 error（POST_MESSAGE_FAILED），isBusy=false', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-throw'),
    });
    harness.port.postMessage.mockImplementation(() => {
      throw new Error('port 已关闭');
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('POST_MESSAGE_FAILED');
    }
    expect(harness.result.current.isBusy).toBe(false);
  });

  it('port disconnect → loading 中本地切到 error（PORT_DISCONNECTED），isBusy=false', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-disc'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: getAskPayload(harness.port).requestId,
        text: '一段',
      });
    });
    expect(harness.result.current.isBusy).toBe(true);
    act(() => {
      harness.port.emitDisconnect();
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('PORT_DISCONNECTED');
    }
    expect(harness.result.current.isBusy).toBe(false);
  });

  it('port disconnect 会结束隐藏 context 的 in-flight 快照，切回后不能继续 busy', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req-hidden-disc'),
    });
    act(() => {
      harness.result.current.submitQuestion('ctx-1 问题');
    });
    const firstRequestId = getAskPayload(harness.port).requestId;
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstRequestId,
        text: 'ctx-1 回答开头',
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('streaming');

    act(() => {
      harness.rerender({ contextKey: 'ctx-2' });
    });
    expect(harness.result.current.state.phase.kind).toBe('idle');

    act(() => {
      harness.port.emitDisconnect();
    });
    expect(harness.result.current.isBusy).toBe(false);

    act(() => {
      harness.rerender({ contextKey: 'ctx-1' });
    });
    expect(harness.result.current.isBusy).toBe(false);
    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('PORT_DISCONNECTED');
    }
    const assistant = harness.result.current.state.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.error?.code).toBe('PORT_DISCONNECTED');
  });

  it('watchdog first_byte 超时 → phase 切到 error（STREAM_TIMEOUT）', async () => {
    const harness = renderFollowupSession({
      firstByteTimeoutMs: 50,
      streamIdleTimeoutMs: 50,
      requestIdFactory: makeRequestIdFactory('req-wd'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    // 等真实定时器到期
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('STREAM_TIMEOUT');
    }
    expect(harness.result.current.isBusy).toBe(false);
  });

  it('watchdog stream_idle 超时：进入 streaming 后超过 streamIdleTimeoutMs 无新 chunk → STREAM_TIMEOUT', async () => {
    const harness = renderFollowupSession({
      firstByteTimeoutMs: 5_000,
      streamIdleTimeoutMs: 50,
      requestIdFactory: makeRequestIdFactory('req-idle'),
    });
    act(() => {
      harness.result.current.submitQuestion('问题');
    });
    const ask = getAskPayload(harness.port);
    // 先收一段 CHUNK：phase=streaming + lastChunkAt 写入
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: ask.requestId,
        text: '开头一段',
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('streaming');
    // 等 stream_idle (50ms) 超时
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    });
    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('STREAM_TIMEOUT');
    }
    expect(harness.result.current.isBusy).toBe(false);
  });
});

describe('useFollowupSession 旧 requestId 消息守卫（SG-04 QA2）', () => {
  /** helper：从 mock.calls 按索引提取第 n 个 ASK_VIDEO_QUESTION 的 requestId */
  function getAskRequestIdAt(port: FakePort, index: number): string {
    const askPayloads = port.postMessage.mock.calls
      .map((c) => c[0])
      .filter(
        (m): m is { type: string; requestId: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'ASK_VIDEO_QUESTION',
      );
    if (index >= askPayloads.length) {
      throw new Error(`ASK_VIDEO_QUESTION 在索引 ${index} 不存在（总数 ${askPayloads.length}）`);
    }
    return askPayloads[index]?.requestId ?? '';
  }

  it('contextKey 切换并发起新请求后，旧 DONE 不会清掉新请求的 activeRequestId；再次提交 retry 时 CANCEL 用新请求的 requestId', () => {
    const harness = renderFollowupSession({
      requestIdFactory: makeRequestIdFactory('req'),
    });
    // 第一个 session
    act(() => {
      harness.result.current.submitQuestion('第一个视频');
    });
    expect(getAskRequestIdAt(harness.port, 0)).toBe('req-1');
    const firstRequestId = 'req-1';

    // 切 contextKey + 提交新问题
    act(() => {
      harness.rerender({ contextKey: 'ctx-2' });
    });
    act(() => {
      harness.result.current.submitQuestion('第二个视频');
    });
    expect(getAskRequestIdAt(harness.port, 1)).toBe('req-2');

    // 新 session 是 loading
    expect(harness.result.current.state.phase.kind).toBe('loading');

    // 旧 DONE 到达 → 必须被 handleMessage 守卫拦截，**不**清新请求的 activeRequestId
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_DONE',
        requestId: firstRequestId,
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('loading');

    // 第三次提交（retry 路径）：CANCEL 必须用新请求 requestId (= req-2)，
    // 不能因为旧 DONE 被错误地清成 null 后错误地用 req-1 / 错值。
    act(() => {
      harness.result.current.submitQuestion('第三个视频');
    });
    const cancelCalls = harness.port.postMessage.mock.calls
      .map((c) => c[0])
      .filter(
        (m): m is { type: string; requestId: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'CANCEL_VIDEO_QUESTION',
      );
    // 总 CANCEL 数 = 1：contextKey 切换不再取消旧 in-flight；
    // 只有第三次 submit retry 路径取消当前 session in-flight (req-2)。
    expect(cancelCalls.length).toBe(1);
    // 关键断言：retry 那条 CANCEL 必须是新请求 requestId (= req-2)，
    // 不是被旧 DONE 错误清掉的 null / 旧 requestId。
    expect(cancelCalls.at(-1)?.requestId).toBe('req-2');

    // 第三次 ASK 用下一个 requestId
    expect(getAskRequestIdAt(harness.port, 2)).toBe('req-3');
  });

  it('新请求进入 streaming 后插入旧 CHUNK：旧 CHUNK 不应重置新请求 stream-idle watchdog，按新请求最后有效 chunk 时间进入 STREAM_TIMEOUT', async () => {
    const harness = renderFollowupSession({
      firstByteTimeoutMs: 5_000,
      // 较宽的时间窗口，避免 jsdom + act 调度抖动误判
      streamIdleTimeoutMs: 80,
      requestIdFactory: makeRequestIdFactory('req'),
    });

    // 第一个 session
    act(() => {
      harness.result.current.submitQuestion('第一个视频');
    });
    const firstRequestId = 'req-1';

    // 切 contextKey + 提交新问题
    act(() => {
      harness.rerender({ contextKey: 'ctx-2' });
    });
    act(() => {
      harness.result.current.submitQuestion('第二个视频');
    });
    const secondRequestId = 'req-2';

    // 新 session 收到第一个 CHUNK（T0 时刻，phase=streaming，lastChunkAt=T0）
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: secondRequestId,
        text: '新 chunk',
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('streaming');

    // 等 50ms，然后插入旧 CHUNK（T0+50ms 时刻）
    // 关键断言：守卫拦截后 lastChunkAt 仍是 T0，watchdog 在 T0+80ms = T0+50+30ms 触发
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    });
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstRequestId,
        text: '旧 chunk 不该重置 watchdog',
      });
    });

    // 再等 60ms（距新 chunk 共 110ms > 80ms，但 < 旧 chunk 重置后的 80+50=130ms）
    // 如果守卫失效（旧 chunk 重置 lastChunkAt=T0+50），watchdog 会在 T0+130ms 才触发，
    // 此时 phase 仍 streaming，断言会失败。
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
    });

    expect(harness.result.current.state.phase.kind).toBe('error');
    if (harness.result.current.state.phase.kind === 'error') {
      expect(harness.result.current.state.phase.code).toBe('STREAM_TIMEOUT');
    }
    expect(harness.result.current.isBusy).toBe(false);
  });
});

describe('useFollowupSession 输入区', () => {
  it('changeInputDraft 更新 inputDraft', () => {
    const harness = renderFollowupSession();
    act(() => {
      harness.result.current.changeInputDraft('草稿文本');
    });
    expect(harness.result.current.state.inputDraft).toBe('草稿文本');
  });
});

// 占位：阻止 unused 警告（BILIBILI_CTX 当前测例未直接用，但未来扩展需要）
void BILIBILI_CTX;
