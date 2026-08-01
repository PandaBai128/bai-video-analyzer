import { useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { cn } from '@lib/utils';
import { exportVideoToVault } from '@core/export/export-to-vault';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import { sendRuntimeMessage } from '@shared/extension-runtime';
import { FollowupTab } from './FollowupTab';
import { TimelineStreamingPreview } from './TimelineStreamingPreview';
import { TimelineDisplay, mapVideoChaptersToDisplay } from './TimelineDisplay';
import { PageHeader } from './components/PageHeader';
import { FeatureTabs, type AnalysisTab } from './components/FeatureTabs';
import { AnalysisTab as AnalysisTabView, QuickStartGuide } from './components/AnalysisTab';
import { NotesTab } from './components/NotesTab';
import { usePageSession } from './hooks/use-page-session';
import { useLearningSession } from './hooks/use-learning-session';
import { useTimelineSession } from './hooks/use-timeline-session';
import type { TimelineSessionAnalysisResult } from './hooks/use-timeline-session';
import { buildFollowupContextKey, pickFollowupTabVisibility } from './followup-visibility';
import { mapPrepareContentContextError } from './followup-error-mapping';
import {
  filterLearningSessionForLocale,
  isVideoAnalysisVisibleForLocale,
} from './localized-artifacts';
import {
  createTabScrollPositions,
  getTabScrollPosition,
  resetTabScrollPositions,
  setTabScrollPosition,
  type ScrollRestoredAnalysisTab,
  type TabScrollPositions,
} from './tab-scroll-memory';
import type { PageContext } from '@shared/page-context';
import { getPageContextContentKey, isSupportedContentContextPlatform } from '@shared/content-key';
import type { ContentContextCacheValue } from '@core/storage/content-context-cache';
import type {
  AnalysisDebug,
  AnalysisTiming,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import {
  DEFAULT_UI_APPEARANCE_SETTINGS,
  UI_APPEARANCE_STORAGE_KEY,
  readUiAppearanceSettings,
  resolveUiColorScheme,
  type UiAppearanceSettings,
} from '@shared/appearance-settings';
import { useUiLocale, useUiText } from '@extension/ui/locale-context';
import { localizeUnknownError, localizeUserMessage } from '@extension/ui/localized-error';

const SIDE_PANEL_TAB_STORAGE_PREFIX = 'bai.sidepanel.tab.v1:';

function getSessionStorage(): Storage | null {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function readPersistedAnalysisTab(contextKey: string): AnalysisTab | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  const value = storage.getItem(`${SIDE_PANEL_TAB_STORAGE_PREFIX}${contextKey}`);
  if (value === 'judgment') return 'analysis';
  if (value === 'timeline') return 'navigation';
  if (value === 'review') return 'notes';
  return value === 'analysis' || value === 'navigation' || value === 'followup' || value === 'notes'
    ? value
    : null;
}

function persistAnalysisTab(contextKey: string, tab: AnalysisTab): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(`${SIDE_PANEL_TAB_STORAGE_PREFIX}${contextKey}`, tab);
  } catch {
    // sessionStorage 不可写时不影响主流程。
  }
}

export function App(): JSX.Element {
  const locale = useUiLocale();
  const t = useUiText();

  useEffect(() => {
    document.title = t('bAI 视频分析助手', 'bAI Video Analysis Assistant');
  }, [t]);
  const [status, setStatus] = useState(() =>
    t('正在读取当前页面...', 'Reading current page...'),
  );
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<{
    metadata: VideoMetadata;
    analysis: VideoAnalysis;
    subtitleCueCount: number;
    /** 缓存恢复的字幕 cue 列表，供后续提问构造上下文使用。 */
    transcriptCues?: readonly SubtitleCue[];
    timings: readonly AnalysisTiming[];
    debug?: AnalysisDebug;
  } | null>(null);
  // 内容底座独立于时间线分析结果：提问只需要 metadata + transcriptCues。
  const [contentContext, setContentContext] = useState<ContentContextCacheValue | null>(null);
  const [selectedTimestamp, setSelectedTimestamp] = useState<number | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportedFolderName, setExportedFolderName] = useState('');
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>('analysis');
  const [appearance, setAppearance] = useState<UiAppearanceSettings>(
    DEFAULT_UI_APPEARANCE_SETTINGS,
  );
  const [prefersDark, setPrefersDark] = useState(false);
  const [expandedChapterIndex, setExpandedChapterIndex] = useState(0);
  /** 是否跟随播放进度自动展开当前章节；用户手动展开会暂停跟随。 */
  const [isTimelineFollowingPlayback, setIsTimelineFollowingPlayback] = useState(true);
  // 用户是否曾进入提问 tab（UI 名）：true 后切走不卸载，切回 hidden；false 完全不挂载。
  const [hasVisitedFollowup, setHasVisitedFollowup] = useState(false);
  const [pendingFollowupDraft, setPendingFollowupDraft] = useState<{
    readonly id: number;
    readonly text: string;
  } | null>(null);
  const tabScrollPositionsRef = useRef<TabScrollPositions>(createTabScrollPositions());
  const latestContextRef = useRef<PageContext | null>(null);
  const autoPreparedContentKeysRef = useRef<Set<string>>(new Set());
  const tabScrollNodesRef = useRef<
    Partial<Record<ScrollRestoredAnalysisTab, HTMLDivElement | null>>
  >({});

  const attachTabScrollContainer = useCallback(
    (tab: ScrollRestoredAnalysisTab, element: HTMLDivElement | null): void => {
      tabScrollNodesRef.current[tab] = element;
      if (element) {
        element.scrollTop = getTabScrollPosition(tabScrollPositionsRef.current, tab);
      }
    },
    [],
  );
  const analysisScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => attachTabScrollContainer('analysis', element),
    [attachTabScrollContainer],
  );
  const navigationScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => attachTabScrollContainer('navigation', element),
    [attachTabScrollContainer],
  );
  const notesScrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => attachTabScrollContainer('notes', element),
    [attachTabScrollContainer],
  );
  const handleTabScroll = useCallback(
    (tab: ScrollRestoredAnalysisTab, event: UIEvent<HTMLDivElement>): void => {
      setTabScrollPosition(tabScrollPositionsRef.current, tab, event.currentTarget.scrollTop);
    },
    [],
  );
  const rememberCurrentTabScroll = useCallback(
    (tab: AnalysisTab): void => {
      if (tab === 'followup') return;
      const element = tabScrollNodesRef.current[tab];
      if (element) {
        setTabScrollPosition(tabScrollPositionsRef.current, tab, element.scrollTop);
      }
    },
    [],
  );

  // 页面切换后重置选中时间点 / 导出目录 / tab / 展开章节（hook 在 setContext 之后调）。
  const handlePageReset = useCallback((): void => {
    setSelectedTimestamp(null);
    setExportedFolderName('');
    setAnalysisTab('analysis');
    setIsAnalyzing(false);
    setExpandedChapterIndex(0);
    setPendingFollowupDraft(null);
    resetTabScrollPositions(tabScrollPositionsRef.current);
    for (const element of Object.values(tabScrollNodesRef.current)) {
      if (element) {
        element.scrollTop = 0;
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readUiAppearanceSettings().then((settings) => {
      if (!cancelled) setAppearance(settings);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return undefined;
    const media = globalThis.matchMedia('(prefers-color-scheme: dark)');
    const update = (): void => setPrefersDark(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
      return undefined;
    }
    const handleChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') return;
      const changed = changes[UI_APPEARANCE_STORAGE_KEY];
      if (changed?.newValue) {
        void readUiAppearanceSettings().then(setAppearance);
      }
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => chrome.storage.onChanged.removeListener(handleChange);
  }, []);

  // 分析缓存恢复结果写入：result 非 null → 命中写入 + 状态；null → 清空旧结果。
  const handleAnalysisCacheResolved = useCallback(
    (result: TimelineSessionAnalysisResult | null): void => {
      if (!result) {
        setAnalysisResult(null);
        setSelectedTimestamp(null);
        return;
      }
      setAnalysisResult(result);
      // 初次恢复不制造“用户已选中第一个节点”的假状态；时间线高亮应先跟随真实播放位置。
      setSelectedTimestamp(null);
      setExpandedChapterIndex(0);
      setStatus(t('已恢复上次分析结果', 'Restored previous analysis'));
    },
    [t],
  );

  // 内容底座只读缓存恢复（GET_CACHED_CONTENT_CONTEXT）；抓字幕 / LLM 由 prepareContentContext。
  const handleRestoreContentContext = useCallback(
    async (newContext: PageContext): Promise<void> => {
      if (!isVideoLearningContext(newContext)) {
        setContentContext(null);
        return;
      }
      const ccResp = await sendMessage({ type: 'GET_CACHED_CONTENT_CONTEXT' });
      if (ccResp.ok && ccResp.type === 'CACHED_CONTENT_CONTEXT' && ccResp.payload) {
        setContentContext(ccResp.payload);
      } else {
        setContentContext(null);
      }
    },
    [],
  );

  // 页面会话 hook：context / mode / playback + 切换/刷新/读播放 + settings 顺序 + tab/PAGE_DETECTED + 轮询。
  const {
    context,
    analysisMode,
    textProviderSettings,
    playbackState,
    refreshPageContext,
    loadPlaybackState,
  } = usePageSession({
    outputLocale: locale,
    t,
    setStatus,
    onPageReset: handlePageReset,
    onAnalysisCacheResolved: handleAnalysisCacheResolved,
    onRestoreContentContext: handleRestoreContentContext,
  });

  const learningContextKey = context
    ? `${context.platform}:${context.contentKey ?? context.videoId ?? ''}`
    : '';
  const timelineContentIdentity = context
    ? `${context.platform}:${getPageContextContentKey(context) ?? context.videoId ?? context.url}`
    : null;
  const {
    session: learningSession,
    isMutating: isLearningMutating,
    isGenerating: isLearningGenerating,
    isGeneratingGuide: isLearningGuideGenerating,
    guideGenerationStartedAt: analysisGenerationStartedAt,
    guideGenerationStatus: analysisGenerationStatus,
    guideGenerationCharacterCount: analysisGenerationCharacterCount,
    loadSession: loadLearningSession,
    generateGuide: generateLearningGuide,
    cancelGuideGeneration: cancelLearningGuideGeneration,
    addMoment: addLearningMoment,
    updateMoment: updateLearningMoment,
    removeMoment: removeLearningMoment,
    toggleExchangeInReview: toggleLearningExchangeInReview,
    generateReview: generateLearningReview,
  } = useLearningSession({
    contextKey: learningContextKey,
    analysisMode,
    outputLocale: locale,
    setStatus,
    t,
  });

  // 时间线会话（Port 流式 + 精准一次性 sendMessage）集中在 useTimelineSession；App 只透传 setters。
  const {
    streamingOverviewDraft,
    streamingChaptersDraft,
    streamingStatus,
    streamingCharacterCount,
    isTimelineStreaming,
    isReplacingExistingResult,
    requestTimeline,
    cancelTimeline,
  } = useTimelineSession({
    contentIdentity: timelineContentIdentity,
    analysisMode,
    outputLocale: locale,
    t,
    analysisResult,
    setStatus,
    setIsAnalyzing,
    setAnalysisResult,
    setSelectedTimestamp,
    setExpandedChapterIndex,
    setAnalysisTab,
    loadLearningSession,
  });

  const followupContextKey = buildFollowupContextKey({
    platform: context?.platform ?? null,
    contentKey: context ? (getPageContextContentKey(context) ?? null) : null,
    analysisMode,
  });

  useEffect(() => {
    latestContextRef.current = context;
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const restoredTab = readPersistedAnalysisTab(followupContextKey);
    if (!restoredTab) return;
    setAnalysisTab(restoredTab);
    if (restoredTab === 'followup') {
      setHasVisitedFollowup(true);
    }
  }, [context, followupContextKey]);

  const prepareContentContext = useCallback(async (): Promise<ContentContextCacheValue | null> => {
    if (!isSupportedContentContextPlatform(context?.platform)) {
      setStatus(
        mapPrepareContentContextError(
          'UNSUPPORTED_PLATFORM',
          t('当前平台不支持内容上下文', 'Current platform does not support content context'),
          locale,
        ),
      );
      return null;
    }
    if (!isVideoLearningContext(context)) {
      setStatus(
        mapPrepareContentContextError(
          'NO_PAGE_CONTEXT',
          t('当前页面不是视频页', 'Current page is not a video page'),
          locale,
        ),
      );
      return null;
    }
    const expectedContentKey = getPageContextContentKey(context);
    const isRequestStillCurrent = (): boolean => {
      const latestContext = latestContextRef.current;
      return (
        isVideoLearningContext(latestContext) &&
        latestContext.platform === context.platform &&
        getPageContextContentKey(latestContext) === expectedContentKey
      );
    };
    setIsAnalyzing(true);
    setStatus(t('正在读取视频字幕...', 'Reading video subtitles...'));
    const response = await sendMessage({
      type: 'PREPARE_CONTENT_CONTEXT',
      payload: { forceRefresh: false },
    });
    if (!isRequestStillCurrent()) {
      return null;
    }
    setIsAnalyzing(false);
    if (!response.ok) {
      setStatus(mapPrepareContentContextError(response.error.code, response.error.message, locale));
      return null;
    }
    if (response.type === 'CONTENT_CONTEXT') {
      if (
        response.payload.platform !== context.platform ||
        response.payload.contentKey !== expectedContentKey
      ) {
        return null;
      }
      const prepared: ContentContextCacheValue = {
        metadata: response.payload.metadata,
        transcriptCues: response.payload.transcriptCues,
        transcriptSource: response.payload.transcriptSource,
        ...(response.payload.language ? { language: response.payload.language } : {}),
      };
      if (!isRequestStillCurrent()) {
        return null;
      }
      setContentContext(prepared);
      setStatus(
        t(
          '已开启当前视频内容，可以分析、导航、提问或写笔记',
          'Video content is ready. You can analyze, navigate, ask, or write notes.',
        ),
      );
      return prepared;
    }
    return null;
  }, [context, locale, t]);

  const generateAnalysis = useCallback(
    async (forceRefresh = false): Promise<void> => {
      setIsAnalyzing(true);
      try {
        await generateLearningGuide(forceRefresh);
      } finally {
        setIsAnalyzing(false);
      }
    },
    [generateLearningGuide],
  );

  const startAnalysis = useCallback(
    async (forceRefresh = false): Promise<void> => {
      if (!isVideoLearningContext(context)) {
        setStatus(
          mapPrepareContentContextError(
            'NO_PAGE_CONTEXT',
            t('当前页面不是视频页', 'Current page is not a video page'),
            locale,
          ),
        );
        return;
      }
      const expectedContentKey = getPageContextContentKey(context);
      const prepared = contentContext ?? (await prepareContentContext());
      if (!prepared) {
        return;
      }
      const latestContext = latestContextRef.current;
      if (
        !isVideoLearningContext(latestContext) ||
        latestContext.platform !== context.platform ||
        getPageContextContentKey(latestContext) !== expectedContentKey
      ) {
        return;
      }
      await generateAnalysis(forceRefresh);
    },
    [contentContext, context, generateAnalysis, locale, prepareContentContext, t],
  );

  useEffect(() => {
    if (analysisTab !== 'analysis') return;
    if (contentContext || isAnalyzing) return;
    if (!isVideoLearningContext(context)) return;
    const contentKey = getPageContextContentKey(context);
    const autoPrepareKey = `${context.platform}:${contentKey}`;
    if (autoPreparedContentKeysRef.current.has(autoPrepareKey)) return;
    autoPreparedContentKeysRef.current.add(autoPrepareKey);
    void prepareContentContext();
  }, [analysisTab, contentContext, context, isAnalyzing, prepareContentContext]);

  // 切到分析 / 导航 / 提问 / 笔记时主动开启当前视频内容；按钮只作为失败或未自动触发时的兜底。
  const handleSelectTab = (next: AnalysisTab): void => {
    rememberCurrentTabScroll(analysisTab);
    setAnalysisTab(next);
    if (context) {
      persistAnalysisTab(followupContextKey, next);
    }
    const needsContent =
      analysisMode === 'subtitle' &&
      (next === 'analysis' || next === 'navigation' || next === 'followup' || next === 'notes');
    if (next === 'followup') {
      setHasVisitedFollowup(true);
    }
    if (!needsContent) return;
    void loadPlaybackState();
    if (!contentContext && !isAnalyzing && isVideoLearningContext(context)) {
      void prepareContentContext();
    }
  };

  const localizedLearningSession = filterLearningSessionForLocale(learningSession, locale);
  const localizedAnalysisResult =
    analysisResult && isVideoAnalysisVisibleForLocale(analysisResult.analysis, locale)
      ? analysisResult
      : null;

  async function exportCurrentVideo(): Promise<void> {
    const exportMetadata = contentContext?.metadata ?? localizedAnalysisResult?.metadata;
    if (!exportMetadata) {
      setStatus(t('请先开启当前视频内容', 'Open the current video content first'));
      return;
    }
    if (!localizedLearningSession?.review) {
      setStatus(t('请先生成学习笔记', 'Generate study notes first'));
      return;
    }

    setIsExporting(true);
    setStatus(t('正在导出 Markdown...', 'Exporting Markdown...'));

    try {
      const record = await exportVideoToVault({
        metadata: exportMetadata,
        analysis: localizedAnalysisResult?.analysis ?? null,
        learningSession: localizedLearningSession,
        outputLocale: locale,
        confirmOverwrite: (folderName) =>
          window.confirm(
            t(`${folderName} 已存在，要覆盖吗？`, `${folderName} already exists. Overwrite?`),
          ),
      });

      setExportedFolderName(record.folderName);
      setStatus(t(`已导出到 ${record.folderName}`, `Exported to ${record.folderName}`));
    } catch (error) {
      setStatus(localizeUnknownError(error, locale));
    } finally {
      setIsExporting(false);
    }
  }

  async function seekAndSelect(timestamp: number): Promise<void> {
    setSelectedTimestamp(timestamp);

    const response = await sendMessage({
      type: 'SEEK_ACTIVE_VIDEO',
      payload: { seconds: timestamp },
    });

    if (!response.ok) {
      setStatus(localizeUserMessage(response.error, locale));
    }
  }

  const activeChapterIndex =
    localizedAnalysisResult && playbackState
      ? getActiveChapterIndex(localizedAnalysisResult.analysis.chapters, playbackState.currentTime)
      : -1;
  const isVideoWorkflowAvailable = isVideoLearningContext(context);
  const hasFollowupContext = isVideoWorkflowAvailable && Boolean(contentContext);
  const hasLearningContext = isVideoWorkflowAvailable && Boolean(contentContext);

  useEffect(() => {
    if (!isTimelineFollowingPlayback) return;
    if (activeChapterIndex < 0) return;
    setExpandedChapterIndex(activeChapterIndex);
  }, [isTimelineFollowingPlayback, activeChapterIndex]);
  // 只有当前展开章节等于当前播放章节时，才计算章节内的小节高亮。
  const expandedChapter =
    localizedAnalysisResult && expandedChapterIndex >= 0
      ? localizedAnalysisResult.analysis.chapters[expandedChapterIndex]
      : undefined;
  const activeSegmentIndexForExpandedChapter =
    localizedAnalysisResult &&
    playbackState &&
    expandedChapter &&
    expandedChapterIndex === activeChapterIndex
      ? getActiveSegmentIndexForChapter(expandedChapter, playbackState.currentTime)
      : -1;
  const resolvedColorScheme = resolveUiColorScheme(appearance.colorScheme, prefersDark);

  useLayoutEffect(() => {
    if (analysisTab === 'followup') return;
    const element = tabScrollNodesRef.current[analysisTab];
    if (!element) return;
    element.scrollTop = getTabScrollPosition(tabScrollPositionsRef.current, analysisTab);
  }, [analysisTab]);

  return (
    <main
      className={cn(
        'bai-shell flex h-screen flex-col overflow-hidden bg-background p-4 text-foreground',
        resolvedColorScheme === 'dark' && 'dark',
      )}
      data-ui-style={appearance.visualStyle}
      data-ui-theme={appearance.colorScheme}
      data-ui-color-scheme={resolvedColorScheme}
      data-ui-font-size={appearance.fontSize}
    >
      <section className="flex h-full min-h-0 flex-col">
        <PageHeader
          context={context}
          status={status}
          contentContext={contentContext}
          analysisResult={localizedAnalysisResult}
          learningSession={localizedLearningSession}
          activeAnalysisGenerationStartedAt={analysisGenerationStartedAt}
          activeAnalysisGenerationCharacterCount={analysisGenerationCharacterCount}
          textModelAccessMode={textProviderSettings?.textModelAccessMode}
          activeTab={analysisTab}
          isActionDisabled={isAnalyzing || isLearningMutating || isLearningGuideGenerating}
          {...(localizedLearningSession?.guide
            ? { onRegenerateAnalysis: () => void generateAnalysis(true) }
            : {})}
          {...(localizedAnalysisResult
            ? { onRegenerateNavigation: () => void requestTimeline({ forceRefresh: true }) }
            : {})}
          onRefreshPageContext={refreshPageContext}
        />

        {context ? (
          <section
            className="bai-panel mt-3 flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-card p-3"
            data-testid="timeline-result-section"
          >
            {isVideoWorkflowAvailable ? (
              <>
                <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                  {analysisTab === 'analysis' ? (
                    <AnalysisTabView
                      session={localizedLearningSession}
                      hasContentContext={hasLearningContext}
                      isPreparing={isAnalyzing}
                      isMutating={isLearningMutating}
                      isGeneratingGuide={isLearningGuideGenerating}
                      generationStatus={analysisGenerationStatus || status}
                      generationStartedAt={analysisGenerationStartedAt}
                      scrollContainerRef={analysisScrollContainerRef}
                      onScroll={(event) => handleTabScroll('analysis', event)}
                      onStartAnalysis={startAnalysis}
                      onCancelGenerateGuide={cancelLearningGuideGeneration}
                    />
                  ) : analysisTab === 'navigation' ? (
                    <div
                      ref={navigationScrollContainerRef}
                      className="h-full min-h-0 space-y-3 overflow-y-auto pt-3"
                      data-scroll-tab="navigation"
                      data-testid="navigation-tab"
                      onScroll={(event) => handleTabScroll('navigation', event)}
                    >
                      {isTimelineStreaming ? null : !localizedAnalysisResult ? (
                        <button
                          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                          type="button"
                          disabled={isAnalyzing}
                          onClick={() => void requestTimeline()}
                          data-testid="timeline-cta-generate"
                        >
                          {isAnalyzing
                            ? t('生成中...', 'Generating...')
                            : t('生成导航', 'Generate Navigation')}
                        </button>
                      ) : null}
                      {isTimelineStreaming ? (
                        <TimelineStreamingPreview
                          isStreaming={isTimelineStreaming}
                          status={streamingStatus || status}
                          characterCount={streamingCharacterCount}
                          overviewDraft={streamingOverviewDraft}
                          chaptersDraft={streamingChaptersDraft}
                          chapterCount={streamingChaptersDraft.length}
                          replacing={isReplacingExistingResult}
                          onCancel={cancelTimeline}
                        />
                      ) : localizedAnalysisResult ? (
                        <TimelineDisplay
                          mode="final"
                          overview={localizedAnalysisResult.analysis.overview}
                          showOverview={false}
                          chapters={mapVideoChaptersToDisplay(
                            localizedAnalysisResult.analysis.chapters,
                          )}
                          timeAccuracy={
                            localizedAnalysisResult.analysis.sourceMode === 'multimodal'
                              ? 'estimated'
                              : 'exact'
                          }
                          activeChapterIndex={activeChapterIndex}
                          expandedChapterIndex={expandedChapterIndex}
                          activeSegmentIndex={activeSegmentIndexForExpandedChapter}
                          onSeekChapter={(chapter) => {
                            if (typeof chapter.timestamp === 'number') {
                              setIsTimelineFollowingPlayback(false);
                              void seekAndSelect(chapter.timestamp);
                            }
                          }}
                          onToggleChapter={(idx) => {
                            setExpandedChapterIndex((current) => (current === idx ? -1 : idx));
                            setIsTimelineFollowingPlayback(false);
                          }}
                          onSeekSegment={(segment) => {
                            if (typeof segment.timestamp === 'number') {
                              void seekAndSelect(segment.timestamp);
                              setIsTimelineFollowingPlayback(true);
                            }
                          }}
                        />
                      ) : null}
                    </div>
                  ) : analysisTab === 'notes' ? (
                    <NotesTab
                      session={localizedLearningSession}
                      hasContentContext={hasLearningContext}
                      {...(playbackState ? { currentTime: playbackState.currentTime } : {})}
                      isPreparing={isAnalyzing}
                      isMutating={isLearningMutating}
                      isGenerating={isLearningGenerating}
                      isExporting={isExporting}
                      exportedFolderName={exportedFolderName}
                      scrollContainerRef={notesScrollContainerRef}
                      onScroll={(event) => handleTabScroll('notes', event)}
                      onPrepareContentContext={() => void prepareContentContext()}
                      onAddMoment={addLearningMoment}
                      onUpdateMoment={updateLearningMoment}
                      onRemoveMoment={removeLearningMoment}
                      onToggleExchangeInReview={toggleLearningExchangeInReview}
                      onGenerateReview={generateLearningReview}
                      onExport={exportCurrentVideo}
                      onSeek={(timestamp) => void seekAndSelect(timestamp)}
                    />
                  ) : null}

                {(() => {
                  const visibility = pickFollowupTabVisibility({
                    hasVisitedFollowup,
                    analysisTab,
                  });
                  if (!visibility.shouldRender) {
                    return null;
                  }
                  return (
                    <div
                      className={cn('h-full min-h-0', visibility.shouldHide && 'hidden')}
                      data-tab="followup"
                      data-testid="followup-tab-wrapper"
                    >
                      <FollowupTab
                        hasContentContext={hasFollowupContext}
                        analysisMode={analysisMode}
                        playbackState={playbackState}
                        onPrepareContentContext={() => void prepareContentContext()}
                        isAnalyzing={isAnalyzing}
                        contextKey={followupContextKey}
                        webSearchAvailable={
                          (textProviderSettings?.activeTextProvider ?? 'minimax') === 'minimax' &&
                          textProviderSettings?.webSearchEnabled === true &&
                          textProviderSettings.hasApiKey === true
                        }
                        onSeekTimestamp={(seconds) => void seekAndSelect(seconds)}
                        selectedTimestamp={selectedTimestamp}
                        savedExchanges={localizedLearningSession?.exchanges ?? []}
                        onToggleExchangeInReview={(exchange, included) =>
                          void toggleLearningExchangeInReview(exchange, included)
                        }
                        {...(pendingFollowupDraft ? { initialDraft: pendingFollowupDraft } : {})}
                      />
                    </div>
                  );
                })()}
                </div>
                <div className="shrink-0 pt-2">
                  <FeatureTabs activeTab={analysisTab} onSelectTab={handleSelectTab} />
                </div>
              </>
            ) : (
              <div
                className="min-h-0 flex-1 overflow-y-auto py-3"
                data-testid="non-video-page-guide"
              >
                <div className="space-y-3">
                  <div className="rounded-md border border-dashed border-border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
                    {t(
                      '请打开 B 站 / YouTube 视频页，再使用分析、导航、提问和笔记。',
                      'Open a Bilibili or YouTube video page, then use Analysis, Navigation, Ask, and Notes.',
                    )}
                  </div>
                  <QuickStartGuide actionDisabled={false} compact />
                </div>
              </div>
            )}
          </section>
        ) : null}
      </section>
    </main>
  );
}

async function sendMessage(message: ExtensionRequest): Promise<ExtensionResponse> {
  return sendRuntimeMessage(message);
}

function isVideoLearningContext(context: PageContext | null | undefined): context is PageContext & {
  readonly platform: 'bilibili' | 'youtube';
  readonly videoId: string;
} {
  return isSupportedContentContextPlatform(context?.platform) && Boolean(context?.videoId);
}

function getActiveChapterIndex(chapters: VideoAnalysis['chapters'], currentTime: number): number {
  return chapters.findIndex((chapter, index) => {
    const nextChapter = chapters[index + 1];
    return (
      currentTime >= chapter.timestamp && (!nextChapter || currentTime < nextChapter.timestamp)
    );
  });
}

/** 在指定章节内根据 currentTime 找当前 segment，避免把全局索引当章节内索引。 */
function getActiveSegmentIndexForChapter(
  chapter: VideoAnalysis['chapters'][number],
  currentTime: number,
): number {
  return chapter.segments.findIndex((segment, index) => {
    const nextSegment = chapter.segments[index + 1];
    const end = segment.endTimestamp ?? nextSegment?.timestamp ?? chapter.endTimestamp;
    return currentTime >= segment.timestamp && (typeof end !== 'number' || currentTime < end);
  });
}
