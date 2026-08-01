import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTimelineSession } from '@extension/sidepanel/hooks/use-timeline-session';
import type { VideoTimelinePortMessage } from '@shared/messages';
import type { AnalysisMode } from '@shared/settings';
import type {
  AnalysisDebug,
  AnalysisTiming,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  onDisconnect: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
  emitMessage: (message: VideoTimelinePortMessage) => void;
  emitDisconnect: () => void;
}

function makeFakePort(): FakePort {
  const port: FakePort = {
    name: 'video-timeline',
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn(),
    emitMessage: () => undefined,
    emitDisconnect: () => undefined,
  };
  let messageListener: ((raw: unknown) => void) | null = null;
  let disconnectListener: (() => void) | null = null;
  port.onMessage.addListener.mockImplementation((cb: (raw: unknown) => void) => {
    messageListener = cb;
  });
  port.onMessage.removeListener.mockImplementation((cb: (raw: unknown) => void) => {
    if (messageListener === cb) {
      messageListener = null;
    }
  });
  port.onDisconnect.addListener.mockImplementation((cb: () => void) => {
    disconnectListener = cb;
  });
  port.onDisconnect.removeListener.mockImplementation((cb: () => void) => {
    if (disconnectListener === cb) {
      disconnectListener = null;
    }
  });
  port.emitMessage = (message: VideoTimelinePortMessage): void => {
    if (messageListener) {
      messageListener(message);
    }
  };
  port.emitDisconnect = (): void => {
    if (disconnectListener) {
      disconnectListener();
    }
  };
  return port;
}

let fakePort: FakePort | null = null;

function installChromePortStub(): FakePort {
  fakePort = makeFakePort();
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn(() => fakePort),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
  });
  return fakePort;
}

function uninstallChromePortStub(): void {
  fakePort = null;
  vi.unstubAllGlobals();
}

const SAMPLE_METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  author: 'tester',
};

function makeAnalysisResult(): {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis;
  readonly subtitleCueCount: number;
  readonly timings: readonly AnalysisTiming[];
  readonly debug?: AnalysisDebug;
  readonly transcriptCues?: readonly SubtitleCue[];
} {
  const analysis: VideoAnalysis = {
    overview: '视频核心',
    watchStrategy: ['1'],
    coreTakeaways: ['要点'],
    reviewSummary: '复盘',
    chapters: [
      {
        timestamp: 0,
        title: '章 1',
        summary: '简介',
        importance: 'recommended',
        watchGuide: '看',
        segments: [],
      },
    ],
    timeline: [
      { timestamp: 30, title: '小节 A', summary: 'A', importance: 'recommended' },
    ],
    quotes: [],
    keyConcepts: [],
    inspirations: [],
    generatedAt: 0,
    modelUsed: 'm',
    sourceMode: 'subtitle',
  };
  return {
    metadata: SAMPLE_METADATA,
    analysis,
    subtitleCueCount: 0,
    timings: [],
  };
}

function makeEmptyAnalysisResult(): ReturnType<typeof makeAnalysisResult> {
  const result = makeAnalysisResult();
  return {
    ...result,
    analysis: {
      ...result.analysis,
      chapters: [],
      timeline: [],
    },
  };
}

interface HarnessOptions {
  readonly contentIdentity?: string | null;
  readonly analysisMode?: AnalysisMode;
  readonly outputLocale?: 'zh-CN' | 'en-US';
  readonly analysisResult?: ReturnType<typeof makeAnalysisResult> | null;
  readonly generateRequestId?: () => string;
  readonly sendMessage?: ReturnType<typeof vi.fn>;
  readonly connectPort?: () => chrome.runtime.Port | null;
}

interface Harness {
  readonly port: FakePort | null;
  readonly controls: {
    readonly setStatus: ReturnType<typeof vi.fn>;
    readonly setIsAnalyzing: ReturnType<typeof vi.fn>;
    readonly setAnalysisResult: ReturnType<typeof vi.fn>;
    readonly setSelectedTimestamp: ReturnType<typeof vi.fn>;
    readonly setExpandedChapterIndex: ReturnType<typeof vi.fn>;
    readonly setAnalysisTab: ReturnType<typeof vi.fn>;
    readonly loadLearningSession: ReturnType<typeof vi.fn>;
  };
  readonly rerender: (next?: Partial<HarnessOptions>) => void;
  readonly result: { current: ReturnType<typeof useTimelineSession> };
  readonly unmount: () => void;
}

function renderTimelineSession(options: HarnessOptions = {}): Harness {
  const controls = {
    setStatus: vi.fn(),
    setIsAnalyzing: vi.fn(),
    setAnalysisResult: vi.fn(),
    setSelectedTimestamp: vi.fn(),
    setExpandedChapterIndex: vi.fn(),
    setAnalysisTab: vi.fn(),
    loadLearningSession: vi.fn().mockResolvedValue(undefined),
  };
  const providedSend = options.sendMessage;
  const sendMessage = providedSend ?? vi.fn();

  // 默认用 chrome 桩；用户给 connectPort 时改用真实 connectPort 注入
  const port = options.connectPort ? null : installChromePortStub();
  if (!options.connectPort && !port) {
    throw new Error('chrome stub install failed');
  }

  const buildProps = (override?: Partial<HarnessOptions>): Parameters<typeof useTimelineSession>[0] => ({
    contentIdentity:
      override?.contentIdentity !== undefined
        ? override.contentIdentity
        : options.contentIdentity ?? 'bilibili:BV1xx',
    analysisMode: override?.analysisMode ?? options.analysisMode ?? 'subtitle',
    outputLocale: override?.outputLocale ?? options.outputLocale ?? 'zh-CN',
    analysisResult:
      override?.analysisResult !== undefined
        ? override.analysisResult
        : options.analysisResult ?? null,
    setStatus: controls.setStatus,
    setIsAnalyzing: controls.setIsAnalyzing,
    setAnalysisResult: controls.setAnalysisResult,
    setSelectedTimestamp: controls.setSelectedTimestamp,
    setExpandedChapterIndex: controls.setExpandedChapterIndex,
    setAnalysisTab: controls.setAnalysisTab,
    loadLearningSession: controls.loadLearningSession,
    ...(options.connectPort ? { connectPort: options.connectPort } : {}),
    sendMessage,
    ...(options.generateRequestId
      ? { generateRequestId: options.generateRequestId }
      : {}),
  });

  const rendered = renderHook(
    (props: Parameters<typeof useTimelineSession>[0]): ReturnType<typeof useTimelineSession> =>
      useTimelineSession(props),
    { initialProps: buildProps() },
  );

  return {
    port,
    controls,
    result: rendered.result,
    rerender: (next) => {
      rendered.rerender(buildProps(next));
    },
    unmount: rendered.unmount,
  };
}

async function callRequest(
  h: Harness,
  options?: { forceRefresh?: boolean; stayOnCurrentTab?: boolean },
): Promise<void> {
  await act(async () => {
    await h.result.current.requestTimeline(options ?? {});
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  uninstallChromePortStub();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 必修 A：Port mount / unmount 生命周期
// ---------------------------------------------------------------------------

describe('useTimelineSession (SG-03A: 时间线会话 hook)', () => {
  it('A1: mount 只连接一次 Port + 注册 listener；unmount 移除 listener 并 disconnect', () => {
    const h = renderTimelineSession();
    expect(h.port).not.toBeNull();
    expect(h.port!.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(h.port!.onDisconnect.addListener).toHaveBeenCalledTimes(1);

    act(() => {
      h.unmount();
    });
    expect(h.port!.onMessage.removeListener).toHaveBeenCalledTimes(1);
    expect(h.port!.onDisconnect.removeListener).toHaveBeenCalledTimes(1);
    expect(h.port!.disconnect).toHaveBeenCalledTimes(1);
  });

  it('A2: connectPort 返回 null 时 hook 不报错，初始 state 干净', () => {
    const connectPort = vi.fn(() => null);
    const h = renderTimelineSession({ connectPort });
    expect(h.result.current.isTimelineStreaming).toBe(false);
    expect(h.result.current.streamingStatus).toBe('');
    expect(h.result.current.streamingChaptersDraft).toEqual([]);
    act(() => {
      h.unmount();
    });
  });

  // ---------------------------------------------------------------------------
  // 必修 B：subtitle 模式发流式请求；连续请求先取消旧 requestId
  // ---------------------------------------------------------------------------

  it('B1: subtitle 模式 requestTimeline 发 REQUEST_VIDEO_TIMELINE（analysisMode=subtitle, forceRefresh）', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1' });

    await callRequest(h, { forceRefresh: false });

    expect(h.port!.postMessage).toHaveBeenCalledTimes(1);
    const sent = h.port!.postMessage.mock.calls[0]?.[0] as VideoTimelinePortMessage;
    expect(sent).toMatchObject({
      type: 'REQUEST_VIDEO_TIMELINE',
      requestId: 'rid-1',
      analysisMode: 'subtitle',
      forceRefresh: false,
    });
  });

  it('B2: 连续两次 requestTimeline 先发 CANCEL_VIDEO_TIMELINE(旧 requestId) 再发新 REQUEST_VIDEO_TIMELINE', async () => {
    let counter = 0;
    const h = renderTimelineSession({
      generateRequestId: () => {
        counter += 1;
        return `rid-${counter}`;
      },
    });

    await callRequest(h, { forceRefresh: false });
    // 第一次：activeRequestId 为空 → 跳过 cancel → 直接 REQUEST_VIDEO_TIMELINE
    expect(h.port!.postMessage).toHaveBeenCalledTimes(1);
    const firstReq = h.port!.postMessage.mock.calls[0]?.[0] as VideoTimelinePortMessage;
    expect(firstReq).toMatchObject({ type: 'REQUEST_VIDEO_TIMELINE', requestId: 'rid-1' });

    await callRequest(h, { forceRefresh: true });
    // 第二次：先 CANCEL 旧 requestId，再 REQUEST_VIDEO_TIMELINE（新 id）
    expect(h.port!.postMessage).toHaveBeenCalledTimes(3);
    const cancel = h.port!.postMessage.mock.calls[1]?.[0] as VideoTimelinePortMessage;
    const secondReq = h.port!.postMessage.mock.calls[2]?.[0] as VideoTimelinePortMessage;
    expect(cancel).toMatchObject({ type: 'CANCEL_VIDEO_TIMELINE', requestId: 'rid-1' });
    expect(secondReq).toMatchObject({
      type: 'REQUEST_VIDEO_TIMELINE',
      requestId: 'rid-2',
      forceRefresh: true,
    });
  });

  it('B3: 切到另一个视频只隐藏旧请求，切回原视频恢复流式草稿', async () => {
    const h = renderTimelineSession({
      contentIdentity: 'bilibili:BV-old',
      generateRequestId: () => 'rid-old',
    });
    await callRequest(h);

    act(() => {
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_PARTIAL',
        requestId: 'rid-old',
        event: { type: 'overview', text: '旧视频生成中' },
        rawLine: '{"type":"overview","text":"旧视频生成中"}',
      });
    });
    expect(h.result.current.isTimelineStreaming).toBe(true);
    expect(h.result.current.streamingOverviewDraft).toBe('旧视频生成中');

    act(() => {
      h.rerender({ contentIdentity: 'bilibili:BV-new' });
    });

    expect(h.port!.postMessage).toHaveBeenCalledTimes(1);
    expect(h.result.current.isTimelineStreaming).toBe(false);
    expect(h.result.current.streamingOverviewDraft).toBeNull();
    expect(h.result.current.streamingChaptersDraft).toEqual([]);

    h.controls.setStatus.mockClear();
    act(() => {
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_STATUS',
        requestId: 'rid-old',
        text: '旧视频还在生成',
      });
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_PARTIAL',
        requestId: 'rid-old',
        event: { type: 'overview', text: '旧视频继续生成' },
        rawLine: '{"type":"overview","text":"旧视频继续生成"}',
      });
    });
    expect(h.controls.setStatus).not.toHaveBeenCalledWith('旧视频还在生成');
    expect(h.result.current.isTimelineStreaming).toBe(false);
    expect(h.result.current.streamingOverviewDraft).toBeNull();

    act(() => {
      h.rerender({ contentIdentity: 'bilibili:BV-old' });
    });

    expect(h.result.current.isTimelineStreaming).toBe(true);
    expect(h.result.current.streamingOverviewDraft).toBe('旧视频继续生成');
    expect(h.result.current.streamingStatus).toBe('旧视频还在生成');
    expect(h.controls.setStatus).toHaveBeenCalledWith('旧视频还在生成');
  });

  it('B4: 在新视频主动发起生成时才取消旧请求', async () => {
    let counter = 0;
    const h = renderTimelineSession({
      contentIdentity: 'bilibili:BV-old',
      generateRequestId: () => {
        counter += 1;
        return `rid-${counter}`;
      },
    });

    await callRequest(h);
    act(() => {
      h.rerender({ contentIdentity: 'bilibili:BV-new' });
    });
    await callRequest(h, { forceRefresh: true });

    expect(h.port!.postMessage).toHaveBeenCalledTimes(3);
    const cancel = h.port!.postMessage.mock.calls[1]?.[0] as VideoTimelinePortMessage;
    const nextRequest = h.port!.postMessage.mock.calls[2]?.[0] as VideoTimelinePortMessage;
    expect(cancel).toMatchObject({ type: 'CANCEL_VIDEO_TIMELINE', requestId: 'rid-1' });
    expect(nextRequest).toMatchObject({
      type: 'REQUEST_VIDEO_TIMELINE',
      requestId: 'rid-2',
      forceRefresh: true,
    });
  });

  it('B5: 用户主动停止当前导航生成时发 CANCEL 并释放流式状态', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-stop' });
    await callRequest(h);
    expect(h.result.current.isTimelineStreaming).toBe(true);

    act(() => {
      h.result.current.cancelTimeline();
    });

    expect(h.port!.postMessage).toHaveBeenCalledTimes(2);
    const cancel = h.port!.postMessage.mock.calls[1]?.[0] as VideoTimelinePortMessage;
    expect(cancel).toMatchObject({ type: 'CANCEL_VIDEO_TIMELINE', requestId: 'rid-stop' });
    expect(h.result.current.isTimelineStreaming).toBe(false);
    expect(h.result.current.streamingStatus).toBe('');
    expect(h.controls.setStatus).toHaveBeenCalledWith('已停止导航生成，可以重新开始');
  });

  // ---------------------------------------------------------------------------
  // 必修 C：忽略非当前 requestId 的响应
  // ---------------------------------------------------------------------------

  it('C1: 旧 requestId 的 STATUS / PARTIAL / DONE 全部被忽略', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1' });
    await callRequest(h);

    act(() => {
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_STATUS',
        requestId: 'stale',
        text: '旧 STATUS 应被忽略',
      });
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_PARTIAL',
        requestId: 'stale',
        event: { type: 'overview', text: '旧 overview' },
        rawLine: '{"type":"overview","text":"旧 overview"}',
      });
      h.port!.emitMessage({ type: 'VIDEO_TIMELINE_DONE', requestId: 'stale' });
    });

    // 旧 requestId 消息不触发任何 setStatus（因为 STATUS 不会写 setStatus）
    // 但 PARTIAL/DONE 应不触发 setAnalysisResult
    expect(h.controls.setAnalysisResult).not.toHaveBeenCalled();
    // 旧 STALE STATUS 不应该 setStatus 收到 "旧 STATUS 应被忽略"
    const staleStatusCalls = h.controls.setStatus.mock.calls.filter(
      (call) => call[0] === '旧 STATUS 应被忽略',
    );
    expect(staleStatusCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 必修 D：partial 事件正确累积 overview / chapter / segment
  // ---------------------------------------------------------------------------

  it('D1: overview / chapter / segment partial 累积到 streamingOverviewDraft / streamingChaptersDraft', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1' });
    await callRequest(h);

    act(() => {
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_PARTIAL',
        requestId: 'rid-1',
        event: { type: 'overview', text: '视频核心简介' },
        rawLine: '{"type":"overview","text":"视频核心简介"}',
      });
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_PARTIAL',
        requestId: 'rid-1',
        event: {
          type: 'chapter',
          id: 'c1',
          startCueId: 0,
          endCueId: 1,
          title: '章 1',
          summary: '简介',
        },
        rawLine: '{"type":"chapter","id":"c1"}',
      });
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_PARTIAL',
        requestId: 'rid-1',
        event: {
          type: 'segment',
          chapterId: 'c1',
          startCueId: 0,
          endCueId: 1,
          title: '段 1',
          summary: 'A',
        },
        rawLine: '{"type":"segment","chapterId":"c1"}',
      });
    });

    const chapters = h.result.current.streamingChaptersDraft;
    expect(h.result.current.streamingOverviewDraft).toBe('视频核心简介');
    expect(chapters.length).toBe(1);
    expect(chapters[0]?.id).toBe('c1');
    expect(chapters[0]?.title).toBe('章 1');
    expect(chapters[0]?.segments.length).toBe(1);
    expect(chapters[0]?.segments[0]?.title).toBe('段 1');
  });

  // ---------------------------------------------------------------------------
  // 必修 E：DONE 读缓存 + 回调写入结果 + 清空流式状态 + 触发 loadLearningSession
  // ---------------------------------------------------------------------------

  it('E1: DONE 触发 GET_CACHED_ANALYSIS → setAnalysisResult + setSelectedTimestamp + setExpandedChapterIndex(0) + loadLearningSession', async () => {
    const cached = makeAnalysisResult();
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      type: 'CACHED_ANALYSIS',
      payload: cached,
    });
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1', sendMessage });

    await callRequest(h);

    await act(async () => {
      h.port!.emitMessage({ type: 'VIDEO_TIMELINE_DONE', requestId: 'rid-1' });
      // 让 DONE 内的 async 链完成
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'GET_CACHED_ANALYSIS',
      payload: { analysisMode: 'subtitle', outputLocale: 'zh-CN' },
    });
    expect(h.controls.setAnalysisResult).toHaveBeenCalledWith(cached);
    expect(h.controls.setSelectedTimestamp).toHaveBeenCalledWith(null);
    expect(h.controls.setExpandedChapterIndex).toHaveBeenCalledWith(0);
    expect(h.controls.loadLearningSession).toHaveBeenCalledTimes(1);
    expect(h.controls.setStatus).toHaveBeenCalledWith('导航已生成');
  });

  it('E1b: DONE 前 UI 语言变化时，仍按请求发起时的 outputLocale 读取缓存', async () => {
    const cached = makeAnalysisResult();
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      type: 'CACHED_ANALYSIS',
      payload: cached,
    });
    const h = renderTimelineSession({
      generateRequestId: () => 'rid-en',
      outputLocale: 'en-US',
      sendMessage,
    });

    await callRequest(h);
    act(() => {
      h.rerender({ outputLocale: 'zh-CN' });
    });

    await act(async () => {
      h.port!.emitMessage({ type: 'VIDEO_TIMELINE_DONE', requestId: 'rid-en' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'GET_CACHED_ANALYSIS',
      payload: { analysisMode: 'subtitle', outputLocale: 'en-US' },
    });
    expect(h.controls.setAnalysisResult).toHaveBeenCalledWith(cached);
  });

  it('E2: DONE 后缓存读取失败 → 不再假提示“时间线已生成”', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'X', message: 'no cache' },
    });
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1', sendMessage });
    await callRequest(h);

    await act(async () => {
      h.port!.emitMessage({ type: 'VIDEO_TIMELINE_DONE', requestId: 'rid-1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.controls.setStatus).toHaveBeenCalledWith(
      '导航生成结束，但没有读到有效结果，请重新生成。',
    );
    expect(h.controls.setAnalysisResult).not.toHaveBeenCalled();
    expect(h.controls.loadLearningSession).not.toHaveBeenCalled();
    expect(h.result.current.isTimelineStreaming).toBe(false);
  });

  it('E2b: DONE 后缓存为空时间线 → 不写入空结果', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      type: 'CACHED_ANALYSIS',
      payload: makeEmptyAnalysisResult(),
    });
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1', sendMessage });
    await callRequest(h);

    await act(async () => {
      h.port!.emitMessage({ type: 'VIDEO_TIMELINE_DONE', requestId: 'rid-1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.controls.setStatus).toHaveBeenCalledWith(
      '导航生成结束，但没有读到有效结果，请重新生成。',
    );
    expect(h.controls.setAnalysisResult).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 必修 F：ERROR + disconnect + 通道未建立 → 正确 reset
  // ---------------------------------------------------------------------------

  it('F1: VIDEO_TIMELINE_ERROR 把 message 写 setStatus + setIsAnalyzing(false)', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1' });
    await callRequest(h);

    act(() => {
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_ERROR',
        requestId: 'rid-1',
        code: 'E',
        message: '字幕不可用',
      });
    });

    expect(h.controls.setStatus).toHaveBeenCalledWith('字幕不可用');
    expect(h.controls.setIsAnalyzing).toHaveBeenCalledWith(false);
  });

  it('F2: 活动请求期间 disconnect：写"连接已断开" + setIsAnalyzing(false)', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1' });
    await callRequest(h);

    act(() => {
      h.port!.emitDisconnect();
    });

    expect(h.controls.setStatus).toHaveBeenCalledWith('连接已断开');
    expect(h.controls.setIsAnalyzing).toHaveBeenCalledWith(false);
  });

  it('F3: idle（无活动 requestId）时 disconnect **不**写"连接已断开"', () => {
    const h = renderTimelineSession();
    // 没发起过 requestTimeline → active requestId 为空
    act(() => {
      h.port!.emitDisconnect();
    });
    const statusCalls = h.controls.setStatus.mock.calls.filter(
      (call) => call[0] === '连接已断开',
    );
    expect(statusCalls).toHaveLength(0);
  });

  it('F4: 通道未建立时 requestTimeline 报"导航通道未建立，请重开侧边栏" + 不发请求', async () => {
    const connectPort = vi.fn(() => null);
    const sendMessage = vi.fn();
    const h = renderTimelineSession({ connectPort, sendMessage });

    await callRequest(h, { forceRefresh: false });

    expect(connectPort).toHaveBeenCalled();
    expect(h.controls.setStatus).toHaveBeenCalledWith('导航通道未建立，请重开侧边栏');
    expect(h.controls.setIsAnalyzing).toHaveBeenCalledWith(false);
    // Port 没发任何消息；sendMessage 也没被 requestTimeline 调用
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 必修 H：subtitle forceRefresh + 现有结果 → "替换"文案
  // ---------------------------------------------------------------------------

  it('H1: subtitle forceRefresh + 已有 analysisResult → status "新结果将替换当前导航"', async () => {
    const existing = makeAnalysisResult();
    const h = renderTimelineSession({
      analysisMode: 'subtitle',
      analysisResult: existing,
    });

    await callRequest(h, { forceRefresh: true });

    expect(h.controls.setStatus).toHaveBeenCalledWith(
      '正在重新生成导航，新结果将替换当前导航',
    );
  });

  it('H2: subtitle forceRefresh + 无 analysisResult → status "正在重新生成导航..."（无"替换"字样）', async () => {
    const h = renderTimelineSession({ analysisMode: 'subtitle', analysisResult: null });

    await callRequest(h, { forceRefresh: true });

    expect(h.controls.setStatus).toHaveBeenCalledWith('正在重新生成导航...');
    const replaceCalls = h.controls.setStatus.mock.calls.filter((c) =>
      String(c[0] ?? '').includes('新结果将替换当前导航'),
    );
    expect(replaceCalls).toHaveLength(0);
  });

  it('H3: subtitle 普通请求（无 forceRefresh）→ status "正在读取视频信息..."', async () => {
    const h = renderTimelineSession({ analysisMode: 'subtitle' });

    await callRequest(h);

    expect(h.controls.setStatus).toHaveBeenCalledWith('正在读取视频信息...');
  });

  // ---------------------------------------------------------------------------
  // 必修 I：流式 status 正确穿透
  // ---------------------------------------------------------------------------

  it('I1: VIDEO_TIMELINE_STATUS 把 text 写 setStatus + hook streamingStatus', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1' });
    await callRequest(h);

    act(() => {
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_STATUS',
        requestId: 'rid-1',
        text: '正在识别时间线',
      });
    });

    expect(h.controls.setStatus).toHaveBeenCalledWith('正在识别时间线');
    expect(h.result.current.streamingStatus).toBe('正在识别时间线');
  });

  it('I2: VIDEO_TIMELINE_CHUNK **不**写默认 UI state（不调 setStatus）', async () => {
    const h = renderTimelineSession({ generateRequestId: () => 'rid-1' });
    await callRequest(h);
    // 清掉 requestTimeline 内部的 setStatus 调用，只关注 CHUNK 自身的副作用
    h.controls.setStatus.mockClear();

    act(() => {
      h.port!.emitMessage({
        type: 'VIDEO_TIMELINE_CHUNK',
        requestId: 'rid-1',
        text: 'some raw chunk',
      });
    });

    // CHUNK 不应触发任何 setStatus
    expect(h.controls.setStatus).not.toHaveBeenCalled();
  });
});
