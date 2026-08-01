import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLearningSession } from '@extension/sidepanel/hooks/use-learning-session';
import type { LearningSession } from '@core/types';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';

const SESSION: LearningSession = {
  id: 'bilibili:BV1learn',
  schemaVersion: 3,
  platform: 'bilibili',
  videoId: 'BV1learn',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

function renderSession(input: {
  readonly contextKey?: string;
  readonly sendMessage?: (message: ExtensionRequest) => Promise<ExtensionResponse>;
} = {}) {
  const setStatus = vi.fn();
  const sendMessage =
    input.sendMessage ??
    vi.fn(async (_message: ExtensionRequest): Promise<ExtensionResponse> => ({
      ok: true,
      type: 'LEARNING_SESSION',
      payload: SESSION,
    }));
  const rendered = renderHook((props: { readonly contextKey: string }) =>
    useLearningSession({
      contextKey: props.contextKey,
      analysisMode: 'subtitle',
      setStatus,
      sendMessage,
    }), {
      initialProps: { contextKey: input.contextKey ?? 'bilibili:BV1learn' },
    },
  );
  return { ...rendered, setStatus, sendMessage };
}

describe('useLearningSession analysis RPC', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('挂载后读取学习会话', async () => {
    const h = renderSession();

    await waitFor(() => {
      expect(h.sendMessage).toHaveBeenCalledWith({ type: 'GET_LEARNING_SESSION' });
      expect(h.result.current.session).toEqual(SESSION);
    });
  });

  it('generateGuide 走 GENERATE_LEARNING_GUIDE RPC，并更新状态和 session', async () => {
    const sendMessage = vi.fn(async (message: ExtensionRequest): Promise<ExtensionResponse> => {
      if (message.type === 'GET_LEARNING_SESSION') {
        return { ok: true, type: 'LEARNING_SESSION', payload: null };
      }
      return { ok: true, type: 'LEARNING_SESSION', payload: SESSION };
    });
    const h = renderSession({ sendMessage });

    await act(async () => {
      await h.result.current.generateGuide(true);
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'GENERATE_LEARNING_GUIDE',
      payload: { forceRefresh: true, analysisMode: 'subtitle', outputLocale: 'zh-CN' },
    });
    expect(h.result.current.session).toEqual(SESSION);
    expect(h.result.current.isGeneratingGuide).toBe(false);
    expect(h.result.current.guideGenerationStartedAt).toBeNull();
    expect(h.result.current.guideGenerationStatus).toBe('');
    expect(h.setStatus).toHaveBeenCalledWith('正在生成视频分析...');
    expect(h.setStatus).toHaveBeenCalledWith('分析已生成');
  });

  it('分析 RPC 长时间不返回时本地超时退出，避免生成中卡死', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn((message: ExtensionRequest): Promise<ExtensionResponse> => {
      if (message.type === 'GET_LEARNING_SESSION') {
        return Promise.resolve({ ok: true, type: 'LEARNING_SESSION', payload: null });
      }
      return new Promise(() => undefined);
    });
    const h = renderSession({ sendMessage });
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'GET_LEARNING_SESSION' });

    act(() => {
      void h.result.current.generateGuide(true);
    });

    expect(h.result.current.isGeneratingGuide).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(180_000);
    });

    expect(h.result.current.isGeneratingGuide).toBe(false);
    expect(h.result.current.guideGenerationStartedAt).toBeNull();
    expect(h.result.current.guideGenerationStatus).toBe('');
    expect(h.setStatus).toHaveBeenCalledWith(
      '分析生成等待超时：当前请求长时间没有返回，可以重新开始。',
    );
  });

  it('用户停止分析后忽略迟到响应，并允许重新开始', async () => {
    let resolveGuide: ((response: ExtensionResponse) => void) | null = null;
    const sendMessage = vi.fn((message: ExtensionRequest): Promise<ExtensionResponse> => {
      if (message.type === 'GET_LEARNING_SESSION') {
        return Promise.resolve({ ok: true, type: 'LEARNING_SESSION', payload: null });
      }
      return new Promise((resolve) => {
        resolveGuide = resolve;
      });
    });
    const h = renderSession({ sendMessage });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'GET_LEARNING_SESSION' }));

    act(() => {
      void h.result.current.generateGuide(true);
    });
    expect(h.result.current.isGeneratingGuide).toBe(true);

    await act(async () => {
      h.result.current.cancelGuideGeneration();
    });

    expect(h.result.current.isGeneratingGuide).toBe(false);
    expect(h.setStatus).toHaveBeenCalledWith('已停止本次分析生成，可以重新开始');

    await act(async () => {
      resolveGuide?.({ ok: true, type: 'LEARNING_SESSION', payload: SESSION });
    });

    expect(h.result.current.session).toBeNull();

    act(() => {
      void h.result.current.generateGuide(true);
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(h.result.current.isGeneratingGuide).toBe(true);
  });

  it('生成中切换页面不取消旧请求；切回原页面仍显示生成中并接收结果', async () => {
    let resolveGuide: ((response: ExtensionResponse) => void) | null = null;
    const sendMessage = vi.fn((message: ExtensionRequest): Promise<ExtensionResponse> => {
      if (message.type === 'GET_LEARNING_SESSION') {
        return Promise.resolve({ ok: true, type: 'LEARNING_SESSION', payload: null });
      }
      return new Promise((resolve) => {
        resolveGuide = resolve;
      });
    });
    const h = renderSession({ sendMessage });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'GET_LEARNING_SESSION' }));

    act(() => {
      void h.result.current.generateGuide(true);
    });
    expect(h.result.current.isGeneratingGuide).toBe(true);

    h.rerender({ contextKey: 'bilibili:BV1other' });
    await act(async () => undefined);

    expect(h.result.current.isGeneratingGuide).toBe(false);
    expect(h.result.current.guideGenerationStartedAt).toBeNull();

    h.rerender({ contextKey: 'bilibili:BV1learn' });
    await act(async () => undefined);

    expect(h.result.current.isGeneratingGuide).toBe(true);

    await act(async () => {
      resolveGuide?.({ ok: true, type: 'LEARNING_SESSION', payload: SESSION });
    });

    expect(h.result.current.isGeneratingGuide).toBe(false);
    expect(h.result.current.session).toEqual(SESSION);
  });
});
