import { useEffect, useRef, useState } from 'react';
import {
  VIDEO_TIMELINE_PORT_NAME,
  type ExtensionRequest,
  type ExtensionResponse,
  type VideoTimelinePortMessage,
} from '@shared/messages';
import { sendRuntimeMessage } from '@shared/extension-runtime';
import type { AnalysisMode } from '@shared/settings';
import type { UiLocale } from '@shared/locale-settings';
import type {
  AnalysisDebug,
  AnalysisTiming,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import type { TimelineStreamingChapterDraft } from '../TimelineStreamingPreview';
import { localizeUserMessage } from '@extension/ui/localized-error';

/**
 * 时间线会话 hook。
 *
 * 集中负责 video-timeline Port 生命周期、当前 requestId、partial 流式累积、
 * DONE / ERROR / disconnect 收口。
 *
 * 不负责：
 * - 渲染 UI（由 App 拿到 state 后渲染 TimelineStreamingPreview / TimelineDisplay）
 * - Provider 设置、页面上下文、播放状态、内容底座、导出
 *
 * App 必须传入的页面级 setter / 回调：
 * - analysisMode / analysisResult（用于 "替换旧结果" 判定）
 * - setStatus / setIsAnalyzing / setAnalysisResult / setSelectedTimestamp /
 *   setExpandedChapterIndex / setAnalysisTab / loadLearningSession
 *
 * 测试可注入：
 * - connectPort（默认 chrome.runtime.connect({ name: VIDEO_TIMELINE_PORT_NAME })）
 * - sendMessage（默认 sendRuntimeMessage）
 * - generateRequestId（默认 Date.now() + 随机串）
 */

/** 分析结果缓存载荷（与 messages.ts 的 ANALYSIS_RESULT / CACHED_ANALYSIS payload 同形）。 */
export interface TimelineSessionAnalysisResult {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis;
  readonly subtitleCueCount: number;
  /** 缓存恢复的字幕 cue 列表，供后续提问构造上下文使用。 */
  readonly transcriptCues?: readonly SubtitleCue[];
  readonly timings: readonly AnalysisTiming[];
  readonly debug?: AnalysisDebug;
}

export type AnalysisTab = 'analysis' | 'navigation' | 'followup' | 'notes';

export interface UseTimelineSessionOptions {
  /** 当前视频身份；变化时只切换可见流式草稿，不取消仍在后台生成的请求。 */
  readonly contentIdentity: string | null;
  /** 当前分析模式。公开版只支持 subtitle，旧模式会被拒绝。 */
  readonly analysisMode: AnalysisMode;
  /** 导航输出语言，跟随当前 UI。 */
  readonly outputLocale?: UiLocale;
  /** UI 文案选择器；测试不传时默认中文。 */
  readonly t?: (zh: string, en: string) => string;
  /** 当前结果缓存。`requestTimeline({ forceRefresh: true })` + 已有结果时进入"替换"态。 */
  readonly analysisResult: TimelineSessionAnalysisResult | null;
  /** 页面级 status 更新入口（流式 / DONE / ERROR / disconnect 都会写）。 */
  readonly setStatus: (status: string) => void;
  /** 页面级"是否正在执行某动作"标志。流式进行中为 true，结束回 false。 */
  readonly setIsAnalyzing: (analyzing: boolean) => void;
  /** 写入新的分析结果（DONE 后调用）。 */
  readonly setAnalysisResult: (result: TimelineSessionAnalysisResult | null) => void;
  /** 写入选中的时间点（首次跳到第一个 chapter）。 */
  readonly setSelectedTimestamp: (timestamp: number | null) => void;
  /** 重置展开章节。 */
  readonly setExpandedChapterIndex: (idx: number) => void;
  /** 切 tab。 */
  readonly setAnalysisTab: (tab: AnalysisTab) => void;
  /** 拉取学习会话（DONE 后刷新）。 */
  readonly loadLearningSession: () => Promise<void>;
  /** 测试可注入：Port 连接。生产默认走 chrome.runtime.connect({ name: VIDEO_TIMELINE_PORT_NAME })。 */
  readonly connectPort?: () => chrome.runtime.Port | null;
  /** 测试可注入：sendMessage。生产默认走 sendRuntimeMessage。 */
  readonly sendMessage?: (message: ExtensionRequest) => Promise<ExtensionResponse>;
  /** 测试可注入：requestId 生成器。生产默认走 Date.now() + 随机串。 */
  readonly generateRequestId?: () => string;
}

export interface TimelineSessionRequestOptions {
  /** 跳过缓存重新生成。 */
  readonly forceRefresh?: boolean;
  /** 保留兼容旧调用方；字幕流式路径不需要该字段。 */
  readonly stayOnCurrentTab?: boolean;
}

export interface UseTimelineSessionResult {
  readonly streamingOverviewDraft: string | null;
  readonly streamingChaptersDraft: readonly TimelineStreamingChapterDraft[];
  readonly streamingStatus: string;
  readonly streamingCharacterCount: number;
  readonly isTimelineStreaming: boolean;
  readonly isReplacingExistingResult: boolean;
  readonly requestTimeline: (options?: TimelineSessionRequestOptions) => Promise<void>;
  readonly cancelTimeline: () => void;
}

const defaultConnectPort = (): chrome.runtime.Port | null => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
    return null;
  }
  return chrome.runtime.connect({ name: VIDEO_TIMELINE_PORT_NAME });
};

const defaultSendMessage = (message: ExtensionRequest): Promise<ExtensionResponse> =>
  sendRuntimeMessage(message);

const defaultGenerateRequestId = (): string =>
  `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function hasTimelineResultContent(result: TimelineSessionAnalysisResult): boolean {
  return result.analysis.chapters.length > 0 || result.analysis.timeline.length > 0;
}

/** 4 个共用的"清空流式状态 + 复位标志"动作：DONE / ERROR / disconnect / 通道未建立。 */
type StreamResetAction = 'done' | 'error' | 'disconnect' | 'port-missing';
interface StreamingSnapshot {
  readonly overviewDraft: string | null;
  readonly chaptersDraft: readonly TimelineStreamingChapterDraft[];
  readonly status: string;
  readonly characterCount: number;
  readonly isStreaming: boolean;
  readonly isReplacingExistingResult: boolean;
}

function resetStreamingState(
  _action: StreamResetAction,
  callbacks: {
    readonly setIsTimelineStreaming: (v: boolean) => void;
    readonly setStreamingOverviewDraft: (v: string | null) => void;
    readonly setStreamingChaptersDraft: (
      v: readonly TimelineStreamingChapterDraft[],
    ) => void;
    readonly setStreamingStatus: (v: string) => void;
    readonly setStreamingCharacterCount: (v: number) => void;
    readonly setIsReplacingExistingResult: (v: boolean) => void;
    readonly setIsAnalyzing: (v: boolean) => void;
    readonly activeRequestIdRef: { current: string | null };
    readonly activeRequestContentIdentityRef?: { current: string | null };
    readonly activeRequestOutputLocaleRef?: { current: UiLocale | null };
    readonly setStatus: (status: string) => void;
    readonly statusText?: string;
  },
): void {
  callbacks.setIsTimelineStreaming(false);
  callbacks.setStreamingOverviewDraft(null);
  callbacks.setStreamingChaptersDraft([]);
  callbacks.setStreamingStatus('');
  callbacks.setStreamingCharacterCount(0);
  callbacks.setIsReplacingExistingResult(false);
  callbacks.setIsAnalyzing(false);
  callbacks.activeRequestIdRef.current = null;
  if (callbacks.activeRequestContentIdentityRef) {
    callbacks.activeRequestContentIdentityRef.current = null;
  }
  if (callbacks.activeRequestOutputLocaleRef) {
    callbacks.activeRequestOutputLocaleRef.current = null;
  }
  if (callbacks.statusText !== undefined) {
    callbacks.setStatus(callbacks.statusText);
  }
}

function toContentIdentityKey(identity: string | null): string {
  return identity ?? '__no_content__';
}

function createEmptyStreamingSnapshot(): StreamingSnapshot {
  return {
    overviewDraft: null,
    chaptersDraft: [],
    status: '',
    characterCount: 0,
    isStreaming: false,
    isReplacingExistingResult: false,
  };
}

function applyStreamingSnapshot(
  snapshot: StreamingSnapshot,
  callbacks: {
    readonly setIsTimelineStreaming: (v: boolean) => void;
    readonly setStreamingOverviewDraft: (v: string | null) => void;
    readonly setStreamingChaptersDraft: (
      v: readonly TimelineStreamingChapterDraft[],
    ) => void;
    readonly setStreamingStatus: (v: string) => void;
    readonly setStreamingCharacterCount: (v: number) => void;
    readonly setIsReplacingExistingResult: (v: boolean) => void;
    readonly setIsAnalyzing: (v: boolean) => void;
  },
): void {
  callbacks.setIsTimelineStreaming(snapshot.isStreaming);
  callbacks.setStreamingOverviewDraft(snapshot.overviewDraft);
  callbacks.setStreamingChaptersDraft(snapshot.chaptersDraft);
  callbacks.setStreamingStatus(snapshot.status);
  callbacks.setStreamingCharacterCount(snapshot.characterCount);
  callbacks.setIsReplacingExistingResult(snapshot.isReplacingExistingResult);
  callbacks.setIsAnalyzing(snapshot.isStreaming);
}

export function useTimelineSession(options: UseTimelineSessionOptions): UseTimelineSessionResult {
  const {
    contentIdentity,
    analysisMode,
    outputLocale = 'zh-CN',
    t = (zh: string) => zh,
    analysisResult,
    setStatus,
    setIsAnalyzing,
    setAnalysisResult,
    setSelectedTimestamp,
    setExpandedChapterIndex,
    setAnalysisTab,
    loadLearningSession,
    connectPort = defaultConnectPort,
    sendMessage = defaultSendMessage,
    generateRequestId = defaultGenerateRequestId,
  } = options;

  const [streamingOverviewDraft, setStreamingOverviewDraft] = useState<string | null>(null);
  const [streamingChaptersDraft, setStreamingChaptersDraft] = useState<
    readonly TimelineStreamingChapterDraft[]
  >([]);
  const [streamingStatus, setStreamingStatus] = useState<string>('');
  const [streamingCharacterCount, setStreamingCharacterCount] = useState(0);
  const [isTimelineStreaming, setIsTimelineStreaming] = useState(false);
  const [isReplacingExistingResult, setIsReplacingExistingResult] = useState(false);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeRequestContentIdentityRef = useRef<string | null>(null);
  const activeRequestOutputLocaleRef = useRef<UiLocale | null>(null);
  const contentIdentityRef = useRef<string | null>(contentIdentity);
  const streamingByContentRef = useRef<Map<string, StreamingSnapshot>>(new Map());

  // setters / 回调最新值同步进 ref：让 requestTimeline 拿到最新值但不重新创建引用。
  // requestTimeline 用 ref 取最新 analysisMode / analysisResult / setStatus，避免在它们
  // 变化时摧毁稳定引用 → mount-only Port effect 仍能正确捕获首次回调。
  const callbacksRef = useRef({
    analysisMode,
    analysisResult,
    setStatus,
    setIsAnalyzing,
    setAnalysisResult,
    setSelectedTimestamp,
    setExpandedChapterIndex,
    setAnalysisTab,
    loadLearningSession,
    sendMessage,
    outputLocale,
    t,
  });
  useEffect(() => {
    callbacksRef.current = {
      analysisMode,
      analysisResult,
      setStatus,
      setIsAnalyzing,
      setAnalysisResult,
      setSelectedTimestamp,
      setExpandedChapterIndex,
      setAnalysisTab,
      loadLearningSession,
      sendMessage,
      outputLocale,
      t,
    };
  });

  const connectPortRef = useRef(connectPort);
  useEffect(() => {
    connectPortRef.current = connectPort;
  });
  const generateRequestIdRef = useRef(generateRequestId);
  useEffect(() => {
    generateRequestIdRef.current = generateRequestId;
  });

  useEffect(() => {
    if (contentIdentityRef.current === contentIdentity) {
      return;
    }
    contentIdentityRef.current = contentIdentity;
    const activeSnapshot =
      activeRequestIdRef.current && activeRequestContentIdentityRef.current === contentIdentity
        ? streamingByContentRef.current.get(toContentIdentityKey(contentIdentity))
        : undefined;
    const nextSnapshot = activeSnapshot ?? createEmptyStreamingSnapshot();
    applyStreamingSnapshot(
      nextSnapshot,
      {
        setIsTimelineStreaming,
        setStreamingOverviewDraft,
        setStreamingChaptersDraft,
        setStreamingStatus,
        setStreamingCharacterCount,
        setIsReplacingExistingResult,
        setIsAnalyzing: callbacksRef.current.setIsAnalyzing,
      },
    );
    if (activeSnapshot?.status) {
      callbacksRef.current.setStatus(activeSnapshot.status);
    }
  }, [contentIdentity]);

  // mount-only：建立 video-timeline Port，组件卸载时断开。
  useEffect(() => {
    const port = connectPortRef.current();
    if (!port) {
      return;
    }
    portRef.current = port;

    const handleMessage = (raw: unknown): void => {
      const message = raw as VideoTimelinePortMessage;
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return;
      }
      // 忽略非当前 requestId 的响应（旧 chunk / 旧 done 自然过期）
      if (
        'requestId' in message &&
        message.requestId !== activeRequestIdRef.current
      ) {
        return;
      }
      const messageContentIdentity = activeRequestContentIdentityRef.current;
      const messageContentKey = toContentIdentityKey(messageContentIdentity);
      const isForCurrentContent = messageContentIdentity === contentIdentityRef.current;
      const getSnapshot = (): StreamingSnapshot =>
        streamingByContentRef.current.get(messageContentKey) ?? createEmptyStreamingSnapshot();
      const saveSnapshot = (snapshot: StreamingSnapshot): void => {
        streamingByContentRef.current.set(messageContentKey, snapshot);
      };

      if (message.type === 'VIDEO_TIMELINE_STATUS') {
        const snapshot = { ...getSnapshot(), status: message.text, isStreaming: true };
        saveSnapshot(snapshot);
        if (isForCurrentContent) {
          callbacksRef.current.setStatus(message.text);
          setStreamingStatus(message.text);
        }
        return;
      }

      if (message.type === 'VIDEO_TIMELINE_PARTIAL') {
        // 累积 JSONL partial 事件，更新结构化流式草稿
        const event = message.event;
        const baseSnapshot = getSnapshot();
        const nextCharacterCount = baseSnapshot.characterCount + message.rawLine.length + 1;
        if (event.type === 'overview') {
          const snapshot = {
            ...baseSnapshot,
            overviewDraft: event.text,
            characterCount: nextCharacterCount,
            isStreaming: true,
          };
          saveSnapshot(snapshot);
          if (isForCurrentContent) {
            setStreamingCharacterCount(snapshot.characterCount);
            setStreamingOverviewDraft(event.text);
          }
          return;
        }
        if (event.type === 'chapter') {
          const chapterId = event.id;
          const title = event.title;
          const summary = event.summary;
          const current = baseSnapshot.chaptersDraft;
          const idx = current.findIndex((c) => c.id === chapterId);
          const next: TimelineStreamingChapterDraft = {
            id: chapterId,
            title,
            summary,
            ...(event.importance !== undefined ? { importance: event.importance } : {}),
            ...(event.contentTag !== undefined ? { contentTag: event.contentTag } : {}),
            segments: idx >= 0 ? (current[idx]?.segments ?? []) : [],
          };
          const nextChapters =
            idx >= 0
              ? current.map((chapter, index) => (index === idx ? next : chapter))
              : [...current, next];
          const snapshot = {
            ...baseSnapshot,
            chaptersDraft: nextChapters,
            characterCount: nextCharacterCount,
            isStreaming: true,
          };
          saveSnapshot(snapshot);
          if (isForCurrentContent) {
            setStreamingCharacterCount(snapshot.characterCount);
            setStreamingChaptersDraft(nextChapters);
          }
          return;
        }
        if (event.type === 'segment') {
          const chapterId = event.chapterId;
          const title = event.title;
          const summary = event.summary;
          const current = baseSnapshot.chaptersDraft;
          const idx = current.findIndex((c) => c.id === chapterId);
          if (idx < 0) {
            saveSnapshot({
              ...baseSnapshot,
              characterCount: nextCharacterCount,
              isStreaming: true,
            });
            if (isForCurrentContent) {
              setStreamingCharacterCount(nextCharacterCount);
            }
            return;
          }
          const chapter = current[idx];
          if (!chapter) return;
          const next: TimelineStreamingChapterDraft = {
            ...chapter,
            segments: [
              ...chapter.segments,
              {
                title,
                summary,
                ...(event.importance !== undefined ? { importance: event.importance } : {}),
                ...(event.contentTag !== undefined ? { contentTag: event.contentTag } : {}),
              },
            ],
          };
          const nextChapters = current.map((item, index) => (index === idx ? next : item));
          const snapshot = {
            ...baseSnapshot,
            chaptersDraft: nextChapters,
            characterCount: nextCharacterCount,
            isStreaming: true,
          };
          saveSnapshot(snapshot);
          if (isForCurrentContent) {
            setStreamingCharacterCount(snapshot.characterCount);
            setStreamingChaptersDraft(nextChapters);
          }
          return;
        }
        saveSnapshot({
          ...baseSnapshot,
          characterCount: nextCharacterCount,
          isStreaming: true,
        });
        if (isForCurrentContent) {
          setStreamingCharacterCount(nextCharacterCount);
        }
        // event.type === 'done'：DONE 走另一分支
        return;
      }

      if (message.type === 'VIDEO_TIMELINE_CHUNK') {
        // 原始 chunk 不写默认 UI state；时间线只展示结构化 partial
        return;
      }

      if (message.type === 'VIDEO_TIMELINE_DONE') {
        if (!isForCurrentContent) {
          streamingByContentRef.current.delete(messageContentKey);
          activeRequestIdRef.current = null;
          activeRequestContentIdentityRef.current = null;
          activeRequestOutputLocaleRef.current = null;
          return;
        }
        void (async () => {
          const c = callbacksRef.current;
          const completedContentIdentity = messageContentIdentity;
          const completedOutputLocale = activeRequestOutputLocaleRef.current ?? c.outputLocale;
          // 关键：Port 流式请求固定用 subtitle（见下方 REQUEST_VIDEO_TIMELINE.postMessage），
          // DONE 必须读取本次请求实际写入的缓存，而非当前 UI mode / locale。
          // 若用 c.analysisMode（当前 UI mode），流式期间设置变化可能读到错的缓存。
          // ——刚生成的 subtitle 时间线无法恢复，甚至串入另一模式的旧结果。
          const response = await c.sendMessage({
            type: 'GET_CACHED_ANALYSIS',
            payload: { analysisMode: 'subtitle', outputLocale: completedOutputLocale },
          });
          if (
            completedContentIdentity !== contentIdentityRef.current ||
            message.requestId !== activeRequestIdRef.current
          ) {
            streamingByContentRef.current.delete(toContentIdentityKey(completedContentIdentity));
            if (activeRequestIdRef.current === message.requestId) {
              activeRequestIdRef.current = null;
              activeRequestContentIdentityRef.current = null;
              activeRequestOutputLocaleRef.current = null;
            }
            return;
          }
          if (
            !response.ok ||
            response.type !== 'CACHED_ANALYSIS' ||
            !response.payload ||
            !hasTimelineResultContent(response.payload)
          ) {
            resetStreamingState('error', {
              setIsTimelineStreaming,
              setStreamingOverviewDraft,
              setStreamingChaptersDraft,
              setStreamingStatus,
              setStreamingCharacterCount,
              setIsReplacingExistingResult,
              setIsAnalyzing: c.setIsAnalyzing,
              activeRequestIdRef,
              activeRequestContentIdentityRef,
              activeRequestOutputLocaleRef,
              setStatus: c.setStatus,
              statusText: c.t(
                '导航生成结束，但没有读到有效结果，请重新生成。',
                'Navigation finished, but no valid result was found. Generate it again.',
              ),
            });
            streamingByContentRef.current.delete(messageContentKey);
            return;
          }

          c.setAnalysisResult(response.payload);
          c.setSelectedTimestamp(null);
          c.setExpandedChapterIndex(0);
          resetStreamingState('done', {
            setIsTimelineStreaming,
            setStreamingOverviewDraft,
            setStreamingChaptersDraft,
            setStreamingStatus,
            setStreamingCharacterCount,
            setIsReplacingExistingResult,
            setIsAnalyzing: c.setIsAnalyzing,
            activeRequestIdRef,
            activeRequestContentIdentityRef,
            activeRequestOutputLocaleRef,
            setStatus: c.setStatus,
            statusText: c.t('导航已生成', 'Navigation generated'),
          });
          streamingByContentRef.current.delete(messageContentKey);
          await c.loadLearningSession();
        })();
        return;
      }

      if (message.type === 'VIDEO_TIMELINE_ERROR') {
        if (!isForCurrentContent) {
          streamingByContentRef.current.delete(messageContentKey);
          activeRequestIdRef.current = null;
          activeRequestContentIdentityRef.current = null;
          activeRequestOutputLocaleRef.current = null;
          return;
        }
        const c = callbacksRef.current;
        resetStreamingState('error', {
          setIsTimelineStreaming,
          setStreamingOverviewDraft,
          setStreamingChaptersDraft,
          setStreamingStatus,
          setStreamingCharacterCount,
          setIsReplacingExistingResult,
          setIsAnalyzing: c.setIsAnalyzing,
          activeRequestIdRef,
          activeRequestContentIdentityRef,
          activeRequestOutputLocaleRef,
          setStatus: c.setStatus,
          statusText: localizeUserMessage(
            { code: message.code, message: message.message },
            c.outputLocale,
          ),
        });
        streamingByContentRef.current.delete(messageContentKey);
      }
    };

    const handleDisconnect = (): void => {
      portRef.current = null;
      const c = callbacksRef.current;
      // 活动请求期间断开 → 走完整的流式复位 + 提示
      if (activeRequestIdRef.current) {
        resetStreamingState('disconnect', {
          setIsTimelineStreaming,
          setStreamingOverviewDraft,
          setStreamingChaptersDraft,
          setStreamingStatus,
          setStreamingCharacterCount,
          setIsReplacingExistingResult,
          setIsAnalyzing: c.setIsAnalyzing,
          activeRequestIdRef,
          activeRequestContentIdentityRef,
          activeRequestOutputLocaleRef,
          setStatus: c.setStatus,
          statusText: c.t('连接已断开', 'Connection disconnected'),
        });
      }
    };

    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    return () => {
      port.onMessage.removeListener(handleMessage);
      port.onDisconnect.removeListener(handleDisconnect);
      try {
        port.disconnect();
      } catch {
        // ignore：port 可能已关闭
      }
      portRef.current = null;
    };
  }, []);

  /** 触发时间线生成。公开版只走字幕流式 Port。 */
  const requestTimeline = async (
    requestOptions: TimelineSessionRequestOptions = {},
  ): Promise<void> => {
    const forceRefresh = requestOptions.forceRefresh ?? false;
    const c = callbacksRef.current;

    if (c.analysisMode !== 'subtitle') {
      c.setStatus(
        c.t(
          '公开版只支持快速字幕分析；请在设置中重新保存后再试。',
          'The public build only supports fast subtitle analysis. Save settings again and retry.',
        ),
      );
      return;
    }

    // 后台时间线生成当前是单任务：切换视频不取消；只有用户在当前视频主动发起新生成时取消旧请求。
    if (activeRequestIdRef.current) {
      const oldRequestId = activeRequestIdRef.current;
      const port = portRef.current;
      if (port) {
        try {
          port.postMessage({
            type: 'CANCEL_VIDEO_TIMELINE',
            requestId: oldRequestId,
          });
        } catch {
          // ignore：port 可能已关闭
        }
      }
      streamingByContentRef.current.delete(
        toContentIdentityKey(activeRequestContentIdentityRef.current),
      );
    }

    const requestId = generateRequestIdRef.current();
    const requestContentIdentity = contentIdentityRef.current;
    const requestOutputLocale = c.outputLocale;
    activeRequestIdRef.current = requestId;
    activeRequestContentIdentityRef.current = requestContentIdentity;
    activeRequestOutputLocaleRef.current = requestOutputLocale;

    const displayStatus =
      c.analysisResult && forceRefresh
        ? c.t(
            '正在重新生成导航，新结果将替换当前导航',
            'Regenerating navigation. The new result will replace the current one.',
          )
        : forceRefresh
          ? c.t('正在重新生成导航...', 'Regenerating navigation...')
          : c.t('正在读取视频信息...', 'Reading video information...');
    const snapshot: StreamingSnapshot = {
      overviewDraft: null,
      chaptersDraft: [],
      characterCount: 0,
      isStreaming: true,
      isReplacingExistingResult: Boolean(c.analysisResult && forceRefresh),
      status: displayStatus,
    };
    streamingByContentRef.current.set(toContentIdentityKey(requestContentIdentity), snapshot);

    c.setIsAnalyzing(true);
    setIsTimelineStreaming(true);
    setStreamingOverviewDraft(null);
    setStreamingChaptersDraft([]);
    setStreamingCharacterCount(0);
    c.setStatus(displayStatus);
    setIsReplacingExistingResult(Boolean(c.analysisResult && forceRefresh));
    setStreamingStatus(displayStatus);

    const port = portRef.current;
    if (!port) {
      // 通道未建立：清空流式状态 + 提示
      resetStreamingState('port-missing', {
        setIsTimelineStreaming,
        setStreamingOverviewDraft,
        setStreamingChaptersDraft,
        setStreamingStatus,
        setStreamingCharacterCount,
        setIsReplacingExistingResult,
        setIsAnalyzing: c.setIsAnalyzing,
        activeRequestIdRef,
        activeRequestContentIdentityRef,
        activeRequestOutputLocaleRef,
        setStatus: c.setStatus,
        statusText: c.t(
          '导航通道未建立，请重开侧边栏',
          'Navigation channel is not connected. Reopen the side panel.',
        ),
      });
      streamingByContentRef.current.delete(toContentIdentityKey(requestContentIdentity));
      return;
    }

    port.postMessage({
      type: 'REQUEST_VIDEO_TIMELINE',
      requestId,
      analysisMode: 'subtitle',
      forceRefresh,
      outputLocale: requestOutputLocale,
    });
  };

  const cancelTimeline = (): void => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    const port = portRef.current;
    if (port) {
      try {
        port.postMessage({ type: 'CANCEL_VIDEO_TIMELINE', requestId });
      } catch {
        // ignore：port 可能已关闭
      }
    }
    const c = callbacksRef.current;
    streamingByContentRef.current.delete(
      toContentIdentityKey(activeRequestContentIdentityRef.current),
    );
    resetStreamingState('error', {
      setIsTimelineStreaming,
      setStreamingOverviewDraft,
      setStreamingChaptersDraft,
      setStreamingStatus,
      setStreamingCharacterCount,
      setIsReplacingExistingResult,
      setIsAnalyzing: c.setIsAnalyzing,
      activeRequestIdRef,
      activeRequestContentIdentityRef,
      activeRequestOutputLocaleRef,
      setStatus: c.setStatus,
      statusText: c.t(
        '已停止导航生成，可以重新开始',
        'Navigation generation stopped. You can start again.',
      ),
    });
  };

  return {
    streamingOverviewDraft,
    streamingChaptersDraft,
    streamingStatus,
    streamingCharacterCount,
    isTimelineStreaming,
    isReplacingExistingResult,
    requestTimeline,
    cancelTimeline,
  };
}
