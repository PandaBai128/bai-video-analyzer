import { useCallback, useEffect, useRef, useState } from 'react';
import { sendRuntimeMessage } from '@shared/extension-runtime';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { PageContext } from '@shared/page-context';
import type { PlaybackState } from '@shared/playback-state';
import {
  SETTINGS_KEYS,
  type AnalysisMode,
  type PublicTextProviderSettings,
} from '@shared/settings';
import type { UiLocale } from '@shared/locale-settings';
import { getPageContextContentKey } from '@shared/content-key';
import { isCachedAnalysisForCurrentView } from '../cached-analysis-match';
import type { TimelineSessionAnalysisResult } from './use-timeline-session';
import { localizeUserMessage } from '@extension/ui/localized-error';

const PLAYBACK_STATE_TTL_MS = 5_000;
const PLAYBACK_POLL_INTERVAL_MS = 1_000;

/**
 * 当前页面会话 hook。
 *
 * 集中负责：
 * - 当前 PageContext / analysisMode / playbackState
 * - 默认 mode 加载（mount-only 先 settings 再 page/cache）
 * - tab 切换 / URL-title 更新 / runtime PAGE_DETECTED 监听
 * - 播放状态 TTL 读取 + 1 秒轮询
 * - GET_CURRENT_PAGE 刷新 + 缓存恢复（通过回调让 App 写 result）
 *
 * 不负责（继续 App 拥有）：
 * - analysisResult / selectedTimestamp / expandedChapterIndex / analysisTab / contentContext /
 *   learningSession / 导出状态（hook 通过回调让 App 维护）
 * - 内容底座准备逻辑 / 提问与学习笔记逻辑 / 导出逻辑 / 时间线会话
 * - 渲染 UI（由 App 拿到 state 后渲染）
 *
 * App 必须传入的页面级回调：
 * - setStatus
 * - onPageReset
 * - onAnalysisCacheResolved
 * - onLoadLearningSession
 * - onRestoreContentContext
 *
 * 测试可注入：
 * - sendMessage（默认 sendRuntimeMessage）
 * - subscribeTabEvents（默认 chrome.tabs.onActivated/onUpdated）
 * - subscribePageDetected（默认 chrome.runtime.onMessage(PAGE_DETECTED)）
 * - now（默认 Date.now）
 */

export interface UsePageSessionOptions {
  /** 页面级 status 写入入口。 */
  readonly setStatus: (status: string) => void;
  /**
   * 页面变化后重置 selectedTimestamp / exportedFolderName / analysisTab / expandedChapterIndex。
   * hook 在 setContext 之后、缓存恢复之前调。
   */
  readonly onPageReset?: () => void;
  /**
   * 分析缓存恢复结果回调：
   * - result 非 null → 命中 → App 写入 analysisResult + 首个时间点 + chapter 0 + timeline tab + 状态文案
   * - result 为 null → 未命中/不匹配 → App 清空旧 analysisResult + selectedTimestamp
   */
  readonly onAnalysisCacheResolved?: (result: TimelineSessionAnalysisResult | null) => void;
  /** 有效页面时刷新学习会话。 */
  readonly onLoadLearningSession?: () => Promise<void>;
  /** 恢复内容底座缓存（App 负责读 GET_CACHED_CONTENT_CONTEXT 写 contentContext）。 */
  readonly onRestoreContentContext?: (context: PageContext) => Promise<void> | void;
  /** 初始 mode：mount-only 初始化失败时 fallback。 */
  readonly initialAnalysisMode?: AnalysisMode;
  /** 恢复派生产物缓存时使用的输出语言。 */
  readonly outputLocale?: UiLocale;
  /** UI 文案选择器；测试不传时默认中文。 */
  readonly t?: (zh: string, en: string) => string;
  /** 测试可注入：sendMessage。 */
  readonly sendMessage?: (message: ExtensionRequest) => Promise<ExtensionResponse>;
  /** 测试可注入：tab 事件订阅，返回 unsubscribe。默认走 chrome.tabs.onActivated / onUpdated。 */
  readonly subscribeTabEvents?: (handlers: {
    readonly onTabActivated: () => void;
    readonly onTabUpdated: (
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => void;
  }) => () => void;
  /** 测试可注入：runtime PAGE_DETECTED 订阅，返回 unsubscribe。 */
  readonly subscribePageDetected?: (handler: () => void) => () => void;
  /** 测试可注入：当前时间（用于播放状态 TTL）。默认 Date.now。 */
  readonly now?: () => number;
}

export interface RefreshPageContextOptions {
  /** 是否读 GET_CACHED_ANALYSIS；false 时主动清空旧结果（forceRefresh 走 LLM 期间）。 */
  readonly restoreCache?: boolean;
  /** mount-time 初始化用：从刚加载的默认 mode 显式传入；tab 监听用 ref 读最新值。 */
  readonly analysisMode?: AnalysisMode;
}

export interface UsePageSessionResult {
  readonly context: PageContext | null;
  readonly analysisMode: AnalysisMode;
  readonly textProviderSettings: PublicTextProviderSettings | null;
  readonly playbackState: PlaybackState | null;
  /** 切换分析模式：公开版只支持 subtitle；保留方法用于旧调用方兼容。 */
  readonly changeAnalysisMode: (mode: AnalysisMode) => Promise<void>;
  /** 刷新当前页面 context，恢复缓存 + 内容底座。tab/PAGE_DETECTED/手动刷新都走这里。 */
  readonly refreshPageContext: (options?: RefreshPageContextOptions) => Promise<void>;
  /** 读 background 播放状态（带 5 秒 TTL）。App 切到提问 tab 时主动调用。 */
  readonly loadPlaybackState: () => Promise<void>;
}

const defaultSendMessage = (message: ExtensionRequest): Promise<ExtensionResponse> =>
  sendRuntimeMessage(message);

const defaultNow = (): number => Date.now();

function getContextIdentity(context: PageContext | null): string | null {
  if (!context) {
    return null;
  }
  const contentKey = getPageContextContentKey(context);
  if (contentKey) {
    return `${context.platform}:${contentKey}`;
  }
  return `${context.platform}:${context.url}`;
}

const defaultSubscribeTabEvents = (handlers: {
  readonly onTabActivated: () => void;
  readonly onTabUpdated: (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ) => void;
}): (() => void) => {
  if (typeof chrome === 'undefined' || !chrome.tabs?.onActivated?.addListener) {
    return () => undefined;
  }
  chrome.tabs.onActivated.addListener(handlers.onTabActivated);
  chrome.tabs.onUpdated.addListener(handlers.onTabUpdated);
  return () => {
    chrome.tabs.onActivated.removeListener(handlers.onTabActivated);
    chrome.tabs.onUpdated.removeListener(handlers.onTabUpdated);
  };
};

const defaultSubscribePageDetected = (handler: () => void): (() => void) => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage?.addListener) {
    return () => undefined;
  }
  const wrapped = (request: ExtensionRequest): void => {
    if (request?.type === 'PAGE_DETECTED') handler();
  };
  chrome.runtime.onMessage.addListener(wrapped);
  return () => chrome.runtime.onMessage.removeListener(wrapped);
};

export function usePageSession(options: UsePageSessionOptions): UsePageSessionResult {
  const {
    setStatus,
    onPageReset,
    onAnalysisCacheResolved,
    onLoadLearningSession,
    onRestoreContentContext,
    initialAnalysisMode = 'subtitle',
    outputLocale = 'zh-CN',
    t = (zh: string) => zh,
    sendMessage = defaultSendMessage,
    subscribeTabEvents = defaultSubscribeTabEvents,
    subscribePageDetected = defaultSubscribePageDetected,
    now = defaultNow,
  } = options;

  const [context, setContext] = useState<PageContext | null>(null);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(initialAnalysisMode);
  const [textProviderSettings, setTextProviderSettings] =
    useState<PublicTextProviderSettings | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(null);
  const contextRef = useRef<PageContext | null>(null);

  /**
   * `analysisMode` 的 ref 镜像。
   *
   * 为什么需要：mount-only 注册的 tab / PAGE_DETECTED listener 会调
   * `refreshPageContext()`，如果 `refreshPageContext` 把 `analysisMode` 放 deps，
   * 每次切换模式都生成新函数，但 mount-only effect 永远调首次 render 的老函数
   * → 切换模式后 tab 切换会用旧模式恢复缓存。
   *
   * 修法：analysisMode 走 ref，listener 和 refreshPageContext 都从 ref 读最新值。
   * `context` 不走 ref（避免 stale context），继续由调用方显式传入 refreshPageContext。
   */
  const analysisModeRef = useRef<AnalysisMode>(analysisMode);
  useEffect(() => {
    analysisModeRef.current = analysisMode;
  }, [analysisMode]);
  const outputLocaleRef = useRef<UiLocale>(outputLocale);
  useEffect(() => {
    outputLocaleRef.current = outputLocale;
  }, [outputLocale]);

  // setters / 回调最新值同步进 ref：让内部 hooks 拿到最新值但不重新创建引用。
  const callbacksRef = useRef({
    setStatus,
    onPageReset,
    onAnalysisCacheResolved,
    onLoadLearningSession,
    onRestoreContentContext,
    sendMessage,
    t,
  });
  useEffect(() => {
    callbacksRef.current = {
      setStatus,
      onPageReset,
      onAnalysisCacheResolved,
      onLoadLearningSession,
      onRestoreContentContext,
      sendMessage,
      t,
    };
  });

  const nowRef = useRef(now);
  useEffect(() => {
    nowRef.current = now;
  });

  const loadTextProviderSettings = useCallback(
    async (): Promise<PublicTextProviderSettings | null> => {
      const response = await callbacksRef.current.sendMessage({ type: 'GET_TEXT_PROVIDER_SETTINGS' });
      if (response.ok && response.type === 'TEXT_PROVIDER_SETTINGS') {
        setTextProviderSettings(response.payload);
        setAnalysisMode('subtitle');
        analysisModeRef.current = 'subtitle';
        return response.payload;
      }
      return null;
    },
    [],
  );

  /** 读取 background 缓存的播放状态；TTL 过滤（updatedAt 距 now 小于 5 秒）。 */
  const loadPlaybackState = useCallback(async (): Promise<void> => {
    const response = await callbacksRef.current.sendMessage({ type: 'GET_PLAYBACK_STATE' });
    if (response.ok && response.type === 'PLAYBACK_STATE') {
      const state = response.payload;
      const fresh = state && nowRef.current() - state.updatedAt < PLAYBACK_STATE_TTL_MS;
      setPlaybackState(fresh ? state : null);
    }
  }, []);

  /**
   * 读 GET_CACHED_ANALYSIS + 校验（isCachedAnalysisForCurrentView），
   * 命中通过 onAnalysisCacheResolved(result) 让 App 写入；不命中走 onAnalysisCacheResolved(null)。
   */
  const restoreCachedAnalysis = useCallback(
    async (input: {
      context: PageContext | null;
      analysisMode: AnalysisMode;
      preserveExistingOnMiss?: boolean;
    }): Promise<void> => {
      const c = callbacksRef.current;
      const response = await c.sendMessage({
        type: 'GET_CACHED_ANALYSIS',
        payload: { analysisMode: 'subtitle', outputLocale: outputLocaleRef.current },
      });

      if (!response.ok || response.type !== 'CACHED_ANALYSIS' || !response.payload) {
        if (!input.preserveExistingOnMiss) {
          c.onAnalysisCacheResolved?.(null);
        }
        return;
      }

      if (!isCachedAnalysisForCurrentView(response.payload, input.context, 'subtitle')) {
        if (!input.preserveExistingOnMiss) {
          c.onAnalysisCacheResolved?.(null);
        }
        return;
      }

      c.onAnalysisCacheResolved?.(response.payload);
    },
    [],
  );

  useEffect(() => {
    const currentContext = contextRef.current;
    if (!currentContext) return;
    void restoreCachedAnalysis({
      context: currentContext,
      analysisMode: analysisModeRef.current,
    });
  }, [outputLocale, restoreCachedAnalysis]);

  /**
   * 刷新页面 context：
   * - GET_CURRENT_PAGE
   * - 成功：setContext + setStatus + onPageReset + (有效页面) loadPlaybackState
   * - (有效页面 + restoreCache) restoreCachedAnalysis
   * - (有效页面 + restoreCache=false) 主动清空旧结果
   * - (有效页面 + 支持的内容平台) onRestoreContentContext
   *
   * analysisMode 走 options 显式传入（mount-time 初始化）优先；否则从 ref 读最新值
   * （tab 监听 / 手动刷新用）。
   */
  const refreshPageContext = useCallback(
    async (opts: RefreshPageContextOptions = {}): Promise<void> => {
      const c = callbacksRef.current;
      const shouldRestoreCache = opts.restoreCache ?? true;
      const currentMode = opts.analysisMode ?? analysisModeRef.current;
      c.setStatus(c.t('正在读取当前页面...', 'Reading current page...'));
      const response = await c.sendMessage({ type: 'GET_CURRENT_PAGE' });

      if (!response.ok) {
        c.setStatus(localizeUserMessage(response.error, outputLocaleRef.current));
        return;
      }

      if (response.type === 'PAGE_CONTEXT') {
        const newContext = response.payload;
        const previousIdentity = getContextIdentity(contextRef.current);
        const nextIdentity = getContextIdentity(newContext);
        const isSameContent = previousIdentity !== null && previousIdentity === nextIdentity;
        setContext(newContext);
        contextRef.current = newContext;
        c.setStatus(
          newContext
            ? c.t('已连接当前页面', 'Connected to current page')
            : c.t('还没有检测到支持的页面', 'No supported page detected yet'),
        );
        if (!isSameContent) {
          c.onPageReset?.();
        }

        if (newContext) {
          void loadPlaybackState();
        }

        // 当前页不是支持的视频页（payload 为 null）→ 清空旧 analysisResult
        // 避免用户看到属于上一页/上模式的"幽灵结果"。
        if (!newContext) {
          c.onAnalysisCacheResolved?.(null);
          return;
        }

        await c.onLoadLearningSession?.();

        if (shouldRestoreCache) {
          await restoreCachedAnalysis({
            context: newContext,
            analysisMode: currentMode,
            preserveExistingOnMiss: isSameContent,
          });
        } else {
          c.onAnalysisCacheResolved?.(null);
        }

        // 对每个非空 PageContext 都触发 App 端内容上下文同步回调。
        // App 决定是读缓存（支持平台）还是清空（非支持平台），避免切到非支持
        // 平台（如抖音）时残留上一个 B 站/YouTube 的 contentContext。
        // 内容底座 state 和 GET_CACHED_CONTENT_CONTEXT 读取逻辑都**不**进 hook。
        await c.onRestoreContentContext?.(newContext);
      }
    },
    [loadPlaybackState, restoreCachedAnalysis],
  );

  /**
   * 切换分析模式：公开版只有 subtitle。
   * 不触发 LLM，只读 GET_CACHED_ANALYSIS。
   */
  const changeAnalysisMode = useCallback(
    async (mode: AnalysisMode): Promise<void> => {
      const normalizedMode: AnalysisMode = mode === 'subtitle' ? 'subtitle' : 'subtitle';
      setAnalysisMode(normalizedMode);
      analysisModeRef.current = normalizedMode;
      // setAnalysisMode 后立即调 restoreCachedAnalysis，把当前 context 显式传入。
      await restoreCachedAnalysis({ context, analysisMode: normalizedMode });
    },
    [context, restoreCachedAnalysis],
  );

  // mount-only 初始化：先拿默认 mode，再用默认 mode 刷新页面/恢复缓存。
  // 必须先 settings 再 page/cache，避免 GET_CURRENT_PAGE 比 GET_TEXT_PROVIDER_SETTINGS
  // 先返回时按错模式恢复旧结果。
  useEffect(() => {
    void (async (): Promise<void> => {
      let mode = analysisModeRef.current;
      const settings = await loadTextProviderSettings();
      if (settings) {
        mode = settings.analysisMode;
      }
      // settings 失败 → mode 保持 analysisModeRef.current（'subtitle'）继续刷新
      await refreshPageContext({ analysisMode: mode });
    })();
    // mount-only：deps 不放 refreshPageContext，避免 render loop。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) {
      return () => undefined;
    }
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName === 'local' && SETTINGS_KEYS.textProvider in changes) {
        void loadTextProviderSettings();
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [loadTextProviderSettings]);

  // tab 切换 + URL/title 变化 → refreshPageContext
  useEffect(() => {
    const unsubscribe = subscribeTabEvents({
      onTabActivated: () => {
        void refreshPageContext();
      },
      onTabUpdated: (_tabId, changeInfo) => {
        // 只在 URL / title 变化时刷新，避免 progress / favicon 之类细碎更新频繁触发
        if (changeInfo.url !== undefined || changeInfo.title !== undefined) {
          void refreshPageContext();
        }
      },
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // content script 上报 PAGE_DETECTED（YouTube / B 站 SPA 站内切视频）→ refreshPageContext
  useEffect(() => {
    const unsubscribe = subscribePageDetected(() => {
      void refreshPageContext();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 播放状态：mount 立即读 + 每秒轮询；unmount 清 timer。
  useEffect(() => {
    void loadPlaybackState();
    const timerId = window.setInterval(() => {
      void loadPlaybackState();
    }, PLAYBACK_POLL_INTERVAL_MS);
    return () => window.clearInterval(timerId);
  }, [loadPlaybackState]);

  return {
    context,
    analysisMode,
    textProviderSettings,
    playbackState,
    changeAnalysisMode,
    refreshPageContext,
    loadPlaybackState,
  };
}
