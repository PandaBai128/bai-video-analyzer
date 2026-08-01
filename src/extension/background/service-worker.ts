import { createLanguageModelClient } from '@core/llm/language-model-factory';
import { BaiServiceClient } from '@core/llm/bai-service-client';
import { analyzeVideo } from '@core/analysis/analyze-video';
import { fetchSubtitlesForTimeline } from '@core/analysis/timeline-request-context';
import { generateLearningGuide } from '@core/learning/generate-learning-guide';
import { generateWatchDecisionPackage } from '@core/learning/generate-watch-decision-package';
import { generateLearningMomentCoach } from '@core/learning/generate-learning-moment-coach';
import { generateLearningReview } from '@core/learning/generate-learning-review';
import { getCachedAnalysis, saveCachedAnalysis } from '@core/storage/analysis-cache';
import { getCachedContentContext, saveContentContext } from '@core/storage/content-context-cache';
import type { VideoPlatform } from '@core/types';
import {
  appendLearningMoment,
  getLearningSession,
  getOrCreateLearningSession,
  removeLearningMoment,
  saveLearningGuide,
  saveLearningMomentCoach,
  saveLearningExchange,
  saveLearningReview,
  updateLearningCoach,
  updateLearningGoal,
  updateLearningMoment,
} from '@core/storage/learning-sessions';
import {
  assertLanguageModelHostPermission,
  readPublicTextProviderSettings,
  readTextProviderSettings,
  saveTextProviderSettings,
} from '@extension/settings/text-provider-settings';
import {
  getCookieHeaderForPlatform,
  readBilibiliCookieSnapshot,
} from '@extension/background/cookie-service';
import {
  createErrorResponse,
  WATCH_DECISION_PORT_NAME,
  VIDEO_FOLLOWUP_PORT_NAME,
  VIDEO_TIMELINE_PORT_NAME,
  type ExtensionRequest,
  type ExtensionResponse,
  type VideoFollowupPortMessage,
  type VideoTimelinePortMessage,
  type WatchDecisionPortMessage,
} from '@shared/messages';
import { detectPageContext, type PageContext } from '@shared/page-context';
import type { PlaybackState } from '@shared/playback-state';
import { getEffectiveBaiServiceSettings, type AnalysisMode } from '@shared/settings';
import { createVideoFollowupController } from '@extension/background/video-followup-controller';
import { createVideoTimelineController } from '@extension/background/video-timeline-controller';
import { createWatchDecisionController } from '@extension/background/watch-decision-controller';
import { createTextProviderSettingsHandler } from '@extension/background/handlers/text-provider-settings-handler';
import { createLearningReviewHandler } from '@extension/background/handlers/learning-review-handler';
import { createVideoRuntimeHandler } from '@extension/background/handlers/video-runtime-handler';
import { createPlatformReadHandler } from '@extension/background/handlers/platform-read-handler';
import { createChromeContentScriptBridge } from '@extension/background/services/content-script-bridge';
import { createVideoAnalysisService } from '@extension/background/services/video-analysis-service';
import { createContentContextHandler } from '@extension/background/handlers/content-context-handler';
import { createAnalysisHandler } from '@extension/background/handlers/analysis-handler';
import { getPageContextContentKey } from '@shared/content-key';
import { getBrowserSubtitleLanguages } from '@extension/background/services/browser-language-preferences';

const pageContexts = new Map<number, PageContext>();
const playbackStates = new Map<number, PlaybackState>();
let lastVideoTabId: number | null = null;

// 模块初始化时组装一次依赖；后续消息分发只调用闭包，不重新构造。
const handleTextProviderSettingsMessage = createTextProviderSettingsHandler({
  readSettings: readTextProviderSettings,
  readPublicSettings: readPublicTextProviderSettings,
  saveSettings: saveTextProviderSettings,
  testAuth: async (settings) => {
    await assertLanguageModelHostPermission(settings);
    return createLanguageModelClient(settings).testAuth();
  },
  getBaiServiceQuota: async (settings) => {
    await assertLanguageModelHostPermission(settings);
    return new BaiServiceClient(getEffectiveBaiServiceSettings(settings)).getQuota();
  },
  createErrorResponse,
});
const handleLearningReviewMessage = createLearningReviewHandler({
  getActiveVideoContext,
  readSettings: readTextProviderSettings,
  getContentContext: getCachedContentContext,
  getCachedAnalysis,
  getLearningSession,
  getOrCreateLearningSession,
  updateLearningGoal,
  updateLearningCoach,
  saveLearningGuide,
  saveCachedAnalysis,
  appendLearningMoment,
  updateLearningMoment,
  removeLearningMoment,
  saveLearningMomentCoach,
  saveLearningExchange,
  saveLearningReview,
  generateLearningGuide,
  generateWatchDecisionPackage,
  generateLearningMomentCoach,
  generateLearningReview,
  getSubtitleLanguages: getBrowserSubtitleLanguages,
  createErrorResponse,
});

// Content script 通信与恢复链路统一收敛到生产版 bridge。
const contentScriptBridge = createChromeContentScriptBridge({
  createErrorResponse,
  logWarn: (message: string, ...rest: unknown[]) => console.warn(message, ...rest),
});

// SG-02K：视频分析外部能力（metadata 读取 / YouTube 字幕预取）从
// service-worker 移到 `services/video-analysis-service.ts`。
// handler / timeline controller 通过这个实例拿到能力。
const videoAnalysisService = createVideoAnalysisService({
  fetchYouTubeTranscript: contentScriptBridge.fetchYouTubeTranscript,
  cookieProvider: getCookieHeaderForPlatform,
  logWarn: (message: string, ...rest: unknown[]) => console.warn(message, ...rest),
  getSubtitleLanguages: getBrowserSubtitleLanguages,
});

// 模块初始化时组装一次依赖；后续消息分发只调用闭包，不重新构造。
// 缓存读写闭包捕获模块级 pageContexts / playbackStates / lastVideoTabId，
// 与 service-worker 其它 case 共享同一份状态。
const handleVideoRuntimeMessage = createVideoRuntimeHandler({
  // 页面上下文
  writePageContext: (tabId, context) => {
    pageContexts.set(tabId, context);
  },
  deletePlayback: (tabId) => {
    playbackStates.delete(tabId);
  },
  isSupportedVideoContext,
  setLastVideoTabId: (tabId) => {
    lastVideoTabId = tabId;
  },
  resolveCurrentPageContext: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return typeof tab?.id === 'number' ? getContextForTab(tab) : null;
  },
  // 播放状态
  readCachedPlayback: (tabId) => playbackStates.get(tabId) ?? null,
  writePlayback: (tabId, state) => {
    playbackStates.set(tabId, state);
  },
  getCurrentVideoTabId,
  readPlaybackFromTab: contentScriptBridge.readPlaybackState,
  getActiveTabId: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return typeof tab?.id === 'number' ? tab.id : null;
  },
  seek: contentScriptBridge.seekVideo,
  createErrorResponse,
  now: () => Date.now(),
});

// 模块初始化时组装一次依赖；后续消息分发只调用闭包，不重新构造。
// content context 领域：编排 storage、metadata、字幕预取、字幕抓取、cookie、时钟；
// handler 不调用 chrome.*、不持有状态。
const handleContentContextMessage = createContentContextHandler({
  // **单次**查询 active tab → 同时返回 (tabId, PageContext)。
  // PREPARE 整个流程用同一个 tabId，避免"两次查询之间用户切标签页"的竞态。
  resolveCurrentPage: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number') return null;
    return { tabId: tab.id, context: getContextForTab(tab) };
  },
  deriveContentKey: (context) =>
    getPageContextContentKey(context) ?? `${context.platform}:${context.videoId}`,
  storage: {
    getCachedContentContext,
    saveContentContext,
  },
  getSubtitleLanguages: getBrowserSubtitleLanguages,
  fetchMetadataForContext: videoAnalysisService.fetchMetadataForContext,
  maybeFetchYouTubeTranscript: videoAnalysisService.maybeFetchYouTubeTranscript,
  fetchSubtitlesForTimeline,
  cookieProvider: getCookieHeaderForPlatform,
  now: () => Date.now(),
  createErrorResponse,
});

// 模块初始化时组装一次依赖；后续消息分发只调用闭包，不重新构造。
// analysis 领域：REQUEST_ANALYSIS / REQUEST_TIMELINE / GET_CACHED_ANALYSIS 共享同一 handler。
// 工厂不调用 chrome.*、不持有全局状态；page 解析 / settings 读取 / 缓存读写 / 字幕预取
// / analyzeVideo / cookie / saveCachedAnalysis 全部经依赖注入。
const handleAnalysisMessage = createAnalysisHandler({
  // **单次**查询 active tab → 同时返回 (tabId, PageContext)。
  // REQUEST_ANALYSIS / REQUEST_TIMELINE 整个流程用同一个 tabId，避免
  // "两次查询之间用户切标签页"的竞态。
  resolveCurrentPage: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number') return null;
    return { tabId: tab.id, context: getContextForTab(tab) };
  },
  // GET_CACHED_ANALYSIS 走另一个 dep（只关心 platform/videoId/contentKey）。
  getActiveVideoContext,
  readTextProviderSettings,
  deriveContentKey: (context) =>
    getPageContextContentKey(context) ?? `${context.platform}:${context.videoId}`,
  analysisModeToSourceMode: requestedAnalysisModeToSourceMode,
  getCachedAnalysis,
  maybeFetchYouTubeTranscript: videoAnalysisService.maybeFetchYouTubeTranscript,
  analyzeVideo,
  cookieProvider: getCookieHeaderForPlatform,
  saveCachedAnalysis,
  getSubtitleLanguages: getBrowserSubtitleLanguages,
  createErrorResponse,
});

// 模块初始化时组装一次依赖；后续消息分发只调用闭包，不重新构造。
// 字幕抓取与 cookie 读取复用 service-worker 现有的 helper
// （getCurrentVideoTabId / contentScriptBridge.fetchYouTubeTranscript / readBilibiliCookieSnapshot），
// handler 不调用 chrome.*、不持有状态。
const handlePlatformReadMessage = createPlatformReadHandler({
  getCurrentVideoTabId,
  fetchTranscriptFromTab: contentScriptBridge.fetchYouTubeTranscript,
  readBilibiliCookieSnapshot,
  createErrorResponse,
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ---------------------------------------------------------------------------
// 视频追问流式 Port（追问 MVP）
// ---------------------------------------------------------------------------
//
// side panel 用 chrome.runtime.connect({ name: VIDEO_FOLLOWUP_PORT_NAME })
// 拿到一个长连接 port。所有 chunk / done / error 都从这个 port 推回。
//
// 为什么不用 runtime.sendMessage + 长 sendResponse：MV3 的 sendMessage 适合短
// RPC，长时间持锁容易出"端口释放前用户切视频"的串流问题。Port 是显式长连接，
// 关闭 / 切视频时 side panel 主动 disconnect。

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === WATCH_DECISION_PORT_NAME) {
    const controller = createWatchDecisionController({
      getActiveVideoContext,
      readSettings: readTextProviderSettings,
      getContentContext: getCachedContentContext,
      getCachedAnalysis,
      getOrCreateLearningSession,
      saveCachedAnalysis,
      saveLearningGuide,
      getSubtitleLanguages: getBrowserSubtitleLanguages,
      createErrorResponse,
      postMessage: (message) => safePostMessageWatchDecision(port, message),
    });

    port.onMessage.addListener((raw: unknown) => {
      const message = raw as WatchDecisionPortMessage;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'REQUEST_WATCH_DECISION_PACKAGE') {
        void controller.handleRequest({
          requestId: message.requestId,
          ...(message.analysisMode ? { analysisMode: message.analysisMode } : {}),
          ...(message.forceRefresh === true ? { forceRefresh: true } : {}),
          ...(message.outputLocale ? { outputLocale: message.outputLocale } : {}),
        });
        return;
      }
      if (message.type === 'CANCEL_WATCH_DECISION_PACKAGE') {
        controller.handleCancel({ requestId: message.requestId });
      }
    });

    port.onDisconnect.addListener(() => {
      controller.handleDisconnect();
    });
    return;
  }

  if (port.name === VIDEO_FOLLOWUP_PORT_NAME) {
    const controller = createVideoFollowupController({
      resolveActiveVideoContext: resolveActiveVideoContextForFollowup,
      createTextProviderClient: createLanguageModelClient,
      getSubtitleLanguages: getBrowserSubtitleLanguages,
      postMessage: (message) => safePostMessage(port, message),
    });

    port.onMessage.addListener((raw: unknown) => {
      const message = raw as VideoFollowupPortMessage;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'ASK_VIDEO_QUESTION') {
        void controller.handleAsk({
          requestId: message.requestId,
          question: message.question,
          includeCurrentSegment: message.includeCurrentSegment,
          ...(typeof message.currentTime === 'number' ? { currentTime: message.currentTime } : {}),
          ...(typeof message.selectedTimestamp === 'number'
            ? { selectedTimestamp: message.selectedTimestamp }
            : {}),
          ...(message.forceCurrentSegment === true ? { forceCurrentSegment: true } : {}),
          ...(message.answerBasis ? { answerBasis: message.answerBasis } : {}),
          ...(message.answerLocale ? { answerLocale: message.answerLocale } : {}),
          ...(message.analysisMode ? { analysisMode: message.analysisMode } : {}),
          ...(message.conversationHistory && message.conversationHistory.length > 0
            ? { conversationHistory: message.conversationHistory }
            : {}),
        });
        return;
      }
      if (message.type === 'CANCEL_VIDEO_QUESTION') {
        controller.handleCancel({ requestId: message.requestId });
      }
    });

    port.onDisconnect.addListener(() => {
      controller.handleDisconnect();
    });
    return;
  }

  if (port.name === VIDEO_TIMELINE_PORT_NAME) {
    // Round 24 必修 A2：时间线流式 Port 路由。
    // side panel 用 chrome.runtime.connect({ name: VIDEO_TIMELINE_PORT_NAME })
    // 拿到端口，REQUEST_VIDEO_TIMELINE 走流式。
    const controller = createVideoTimelineController({
      resolveActiveVideoContext: () => resolveActiveVideoContextForTimeline(),
      fetchMetadataForContext: videoAnalysisService.fetchMetadataForContext,
      prefetchYouTubeTranscript: ({ context, analysisMode, subtitleLanguages }) =>
        videoAnalysisService.maybeFetchYouTubeTranscriptLite({
          context,
          tabId: getActiveTabIdSync(),
          analysisMode,
          ...(subtitleLanguages ? { subtitleLanguages } : {}),
        }),
      getSubtitleLanguages: getBrowserSubtitleLanguages,
      // Round 29A QA 必修 A #5：时间线生成路径也透传 cookieProvider
      // （**不**破坏 YouTube 路径；B 站 fallback 路径带登录态）。
      cookieProvider: getCookieHeaderForPlatform,
      createTextProviderClient: createLanguageModelClient,
      postMessage: (message) => safePostMessageTimeline(port, message),
    });

    port.onMessage.addListener((raw: unknown) => {
      const message = raw as VideoTimelinePortMessage;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'REQUEST_VIDEO_TIMELINE') {
        void controller.handleRequest({
          requestId: message.requestId,
          analysisMode: message.analysisMode,
          ...(message.forceRefresh === true ? { forceRefresh: true } : {}),
          ...(message.outputLocale ? { outputLocale: message.outputLocale } : {}),
        });
        return;
      }
      if (message.type === 'CANCEL_VIDEO_TIMELINE') {
        controller.handleCancel({ requestId: message.requestId });
      }
    });

    port.onDisconnect.addListener(() => {
      controller.handleDisconnect();
    });
    return;
  }
});

function safePostMessage(port: chrome.runtime.Port, message: VideoFollowupPortMessage): void {
  try {
    port.postMessage(message);
  } catch (error) {
    // port 关闭后 postMessage 会抛；静默忽略
    if (import.meta.env.DEV) {
      console.warn('[bAI] video-followup port postMessage 失败：', error);
    }
  }
}

function safePostMessageWatchDecision(
  port: chrome.runtime.Port,
  message: WatchDecisionPortMessage,
): void {
  try {
    port.postMessage(message);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[bAI] watch-decision port postMessage 失败：', error);
    }
  }
}

/** 时间线 Port 派发（与 followup 的 safePostMessage 镜像）。 */
function safePostMessageTimeline(
  port: chrome.runtime.Port,
  message: VideoTimelinePortMessage,
): void {
  try {
    port.postMessage(message);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[bAI] video-timeline port postMessage 失败：', error);
    }
  }
}

async function resolveActiveVideoContextForFollowup(): Promise<{
  readonly context: PageContext | null;
  readonly currentTime: number | null;
}> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== 'number') {
    return { context: null, currentTime: null };
  }
  const context = getContextForTab(tab);
  const playback = playbackStates.get(tab.id) ?? null;
  return { context, currentTime: playback?.currentTime ?? null };
}

/** 时间线 controller 用的 active video context（不需 currentTime）。 */
async function resolveActiveVideoContextForTimeline(): Promise<PageContext | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== 'number') {
    return null;
  }
  return getContextForTab(tab);
}

/** 时间线 controller 用的 active tab id（port listener 是 sync 调用）。 */
function getActiveTabIdSync(): number {
  return lastVideoTabId ?? -1;
}

chrome.runtime.onMessage.addListener(
  (request: ExtensionRequest, sender, sendResponse: (response: ExtensionResponse) => void) => {
    handleMessage(request, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse(createErrorResponse('UNEXPECTED_ERROR', message));
      });

    return true;
  },
);

async function handleMessage(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  switch (request.type) {
    case 'PING':
      return { ok: true, type: 'PONG' };

    case 'PAGE_DETECTED':
    case 'GET_CURRENT_PAGE':
    case 'PLAYBACK_PROGRESS':
    case 'GET_PLAYBACK_STATE':
    case 'SEEK_ACTIVE_VIDEO':
      // 当前视频标签页运行态消息委托给独立 handler；handler 只接受窄类型。
      return handleVideoRuntimeMessage(request, sender.tab?.id ?? null);

    case 'FETCH_YOUTUBE_TRANSCRIPT':
      // 平台能力读取消息委托给独立 handler；handler 只接受窄类型。
      return handlePlatformReadMessage(request);

    case 'REQUEST_ANALYSIS':
    case 'REQUEST_TIMELINE':
    case 'GET_CACHED_ANALYSIS':
      // analysis 领域消息委托给独立 handler；handler 只接受窄类型。
      // 共享 page 解析 / settings 读取 / 缓存读写 / 字幕预取 / analyzeVideo，
      // REQUEST_ANALYSIS 与 REQUEST_TIMELINE 之间的 cache key / prefetch mode 差异由
      // handler 内部的 `kind` 参数分支处理。
      return handleAnalysisMessage(request);

    case 'PREPARE_CONTENT_CONTEXT':
      // content context 领域消息委托给独立 handler；handler 只接受窄类型。
      return handleContentContextMessage(request);

    case 'GET_CACHED_CONTENT_CONTEXT':
      return handleContentContextMessage(request);

    case 'UPDATE_LEARNING_GOAL':
    case 'UPDATE_LEARNING_COACH':
    case 'GENERATE_LEARNING_GUIDE':
    case 'ADD_LEARNING_MOMENT':
    case 'UPDATE_LEARNING_MOMENT':
    case 'REMOVE_LEARNING_MOMENT':
    case 'PROCESS_LEARNING_MOMENT':
    case 'SAVE_LEARNING_EXCHANGE':
    case 'GENERATE_LEARNING_REVIEW':
    case 'GET_LEARNING_SESSION':
      return handleLearningReviewMessage(request);

    case 'GET_TEXT_PROVIDER_SETTINGS':
    case 'SAVE_TEXT_PROVIDER_SETTINGS':
    case 'TEST_TEXT_PROVIDER_AUTH':
    case 'GET_BAI_SERVICE_QUOTA':
      // 文本 Provider 设置消息由专用 handler 处理；handler 只接受窄类型，
      // 其它 type 由 service-worker 顶层 switch 分流。
      return handleTextProviderSettingsMessage(request);

    case 'GET_BILIBILI_COOKIES':
      // 平台能力读取消息委托给独立 handler；handler 只接受窄类型。
      return handlePlatformReadMessage(request);

    default:
      return createErrorResponse('UNKNOWN_MESSAGE', '未知消息类型');
  }
}

/**
 * `contentKey` 是 B 站多 P 隔离的"内容身份 key"（B 站 `<BV>:p=<page>` / YouTube
 * `videoId`），缓存 / 追问 / 标注 / 反思的 storage 全部按 contentKey 隔离。
 * `videoId` 仍保留在返回结构里（用于不需 contentKey 区分的纯平台 video ID 场景
 * 比如 exportRecords）。
 */
async function getActiveVideoContext(): Promise<{
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly contentKey: string;
} | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const context = typeof tab?.id === 'number' ? getContextForTab(tab) : null;

  if (
    !context ||
    !(context.platform === 'bilibili' || context.platform === 'youtube') ||
    !context.videoId
  ) {
    return null;
  }

  const contentKey = getPageContextContentKey(context) ?? `${context.platform}:${context.videoId}`;

  return {
    platform: context.platform,
    videoId: context.videoId,
    contentKey,
  };
}

async function getCurrentVideoTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (typeof tab?.id === 'number') {
    const context = getContextForTab(tab);
    if (context && isSupportedVideoContext(context)) {
      return tab.id;
    }
  }

  if (typeof lastVideoTabId === 'number') {
    try {
      await chrome.tabs.get(lastVideoTabId);
      return lastVideoTabId;
    } catch {
      lastVideoTabId = null;
    }
  }

  return null;
}

function getContextForTab(tab: chrome.tabs.Tab): PageContext | null {
  const cachedContext = typeof tab.id === 'number' ? (pageContexts.get(tab.id) ?? null) : null;
  const context = resolveTabContext({
    tabUrl: tab.url,
    tabTitle: tab.title,
    cachedContext,
  });

  if (typeof tab.id === 'number' && context) {
    pageContexts.set(tab.id, context);
  }

  return context;
}

export function resolveTabContext(input: {
  readonly tabUrl?: string | undefined;
  readonly tabTitle?: string | undefined;
  readonly cachedContext?: PageContext | null;
}): PageContext | null {
  try {
    if (!input.tabUrl) {
      return input.cachedContext ?? null;
    }

    const context = detectPageContext(input.tabUrl, input.tabTitle ?? '');

    if (context.platform === 'unknown') {
      return input.cachedContext ?? null;
    }

    return context;
  } catch {
    return input.cachedContext ?? null;
  }
}

function isSupportedVideoContext(context: PageContext): boolean {
  return (
    (context.platform === 'bilibili' || context.platform === 'youtube') && Boolean(context.videoId)
  );
}

function requestedAnalysisModeToSourceMode(mode: AnalysisMode) {
  if (mode === 'subtitle') {
    return 'subtitle' as const;
  }
  return undefined;
}
