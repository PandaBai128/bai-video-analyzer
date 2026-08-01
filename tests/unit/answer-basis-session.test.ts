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
 * useFollowupSession 回答依据 answerBasis 契约。
 *
 * 与 `use-followup-session.test.tsx` 拆开：本文件只覆盖本功能场景，避免把
 * answerBasis 堆进 938 行的综合 session 测试文件（按 AGENT_HANDOFF QA1 必修 4 §6）。
 * 共享 helper：FakePort / chrome.runtime stub / requestId 工厂走
 * tests/unit/helpers/followup-test-harness（不复制 mock 基础设施）。
 *
 * 关键不变量：
 * - 默认 answerBasis=video_only，submitQuestion 把当前 basis 快照写入 Port payload
 * - changeAnswerBasis 立刻更新 state + ref，下次 submitQuestion 拿新 basis（通识 / 联网）
 * - 流式期间 changeAnswerBasis 不影响已发送请求（snapshot 在 submit 瞬间）
 * - 新 contextKey 默认 answerBasis=video_only；切回已有 context 时恢复原选择
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
  const requestIdFactory = makeRequestIdFactory(options.requestIdFactoryPrefix ?? 'req-basis');
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

describe('useFollowupSession 回答依据 answerBasis', () => {
  afterEach(() => {
    uninstallChromePortStub();
    vi.restoreAllMocks();
  });

  it('默认 answerBasis=video_only；初次 submitQuestion 的 payload.answerBasis=video_only', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-basis-default' });
    expect(harness.result.current.answerBasis).toBe('video_only');
    act(() => {
      harness.result.current.submitQuestion('第一问');
    });
    expect(getAskPayload(harness.port).answerBasis).toBe('video_only');
  });

  it('changeAnswerBasis(\'video_plus_general\') 后 submitQuestion 的 payload.answerBasis=video_plus_general', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-basis-general' });
    act(() => {
      harness.result.current.changeAnswerBasis('video_plus_general');
    });
    expect(harness.result.current.answerBasis).toBe('video_plus_general');
    act(() => {
      harness.result.current.submitQuestion('通识补充问题');
    });
    expect(getAskPayload(harness.port).answerBasis).toBe('video_plus_general');
  });

  it('changeAnswerBasis(\'video_plus_web\') 后 submitQuestion 的 payload.answerBasis=video_plus_web', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-basis-web' });
    act(() => {
      harness.result.current.changeAnswerBasis('video_plus_web');
    });
    expect(harness.result.current.answerBasis).toBe('video_plus_web');
    act(() => {
      harness.result.current.submitQuestion('需要联网查证');
    });
    expect(getAskPayload(harness.port).answerBasis).toBe('video_plus_web');
  });

  it('流式期间 changeAnswerBasis 不影响已发送请求（快照在 submit 瞬间）', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-basis-snap' });
    // 第一次提交：默认 video_only
    act(() => {
      harness.result.current.submitQuestion('第一个问题');
    });
    const firstAsk = getAskPayload(harness.port);
    expect(firstAsk.answerBasis).toBe('video_only');

    // 流式到达 CHUNK（仍在 streaming）
    act(() => {
      harness.port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: firstAsk.requestId,
        text: '一段回答',
      });
    });
    expect(harness.result.current.state.phase.kind).toBe('streaming');

    // 流式期间切换依据 → 已发请求 payload.answerBasis 不变（snapshot 已经下发）
    act(() => {
      harness.result.current.changeAnswerBasis('video_plus_general');
    });
    expect(firstAsk.answerBasis).toBe('video_only');

    // 下一次提交：新 basis 生效
    act(() => {
      harness.port.emitMessage({ type: 'VIDEO_ANSWER_DONE', requestId: firstAsk.requestId });
    });
    act(() => {
      harness.result.current.submitQuestion('第二个问题');
    });
    const askCalls = harness.port.postMessage.mock.calls
      .map((c) => c[0])
      .filter(
        (m): m is { type: string; requestId: string; answerBasis?: string } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'ASK_VIDEO_QUESTION',
      );
    expect(askCalls.at(-1)?.answerBasis).toBe('video_plus_general');
  });

  it('新 contextKey 默认回到 video_only，切回旧 context 时恢复原选择', () => {
    const harness = renderHarness({ requestIdFactoryPrefix: 'req-basis-ctx' });
    // 切到通识
    act(() => {
      harness.result.current.changeAnswerBasis('video_plus_general');
    });
    expect(harness.result.current.answerBasis).toBe('video_plus_general');

    // 切 contextKey（模拟切视频 / 新 contentKey）→ 新 session 默认值
    harness.rerender({ contextKey: 'ctx-2' });
    expect(harness.result.current.answerBasis).toBe('video_only');

    // 提交 → 仍走 video_only（不能继承旧 ctx 的选择）
    act(() => {
      harness.result.current.submitQuestion('新视频的问题');
    });
    expect(getAskPayload(harness.port).answerBasis).toBe('video_only');

    // 切回旧 context → 恢复旧 context 的选择
    harness.rerender({ contextKey: 'ctx-1' });
    expect(harness.result.current.answerBasis).toBe('video_plus_general');
  });
});
