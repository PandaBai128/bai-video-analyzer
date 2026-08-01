import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePageSession } from '@extension/sidepanel/hooks/use-page-session';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { AnalysisMode } from '@shared/settings';
import type { PageContext } from '@shared/page-context';
import type { PlaybackState } from '@shared/playback-state';
import type { TimelineSessionAnalysisResult } from '@extension/sidepanel/hooks/use-timeline-session';
import type { UiLocale } from '@shared/locale-settings';

const SAMPLE_CONTEXT: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  detectedAt: 1_700_000_000_000,
};

const UNSUPPORTED_CONTEXT: PageContext = {
  platform: 'unknown',
  url: 'https://example.com/video',
  title: '未知页面',
  detectedAt: 1_700_000_000_000,
};

function makeTextProviderSettingsPayload(analysisMode: AnalysisMode): {
  readonly analysisMode: AnalysisMode;
  readonly hasApiKey: true;
  readonly baseUrl: string;
  readonly model: string;
  readonly fastModel: 'MiniMax-M3';
  readonly thinkingMode: 'enabled';
  readonly webSearchEnabled: false;
} {
  return {
    analysisMode,
    hasApiKey: true,
    baseUrl: 'https://example.com',
    model: 'm',
    fastModel: 'MiniMax-M3',
    thinkingMode: 'enabled',
    webSearchEnabled: false,
  };
}

function makeAnalysisResult(): TimelineSessionAnalysisResult {
  return {
    metadata: {
      platform: 'bilibili',
      videoId: 'BV1xx',
      url: 'https://www.bilibili.com/video/BV1xx',
      title: '测试视频',
      author: 'tester',
    },
    analysis: {
      overview: '视频核心',
      watchStrategy: [],
      coreTakeaways: [],
      reviewSummary: '',
      chapters: [
        { timestamp: 0, title: '章 1', summary: '简介', importance: 'recommended', watchGuide: '看', segments: [] },
      ],
      timeline: [{ timestamp: 30, title: 'A', summary: 'A', importance: 'recommended' }],
      quotes: [],
      keyConcepts: [],
      inspirations: [],
      generatedAt: 0,
      modelUsed: 'm',
      sourceMode: 'subtitle',
    },
    subtitleCueCount: 0,
    timings: [],
  };
}

interface ScenarioOptions {
  readonly settings?: AnalysisMode | 'fail';
  readonly page?: PageContext | null;
  readonly cache?: TimelineSessionAnalysisResult | 'miss';
  readonly playback?: PlaybackState | 'miss';
}

function ok(type: string, payload: unknown): ExtensionResponse {
  return { ok: true, type, payload } as ExtensionResponse;
}

function fail(message: string): ExtensionResponse {
  return { ok: false, error: { code: 'X', message } };
}

/** 构造 sendMessage mock：默认 settings=subtitle / page=SAMPLE_CONTEXT / cache=miss / playback=miss。 */
function makeScenarioSend(opts: ScenarioOptions = {}): ReturnType<typeof vi.fn> {
  const settingsMode = opts.settings ?? 'subtitle';
  const page = opts.page === undefined ? SAMPLE_CONTEXT : opts.page;
  const cache = opts.cache ?? 'miss';
  const playback = opts.playback ?? 'miss';
  return vi.fn((message: ExtensionRequest): Promise<ExtensionResponse> => {
    switch (message.type) {
      case 'GET_TEXT_PROVIDER_SETTINGS':
        return Promise.resolve(
          settingsMode === 'fail'
            ? fail('no settings')
            : ok('TEXT_PROVIDER_SETTINGS', makeTextProviderSettingsPayload(settingsMode)),
        );
      case 'GET_CURRENT_PAGE':
        return Promise.resolve(ok('PAGE_CONTEXT', page));
      case 'GET_CACHED_ANALYSIS':
        return Promise.resolve(cache === 'miss' ? fail('no cache') : ok('CACHED_ANALYSIS', cache));
      case 'GET_CACHED_CONTENT_CONTEXT':
        return Promise.resolve(fail('no cc'));
      case 'GET_PLAYBACK_STATE':
        return Promise.resolve(playback === 'miss' ? fail('no playback') : ok('PLAYBACK_STATE', playback));
      default:
        return Promise.resolve(fail('unhandled'));
    }
  });
}

/** 跑 n 轮 microtask flush，让 mount init / 异步回调链完成。 */
async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

const callTypes = (sendMessage: ReturnType<typeof vi.fn>): ExtensionRequest['type'][] =>
  sendMessage.mock.calls.map((c) => (c[0] as ExtensionRequest).type);

interface TabChangeInfo {
  url?: string;
  title?: string;
  status?: string;
}

interface TabEventsController {
  fireTabActivated: () => void;
  fireTabUpdated: (tabId: number, changeInfo: TabChangeInfo) => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

interface PageDetectedController {
  firePageDetected: () => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  readonly initialAnalysisMode?: AnalysisMode;
  readonly outputLocale?: UiLocale;
  readonly sendMessage?: ReturnType<typeof vi.fn>;
  readonly now?: () => number;
}

interface Harness {
  readonly result: { current: ReturnType<typeof usePageSession> };
  readonly controls: {
    readonly setStatus: ReturnType<typeof vi.fn>;
    readonly onPageReset: ReturnType<typeof vi.fn>;
    readonly onAnalysisCacheResolved: ReturnType<typeof vi.fn>;
    readonly onLoadLearningSession: ReturnType<typeof vi.fn>;
    readonly onRestoreContentContext: ReturnType<typeof vi.fn>;
  };
  readonly sendMessage: ReturnType<typeof vi.fn>;
  readonly tabController: TabEventsController;
  readonly pageDetectedController: PageDetectedController;
  readonly rerender: (props?: { readonly outputLocale: UiLocale | undefined }) => void;
  readonly unmount: () => void;
}

function renderPageSession(options: HarnessOptions = {}): Harness {
  const controls = {
    setStatus: vi.fn(),
    onPageReset: vi.fn(),
    onAnalysisCacheResolved: vi.fn(),
    onLoadLearningSession: vi.fn().mockResolvedValue(undefined),
    onRestoreContentContext: vi.fn().mockResolvedValue(undefined),
  };
  // 默认 sendMessage mock：所有消息返回 ok:false，避免 hook 访问 undefined.ok 报错。
  const sendMessage = options.sendMessage ?? vi.fn().mockResolvedValue(fail('no mock'));

  let currentTabHandlers: Parameters<NonNullable<Parameters<typeof usePageSession>[0]['subscribeTabEvents']>>[0] | null = null;
  let currentPageDetected: (() => void) | null = null;
  const tabUnsubscribe = vi.fn();
  const pageDetectedUnsubscribe = vi.fn();

  const tabController: TabEventsController = {
    fireTabActivated: (): void => {
      currentTabHandlers?.onTabActivated();
    },
    fireTabUpdated: (tabId, changeInfo): void => {
      currentTabHandlers?.onTabUpdated(tabId, changeInfo, { id: tabId } as unknown as chrome.tabs.Tab);
    },
    unsubscribe: tabUnsubscribe,
  };
  const pageDetectedController: PageDetectedController = {
    firePageDetected: (): void => {
      currentPageDetected?.();
    },
    unsubscribe: pageDetectedUnsubscribe,
  };

  const subscribeTabEvents: NonNullable<Parameters<typeof usePageSession>[0]['subscribeTabEvents']> = (handlers) => {
    currentTabHandlers = handlers;
    return () => {
      if (currentTabHandlers === handlers) currentTabHandlers = null;
      tabUnsubscribe();
    };
  };
  const subscribePageDetected: NonNullable<Parameters<typeof usePageSession>[0]['subscribePageDetected']> = (handler) => {
    currentPageDetected = handler;
    return () => {
      if (currentPageDetected === handler) currentPageDetected = null;
      pageDetectedUnsubscribe();
    };
  };

  const baseProps: Parameters<typeof usePageSession>[0] = {
    setStatus: controls.setStatus,
    onPageReset: controls.onPageReset,
    onAnalysisCacheResolved: controls.onAnalysisCacheResolved,
    onLoadLearningSession: controls.onLoadLearningSession,
    onRestoreContentContext: controls.onRestoreContentContext,
    ...(options.initialAnalysisMode !== undefined ? { initialAnalysisMode: options.initialAnalysisMode } : {}),
    sendMessage,
    subscribeTabEvents,
    subscribePageDetected,
    ...(options.now ? { now: options.now } : {}),
  };

  const rendered = renderHook(
    (props: { readonly outputLocale: UiLocale | undefined }) =>
      usePageSession({
        ...baseProps,
        ...(props.outputLocale ? { outputLocale: props.outputLocale } : {}),
      }),
    { initialProps: { outputLocale: options.outputLocale } },
  );
  return {
    result: rendered.result,
    controls,
    sendMessage,
    tabController,
    pageDetectedController,
    rerender: rendered.rerender,
    unmount: rendered.unmount,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePageSession (SG-03B: 当前页面会话 hook)', () => {
  // A: mount 顺序 + 默认 mode 行为
  it('A1: mount 按 GET_TEXT_PROVIDER_SETTINGS → GET_CURRENT_PAGE → GET_CACHED_ANALYSIS 顺序初始化', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    const types = callTypes(h.sendMessage);
    expect(types.indexOf('GET_TEXT_PROVIDER_SETTINGS')).toBeLessThan(types.indexOf('GET_CURRENT_PAGE'));
    expect(types.indexOf('GET_CURRENT_PAGE')).toBeLessThan(types.indexOf('GET_CACHED_ANALYSIS'));
  });

  it('A3: settings 失败时 fallback subtitle', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend({ settings: 'fail' }) });
    await act(flushMicrotasks);
    expect(h.result.current.analysisMode).toBe('subtitle');
    expect(h.sendMessage).toHaveBeenCalledWith({
      type: 'GET_CACHED_ANALYSIS',
      payload: { analysisMode: 'subtitle', outputLocale: 'zh-CN' },
    });
  });

  // B: 模式切换
  it('B1: changeAnalysisMode 保持公开版 subtitle，并按 subtitle 读缓存', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();
    h.controls.onAnalysisCacheResolved.mockClear();
    await act(async () => {
      await h.result.current.changeAnalysisMode('subtitle');
    });
    expect(h.result.current.analysisMode).toBe('subtitle');
    expect(h.sendMessage).toHaveBeenCalledWith({
      type: 'GET_CACHED_ANALYSIS',
      payload: { analysisMode: 'subtitle', outputLocale: 'zh-CN' },
    });
    expect(h.controls.onAnalysisCacheResolved).toHaveBeenCalledWith(null);
  });

  it('B2: tab 激活按 subtitle 读缓存', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();
    await act(async () => {
      h.tabController.fireTabActivated();
      await flushMicrotasks();
    });
    expect(h.sendMessage).toHaveBeenCalledWith({
      type: 'GET_CACHED_ANALYSIS',
      payload: { analysisMode: 'subtitle', outputLocale: 'zh-CN' },
    });
  });

  it('B3: outputLocale 更新后，mount-only tab 监听按最新语言读缓存', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend(), outputLocale: 'zh-CN' });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();

    await act(async () => {
      h.rerender({ outputLocale: 'en-US' });
      await flushMicrotasks();
    });
    h.sendMessage.mockClear();

    await act(async () => {
      h.tabController.fireTabActivated();
      await flushMicrotasks();
    });

    expect(h.sendMessage).toHaveBeenCalledWith({
      type: 'GET_CACHED_ANALYSIS',
      payload: { analysisMode: 'subtitle', outputLocale: 'en-US' },
    });
  });

  // C: 缓存命中 / 缺失 / 不匹配
  it('C1: 缓存命中调 onAnalysisCacheResolved(result)', async () => {
    const cached = makeAnalysisResult();
    const h = renderPageSession({ sendMessage: makeScenarioSend({ cache: cached }) });
    await act(flushMicrotasks);
    expect(h.controls.onAnalysisCacheResolved).toHaveBeenCalledWith(cached);
  });

  it('C2: 缓存缺失调 onAnalysisCacheResolved(null)', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend({ cache: 'miss' }) });
    await act(flushMicrotasks);
    expect(h.controls.onAnalysisCacheResolved).toHaveBeenCalledWith(null);
  });

  it('C2b: 同一内容刷新时缓存短暂缺失，不清空已有分析结果', async () => {
    const cached = makeAnalysisResult();
    let cacheReadCount = 0;
    const sendMessage = vi.fn((message: ExtensionRequest): Promise<ExtensionResponse> => {
      switch (message.type) {
        case 'GET_TEXT_PROVIDER_SETTINGS':
          return Promise.resolve(ok('TEXT_PROVIDER_SETTINGS', makeTextProviderSettingsPayload('subtitle')));
        case 'GET_CURRENT_PAGE':
          return Promise.resolve(ok('PAGE_CONTEXT', SAMPLE_CONTEXT));
        case 'GET_CACHED_ANALYSIS':
          cacheReadCount += 1;
          return Promise.resolve(
            cacheReadCount === 1 ? ok('CACHED_ANALYSIS', cached) : fail('transient miss'),
          );
        case 'GET_CACHED_CONTENT_CONTEXT':
          return Promise.resolve(fail('no cc'));
        case 'GET_PLAYBACK_STATE':
          return Promise.resolve(fail('no playback'));
        default:
          return Promise.resolve(fail('unhandled'));
      }
    });
    const h = renderPageSession({ sendMessage });
    await act(flushMicrotasks);
    expect(h.controls.onAnalysisCacheResolved).toHaveBeenCalledWith(cached);

    h.controls.onAnalysisCacheResolved.mockClear();
    h.controls.onPageReset.mockClear();
    await act(async () => {
      h.pageDetectedController.firePageDetected();
      await flushMicrotasks();
    });

    expect(h.controls.onPageReset).not.toHaveBeenCalled();
    expect(h.controls.onAnalysisCacheResolved).not.toHaveBeenCalledWith(null);
  });

  it('C3: 缓存命中但 context.platform 不同 → 不匹配，null', async () => {
    const cached = makeAnalysisResult();
    const h = renderPageSession({ sendMessage: makeScenarioSend({ page: UNSUPPORTED_CONTEXT, cache: cached }) });
    await act(flushMicrotasks);
    expect(h.controls.onAnalysisCacheResolved).toHaveBeenCalledWith(null);
  });

  // D: restoreCache:false
  it('D1: refreshPageContext({ restoreCache: false }) 不读缓存，调 onAnalysisCacheResolved(null)', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();
    h.controls.onAnalysisCacheResolved.mockClear();
    await act(async () => {
      await h.result.current.refreshPageContext({ restoreCache: false });
    });
    expect(h.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_CACHED_ANALYSIS' }));
    expect(h.controls.onAnalysisCacheResolved).toHaveBeenCalledWith(null);
  });

  // E: 无效 page / 失败
  it('E1: GET_CURRENT_PAGE 返回 null context 调 onAnalysisCacheResolved(null) 且不调 cache / content', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend({ page: null }) });
    await act(flushMicrotasks);
    expect(h.result.current.context).toBeNull();
    expect(h.controls.onAnalysisCacheResolved).toHaveBeenCalledWith(null);
    expect(h.controls.onLoadLearningSession).not.toHaveBeenCalled();
    expect(h.controls.onRestoreContentContext).not.toHaveBeenCalled();
  });

  it('E2: GET_CURRENT_PAGE 失败调 setStatus(error.message) 且不调 cache / content', async () => {
    const sendMessage = vi.fn().mockImplementation((message: ExtensionRequest): Promise<ExtensionResponse> => {
      if (message.type === 'GET_TEXT_PROVIDER_SETTINGS') return Promise.resolve(ok('TEXT_PROVIDER_SETTINGS', makeTextProviderSettingsPayload('subtitle')));
      if (message.type === 'GET_CURRENT_PAGE') return Promise.resolve(fail('page 失败'));
      return Promise.resolve(fail('unhandled'));
    });
    const h = renderPageSession({ sendMessage });
    await act(flushMicrotasks);
    expect(h.controls.setStatus).toHaveBeenCalledWith('page 失败');
    expect(h.controls.onAnalysisCacheResolved).not.toHaveBeenCalled();
    expect(h.controls.onLoadLearningSession).not.toHaveBeenCalled();
  });

  // F: 事件触发刷新
  it('F1: tab activated 触发 GET_CURRENT_PAGE', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();
    await act(async () => {
      h.tabController.fireTabActivated();
      await flushMicrotasks();
    });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_CURRENT_PAGE' }));
  });

  it('F2: tab updated URL/title 触发刷新；仅 status 不触发', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();
    // status-only 不触发
    await act(async () => {
      h.tabController.fireTabUpdated(1, { status: 'loading' });
      await flushMicrotasks(2);
    });
    expect(h.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_CURRENT_PAGE' }));
    // URL 触发
    h.sendMessage.mockClear();
    await act(async () => {
      h.tabController.fireTabUpdated(1, { url: 'https://example.com' });
      await flushMicrotasks();
    });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_CURRENT_PAGE' }));
    // title 触发
    h.sendMessage.mockClear();
    await act(async () => {
      h.tabController.fireTabUpdated(1, { title: '新标题' });
      await flushMicrotasks();
    });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_CURRENT_PAGE' }));
  });

  it('F3: PAGE_DETECTED 触发 GET_CURRENT_PAGE', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();
    await act(async () => {
      h.pageDetectedController.firePageDetected();
      await flushMicrotasks();
    });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_CURRENT_PAGE' }));
  });

  // G: unmount 清理
  it('G1: unmount 移除 tab + page-detected 订阅', () => {
    const h = renderPageSession();
    act(() => h.unmount());
    expect(h.tabController.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.pageDetectedController.unsubscribe).toHaveBeenCalledTimes(1);
  });

  // H: 播放状态 TTL + 轮询
  it('H1: GET_PLAYBACK_STATE fresh（距 now < 5s）写入 playbackState', async () => {
    const now = 10_000;
    const fresh: PlaybackState = { currentTime: 42, updatedAt: now - 1_000, paused: false };
    const h = renderPageSession({ sendMessage: makeScenarioSend({ playback: fresh }), now: () => now });
    await act(flushMicrotasks);
    expect(h.result.current.playbackState).toEqual(fresh);
  });

  it('H2: GET_PLAYBACK_STATE stale（距 now >= 5s）写入 null', async () => {
    const now = 10_000;
    const stale: PlaybackState = { currentTime: 42, updatedAt: now - 6_000, paused: false };
    const h = renderPageSession({ sendMessage: makeScenarioSend({ playback: stale }), now: () => now });
    await act(flushMicrotasks);
    expect(h.result.current.playbackState).toBeNull();
  });

  it('H3: loadPlaybackState() 主动调用一次', async () => {
    const now = 10_000;
    const state: PlaybackState = { currentTime: 99, updatedAt: now, paused: false };
    const h = renderPageSession({ sendMessage: makeScenarioSend({ playback: state }), now: () => now });
    await act(flushMicrotasks);
    h.sendMessage.mockClear();
    await act(async () => {
      await h.result.current.loadPlaybackState();
    });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_PLAYBACK_STATE' }));
  });

  it('H4: 1 秒轮询周期性调 GET_PLAYBACK_STATE；unmount 后停止', async () => {
    vi.useFakeTimers();
    const now = 10_000;
    const sendMessage = makeScenarioSend({ playback: { currentTime: 0, updatedAt: now, paused: false } });
    const h = renderPageSession({ sendMessage, now: () => now });
    await act(flushMicrotasks);

    const initial = sendMessage.mock.calls.filter((c) => (c[0] as ExtensionRequest).type === 'GET_PLAYBACK_STATE').length;
    expect(initial).toBeGreaterThanOrEqual(1);

    sendMessage.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    const polled = sendMessage.mock.calls.filter((c) => (c[0] as ExtensionRequest).type === 'GET_PLAYBACK_STATE').length;
    expect(polled).toBeGreaterThanOrEqual(2);

    sendMessage.mockClear();
    act(() => h.unmount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(sendMessage.mock.calls.filter((c) => (c[0] as ExtensionRequest).type === 'GET_PLAYBACK_STATE').length).toBe(0);
  });

  // I: 回调顺序 + 内容上下文同步
  it('I1: 成功 refreshPageContext 调用顺序：onPageReset → cache → restoreContext', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend({ cache: makeAnalysisResult() }) });
    await act(flushMicrotasks);
    const order = (fn: { mock: { invocationCallOrder: readonly number[] } }): number =>
      fn.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(order(h.controls.onPageReset)).toBeLessThan(order(h.controls.onLoadLearningSession));
    expect(order(h.controls.onLoadLearningSession)).toBeLessThan(order(h.controls.onAnalysisCacheResolved));
    expect(order(h.controls.onAnalysisCacheResolved)).toBeLessThan(order(h.controls.onRestoreContentContext));
  });

  it('I2: 支持平台调 onRestoreContentContext 一次；非支持平台也调（App 端按平台决定读/清）', async () => {
    // QA1 必修 A：抖音（不支持内容底座）也必须触发回调，否则切到非支持平台
    // 时残留上一个 B 站的 contentContext。
    const h = renderPageSession({ sendMessage: makeScenarioSend({ page: UNSUPPORTED_CONTEXT }) });
    await act(flushMicrotasks);
    expect(h.controls.onLoadLearningSession).toHaveBeenCalledTimes(1);
    expect(h.controls.onRestoreContentContext).toHaveBeenCalledTimes(1);
    expect(h.controls.onRestoreContentContext).toHaveBeenCalledWith(UNSUPPORTED_CONTEXT);
  });

  it('I3: 有效页面（非 null context）不管平台都触发 onRestoreContentContext', async () => {
    const h = renderPageSession({ sendMessage: makeScenarioSend() });
    await act(flushMicrotasks);
    expect(h.controls.onRestoreContentContext).toHaveBeenCalledWith(SAMPLE_CONTEXT);
  });
});
