import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFollowupSession } from '@extension/sidepanel/followup/use-followup-session';
import {
  PLAYBACK,
  getAskPayload,
  installChromePortStub,
  makeRequestIdFactory,
  uninstallChromePortStub,
  type FakePort,
} from './helpers/followup-test-harness';

/**
 * useFollowupSession 对话历史 (conversationHistory) 契约（QA1 测试压缩版）。
 *
 * 覆盖 4 类关键行为（AGENT_HANDOFF §测试要求）：
 * - 首问没有历史 → payload.conversationHistory 缺失。
 * - 完成一轮后第二问 payload 携带最近 1 轮历史。
 * - streaming / error 的 assistant 不进入历史。
 * - 切 contextKey 后历史清空。
 *
 * 不引入 controller fixture；hook 端纯侧行为。
 */

interface RenderHarness {
  port: FakePort;
  result: {
    readonly current: ReturnType<typeof useFollowupSession>;
  };
  rerender: (next: { hasContentContext?: boolean; contextKey?: string }) => void;
}

function renderHarness(options: {
  readonly contextKey?: string;
  readonly requestIdFactoryPrefix?: string;
} = {}): RenderHarness {
  const port = installChromePortStub();
  const requestIdFactory = makeRequestIdFactory(options.requestIdFactoryPrefix ?? 'req-conv');
  const initialProps = {
    hasContentContext: true,
    playbackState: PLAYBACK,
    contextKey: options.contextKey ?? 'ctx-1',
    requestIdFactory,
  };
  let latest: { current: ReturnType<typeof useFollowupSession> } = {
    current: undefined as unknown as ReturnType<typeof useFollowupSession>,
  };
  const view = renderHook((props: typeof initialProps) => {
    const result = useFollowupSession(props);
    latest.current = result;
    return result;
  }, { initialProps });
  return {
    port,
    result: latest,
    rerender: (next) => {
      act(() => {
        view.rerender({
          ...initialProps,
          contextKey: next.contextKey ?? initialProps.contextKey,
          hasContentContext: next.hasContentContext ?? initialProps.hasContentContext,
        });
      });
    },
  };
}

/** helper: 取最后一次 ASK_VIDEO_QUESTION */
function lastAsk(port: FakePort): { type: string; conversationHistory?: unknown } | undefined {
  const asks = port.postMessage.mock.calls
    .map((c) => c[0])
    .filter(
      (m): m is { type: string; conversationHistory?: unknown } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'ASK_VIDEO_QUESTION',
    );
  return asks.at(-1);
}

describe('useFollowupSession 对话历史 conversationHistory (QA1 压缩 4 类关键行为)', () => {
  afterEach(() => {
    uninstallChromePortStub();
    vi.restoreAllMocks();
  });

  it('首问没有历史 → payload.conversationHistory 缺失（不发空数组，节省字节）', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-conv-1' });
    act(() => {
      harness.result.current.submitQuestion('第一个问题');
    });
    expect(getAskPayload(harness.port).conversationHistory).toBeUndefined();
  });

  it('完成一轮后，第二问 payload 携带最近 1 轮历史', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-conv-2' });
    act(() => {
      harness.result.current.submitQuestion('ChatGPT 的优势是什么？');
    });
    const firstAsk = getAskPayload(harness.port);
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstAsk.requestId,
        text: '优点：效率高',
      });
    });
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_DONE',
        requestId: firstAsk.requestId,
      });
    });
    act(() => {
      harness.result.current.submitQuestion('我问的是优点');
    });
    expect(lastAsk(harness.port)?.conversationHistory).toEqual([
      { role: 'user', content: 'ChatGPT 的优势是什么？' },
      { role: 'assistant', content: '优点：效率高' },
    ]);
  });

  it('streaming / error 的 assistant 不进入历史', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-conv-3' });
    // 第一轮 streaming 中（不 DONE）→ 第二问应无历史
    act(() => {
      harness.result.current.submitQuestion('第一问');
    });
    const firstAsk = getAskPayload(harness.port);
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstAsk.requestId,
        text: '半截',
      });
    });
    act(() => {
      harness.result.current.submitQuestion('第二问');
    });
    expect(lastAsk(harness.port)?.conversationHistory).toBeUndefined();

    // 改走 error 路径
    const harness2 = renderHarness({ requestIdFactoryPrefix: 'req-conv-3b' });
    act(() => {
      harness2.result.current.submitQuestion('第一问');
    });
    const firstAsk2 = getAskPayload(harness2.port);
    act(() => {
      harness2.port.emitMessage({
        type: 'VIDEO_ANSWER_ERROR',
        requestId: firstAsk2.requestId,
        code: 'STREAM_TIMEOUT',
        message: '超时',
      });
    });
    act(() => {
      harness2.result.current.submitQuestion('第二问');
    });
    expect(lastAsk(harness2.port)?.conversationHistory).toBeUndefined();
  });

  it('切 contextKey 后历史被清空，不跨视频串话', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-conv-4' });
    // 视频 1 完成一轮
    act(() => {
      harness.result.current.submitQuestion('视频 1 第一问');
    });
    const firstAsk = getAskPayload(harness.port);
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstAsk.requestId,
        text: '视频 1 回答',
      });
    });
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_DONE',
        requestId: firstAsk.requestId,
      });
    });
    // 切到视频 2
    harness.rerender({ contextKey: 'ctx-2' });
    act(() => {
      harness.result.current.submitQuestion('视频 2 第一问');
    });
    expect(lastAsk(harness.port)?.conversationHistory).toBeUndefined();
  });
});
