import type { PageContext } from './page-context';
import type { PlaybackState } from './playback-state';
import type {
  AnalysisMode,
  BaiServiceQuotaSnapshot,
  LegacyAnalysisMode,
  TextProviderSettings,
  PublicTextProviderSettings,
} from './settings';
import type { UiLocale } from './locale-settings';
import type {
  AnalysisDebug,
  AnalysisTiming,
  ContentContext,
  LearningExchange,
  LearningCoachSettings,
  LearningGoal,
  LearningMomentKind,
  LearningMomentSource,
  LearningSession,
  SubtitleCue,
  TimelineContentTag,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
} from '@core/types';
import type { WatchDecisionStreamPreview } from '@core/learning/watch-decision-stream-preview';
import type {
  YouTubePageCaptionTrack,
  YouTubeTranscriptAttempt,
  YouTubeTranscriptError,
  YouTubeTranscriptResult,
} from './youtube-transcript';

/**
 * 提问时的"回答依据"枚举。
 *
 * - `video_only`：仅依据视频上下文（当前默认 / 历史行为）；缺失字段在 Port 边界归一化为此值。
 * - `video_plus_general`：视频上下文 + 模型通识知识；不允许冒充联网，仍围绕当前视频。
 * - `video_plus_web`：视频上下文 + MiniMax 联网搜索结果；联网补充必须带来源链接。
 */
export type FollowupAnswerBasis = 'video_only' | 'video_plus_general' | 'video_plus_web';

/**
 * 跨 Port 边界传输的轻量对话历史。
 *
 * 故意只保留 role / content 两项：UI 用的 id / createdAt / streaming /
 * error 都是 sidepanel 本地状态，不应该也不需要跨 Port 传到 background。
 * background 不持有 session 状态 —— Chrome service worker 会被回收，
 * 历史必须随请求传入。
 */
export interface FollowupConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type ExtensionRequest =
  | { type: 'PING' }
  | { type: 'PAGE_DETECTED'; payload: PageContext }
  | { type: 'GET_CURRENT_PAGE' }
  | { type: 'SEEK_ACTIVE_VIDEO'; payload: { seconds: number } }
  | { type: 'PLAYBACK_PROGRESS'; payload: PlaybackState }
  | { type: 'GET_PLAYBACK_STATE' }
  /**
   * Round 27 QA2 必修 C：content script 主动读当前 video 元素的播放状态。
   * - 背景：side panel `GET_PLAYBACK_STATE` 只读 background 缓存；如果 content
   *   还没发下一次 `PLAYBACK_PROGRESS`（SPA 切视频 / 刚刷新页面 / 刚打开 side
   *   panel），缓存可能空或过期。
   * - 解决：background 在缓存缺失或过期时，向 active tab content 发送本消息，
   *   content **立即**从 `HTMLVideoElement` 读 `currentTime / duration / paused`
   *   并用 `PLAYBACK_STATE` 响应（同时复用 `sendPlaybackProgress()` 写回缓存）。
   * - content 找不到 video 时响应 `payload: null`，不报错。
   */
  | { type: 'READ_ACTIVE_VIDEO_PLAYBACK' }
  | {
      type: 'FETCH_YOUTUBE_TRANSCRIPT';
      payload: {
        videoId: string;
        languages?: readonly string[];
        pageCaptionTracks?: readonly YouTubePageCaptionTrack[];
      };
    }
  | {
      type: 'REQUEST_ANALYSIS';
      payload?: {
        analysisMode?: LegacyAnalysisMode;
        forceRefresh?: boolean;
        outputLocale?: UiLocale;
      };
    }
  | {
      /**
       * Round 23 必修 C：单独跑"时间线"。
       * - 不再要求 LLM 生成 coreTakeaways / reviewSummary / inspirations（prompt 已删）
       * - cache key 仍按 contentKey + sourceMode 隔离（与 REQUEST_ANALYSIS 共用缓存）
       * - 旧 `REQUEST_ANALYSIS` 仍兼容，新 UI 主推 REQUEST_TIMELINE
       */
      type: 'REQUEST_TIMELINE';
      payload?: {
        analysisMode?: LegacyAnalysisMode;
        forceRefresh?: boolean;
        outputLocale?: UiLocale;
      };
    }
  | {
      type: 'GET_CACHED_ANALYSIS';
      payload?: { analysisMode?: LegacyAnalysisMode; outputLocale?: UiLocale };
    }
  /**
   * Round 29A 必修 B：准备内容上下文。
   * - 只抓 metadata + 字幕/转写 cues，**不**调用 MiniMax / LLM。
   * - 缓存命中（`!forceRefresh`）时**不**重复抓字幕，直接返回缓存。
   * - 字幕不可用时返回 `NO_CONTENT_CONTEXT` 错误。
   * - 成功返回 `CONTENT_CONTEXT` payload（完整 ContentContext）。
   */
  | {
      type: 'PREPARE_CONTENT_CONTEXT';
      payload?: { forceRefresh?: boolean };
    }
  /**
   * Round 29A 必修 B：按 `(platform, contentKey)` 读 contentContext。
   * - 纯缓存读取，**不**调用 LLM，**不**抓字幕。
   * - 用于页面挂载 / 切视频时恢复底座。
   * - 返回 `null` 表示无缓存（调用方按"需要准备"处理）。
   */
  | { type: 'GET_CACHED_CONTENT_CONTEXT' }
  | {
      type: 'UPDATE_LEARNING_GOAL';
      payload: LearningGoal;
    }
  | {
      type: 'UPDATE_LEARNING_COACH';
      payload: LearningCoachSettings;
    }
  | {
      type: 'GENERATE_LEARNING_GUIDE';
      payload?: {
        forceRefresh?: boolean;
        analysisMode?: LegacyAnalysisMode;
        outputLocale?: UiLocale;
      };
    }
  | {
      type: 'ADD_LEARNING_MOMENT';
      payload: {
        kind: LearningMomentKind;
        content: string;
        source?: LearningMomentSource;
        originTitle?: string;
        timestamp?: number;
      };
    }
  | {
      type: 'UPDATE_LEARNING_MOMENT';
      payload: {
        momentId: string;
        kind: LearningMomentKind;
        content: string;
      };
    }
  | {
      type: 'REMOVE_LEARNING_MOMENT';
      payload: { momentId: string };
    }
  | {
      type: 'PROCESS_LEARNING_MOMENT';
      payload: { momentId: string; analysisMode?: LegacyAnalysisMode };
    }
  | {
      type: 'SAVE_LEARNING_EXCHANGE';
      payload: LearningExchange;
    }
  | {
      type: 'GENERATE_LEARNING_REVIEW';
      payload?: {
        forceRefresh?: boolean;
        analysisMode?: LegacyAnalysisMode;
        outputLocale?: UiLocale;
      };
    }
  | { type: 'GET_LEARNING_SESSION' }
  | { type: 'GET_TEXT_PROVIDER_SETTINGS' }
  | { type: 'SAVE_TEXT_PROVIDER_SETTINGS'; payload: TextProviderSettings }
  | { type: 'TEST_TEXT_PROVIDER_AUTH'; payload?: TextProviderSettings }
  | { type: 'GET_BAI_SERVICE_QUOTA'; payload?: TextProviderSettings }
  | { type: 'GET_BILIBILI_COOKIES' }
  /**
   * 视频追问（流式）。注意：流式响应通过 Port 推（`video-followup`），不通过
   * `sendMessage` 的 `sendResponse` 返回——MV3 不适合长连接式 `sendResponse`。
   *
   * `requestId` 由 side panel 生成，background 把同名 requestId 的 chunk / done
   * 推回 side panel。用户切视频时请求会继续运行并写回原 context 快照；用户关闭
   * side panel / 主动停止 / 再次提问时，旧 requestId 的响应会在 background 或
   * side panel 任一端被丢弃。
   */
  | {
      type: 'ASK_VIDEO_QUESTION';
      payload: {
        requestId: string;
        question: string;
        includeCurrentSegment: boolean;
        currentTime?: number;
        selectedTimestamp?: number;
        /**
         * Round 17 必修 A：固定问题（"解释当前片段"）携带的强制锚点。
         * 为 true 时跳过意图识别直接走 current_segment。
         */
        forceCurrentSegment?: boolean;
        /**
         * 回答依据。side panel 缺省 / 字段缺失时由 background 归一化为
         * `'video_only'`（保持历史严格行为）。提交瞬间快照，避免流式期间
         * 切换影响已发送请求。
         */
        answerBasis?: FollowupAnswerBasis;
        /**
         * 回答语言由提问语言决定：中文问中文答，英文问英文答。
         * 与 UI 语言、字幕语言解耦。
         */
        answerLocale?: UiLocale;
        /**
         * 跨 Port 边界传输的对话历史（最近 ≤ 3 轮 / 6000 字）。
         * 缺失字段按空历史处理；不为空时 prompt 会在 <video_context> 之前
         * 渲染 <conversation_history> 块。
         *
         * 仅用于"它 / 我问的是 / 那缺点呢"等指代 / 纠正 / 延续型短追问。
         * 视频事实仍必须来自 <video_context>，历史**不**是视频证据。
         */
        conversationHistory?: readonly FollowupConversationMessage[];
      };
    }
  | {
      /** 取消进行中的流式追问。side panel 在主动停止 / 关闭 / 再次提问时发。 */
      type: 'CANCEL_VIDEO_QUESTION';
      payload: { requestId: string };
    };

export interface BilibiliCookiesPayload {
  readonly header: string | null;
  readonly loggedIn: boolean;
  readonly capturedNames: readonly string[];
}

export interface YouTubeTranscriptResponsePayload {
  readonly result: YouTubeTranscriptResult;
  readonly attempts: readonly YouTubeTranscriptAttempt[];
}

export type ExtensionResponse =
  | { ok: true; type: 'PONG' }
  | { ok: true; type: 'PAGE_CONTEXT'; payload: PageContext | null }
  | { ok: true; type: 'PLAYBACK_STATE'; payload: PlaybackState | null }
  | {
      ok: true;
      type: 'YOUTUBE_TRANSCRIPT';
      payload: YouTubeTranscriptResponsePayload;
    }
  | { ok: false; type: 'YOUTUBE_TRANSCRIPT_FAILED'; error: YouTubeTranscriptError }
  | {
      ok: true;
      type: 'ANALYSIS_RESULT';
      payload: {
        metadata: VideoMetadata;
        analysis: VideoAnalysis;
        subtitleCueCount: number;
        transcriptCues?: readonly SubtitleCue[];
        timings: readonly AnalysisTiming[];
        debug?: AnalysisDebug;
      };
    }
  | {
      ok: true;
      type: 'CACHED_ANALYSIS';
      payload: {
        metadata: VideoMetadata;
        analysis: VideoAnalysis;
        subtitleCueCount: number;
        transcriptCues?: readonly SubtitleCue[];
        timings: readonly AnalysisTiming[];
        debug?: AnalysisDebug;
      } | null;
    }
  /**
   * Round 29A 必修 B：内容底座响应。
   * - `ok: true` + `CONTENT_CONTEXT` payload = 成功
   * - `ok: false` + `code: 'NO_CONTENT_CONTEXT'` = 字幕不可用
   * - `ok: false` + `code: 'NO_ACTIVE_TAB' | 'NO_PAGE_CONTEXT'` = 上下文未识别
   */
  | { ok: true; type: 'CONTENT_CONTEXT'; payload: ContentContext }
  | { ok: true; type: 'CACHED_CONTENT_CONTEXT'; payload: ContentContext | null }
  | { ok: true; type: 'LEARNING_SESSION'; payload: LearningSession | null }
  | { ok: true; type: 'TEXT_PROVIDER_SETTINGS'; payload: PublicTextProviderSettings }
  | { ok: true; type: 'TEXT_PROVIDER_AUTH_TEST'; payload: { message: string; latencyMs: number } }
  | { ok: true; type: 'BAI_SERVICE_QUOTA'; payload: BaiServiceQuotaSnapshot }
  | { ok: true; type: 'BILIBILI_COOKIES'; payload: BilibiliCookiesPayload }
  | { ok: true; type: 'DONE' }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export function createErrorResponse(code: string, message: string): ExtensionResponse {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

/**
 * 视频追问流式 Port 的名称。side panel 与 background 都要用这个常量。
 */
export const VIDEO_FOLLOWUP_PORT_NAME = 'video-followup';

/**
 * Round 24 必修 A1：时间线流式 Port 名称。
 *
 * 必须独立于追问 port：
 * - 时间线需要 abort 旧 requestId 切换新视频/新模式时不影响追问流
 * - 时间线 chunk 是原始 JSON 片段，语义和追问 answer 文本不同
 * - 追问走 video-followup / 时间线走 video-timeline 两条 Port 共存
 */
export const VIDEO_TIMELINE_PORT_NAME = 'video-timeline';

/**
 * 同源观看判断包进度 Port 名称。
 *
 * 它独立于旧 video-timeline Port：判断包一次生成 judgment + timeline，不能退回
 * “判断一套、时间线一套”的旧链路；Port 只负责展示阶段、耗时和最终保存结果。
 */
export const WATCH_DECISION_PORT_NAME = 'watch-decision';

export type WatchDecisionPortMessage =
  | {
      readonly type: 'REQUEST_WATCH_DECISION_PACKAGE';
      readonly requestId: string;
      readonly analysisMode?: LegacyAnalysisMode;
      readonly forceRefresh?: boolean;
      readonly outputLocale?: UiLocale;
    }
  | {
      readonly type: 'CANCEL_WATCH_DECISION_PACKAGE';
      readonly requestId: string;
    }
  | {
      readonly type: 'WATCH_DECISION_STATUS';
      readonly requestId: string;
      readonly text: string;
    }
  | {
      readonly type: 'WATCH_DECISION_CHUNK';
      readonly requestId: string;
      readonly text: string;
      readonly receivedCharacters: number;
    }
  | {
      readonly type: 'WATCH_DECISION_PREVIEW';
      readonly requestId: string;
      readonly preview: WatchDecisionStreamPreview;
    }
  | {
      readonly type: 'WATCH_DECISION_DONE';
      readonly requestId: string;
      readonly session: LearningSession | null;
      readonly elapsedMs: number;
      readonly receivedCharacters: number;
      readonly reused?: boolean;
    }
  | {
      readonly type: 'WATCH_DECISION_ERROR';
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
    };

/**
 * Round 24 必修 A1：时间线流式 Port 上推送的消息类型。
 *
 * 与 video-followup 设计对称（每个消息都带 requestId）：
 * - side panel 据此忽略旧 requestId 的响应
 * - 同一时间 background 端只允许一个 active requestId；新 requestId
 *   进来时旧 requestId 会被 abort + 不再 yield chunk
 *
 * status 阶段消息：`STATUS` 推阶段文本（"正在读取字幕"等）
 * partial 阶段消息：`PARTIAL` 推 JSONL 解析后的结构化事件（overview / chapter / segment）
 * chunk 阶段消息：`CHUNK` 推 LLM 增量文本（**Round 24 QA2 已废弃**：不再推给 UI，
 *   旧 UI 收到也只是调 parseVideoAnalysisJson 走 fallback；新版 controller
 *   只在用户开调试折叠时**才**推 chunk）
 * done/error：流结束 / 业务错误
 */
export type VideoTimelinePortMessage =
  | {
      readonly type: 'REQUEST_VIDEO_TIMELINE';
      readonly requestId: string;
      /** 视频分析模式：公开版只支持 subtitle。 */
      readonly analysisMode: AnalysisMode;
      /** true → 跳过缓存强制重新跑 */
      readonly forceRefresh?: boolean;
      /** 导航输出语言：跟随当前 UI 语言。 */
      readonly outputLocale?: UiLocale;
    }
  | {
      readonly type: 'CANCEL_VIDEO_TIMELINE';
      readonly requestId: string;
    }
  | {
      readonly type: 'VIDEO_TIMELINE_STATUS';
      readonly requestId: string;
      /** 阶段描述：'正在读取当前页面' / '正在读取字幕' / '正在识别时间线' / '已切换为普通生成' */
      readonly text: string;
    }
  | {
      /**
       * Round 24 QA2 必修 B：JSONL 流式结构化事件。
       *
       * 推 controller 行 buffer 解析出来的新事件（overview / chapter / segment），
       * 推 `done` 表示流结束。side panel 据此累积 overviewDraft / chapterDraft
       * 然后渲染可读进度。
       *
       * 注意：rawLine 是原始 JSONL 行（**不**含换行），用于调试折叠项。
       * **不**应被 UI 默认渲染（按 handoff §3 必修 A）。
       */
      readonly type: 'VIDEO_TIMELINE_PARTIAL';
      readonly requestId: string;
      readonly event:
        | {
            readonly type: 'overview';
            readonly text: string;
          }
        | {
            readonly type: 'chapter';
            readonly id: string;
            readonly startCueId: number;
            readonly endCueId: number;
            readonly importance?: VideoChapter['importance'];
            readonly contentTag?: TimelineContentTag;
            readonly title: string;
            readonly summary: string;
          }
        | {
            readonly type: 'segment';
            readonly chapterId: string;
            readonly startCueId: number;
            readonly endCueId: number;
            readonly importance?: TimelineNode['importance'];
            readonly contentTag?: TimelineContentTag;
            readonly title: string;
            readonly summary: string;
          }
        | {
            readonly type: 'done';
          };
      /** 原始 JSONL 行（**仅**用于调试折叠项；side panel 默认不渲染）。 */
      readonly rawLine: string;
    }
  | {
      /**
       * Round 24 QA2 必修 A：**调试折叠项**才用的原始 LLM 文本。
       *
       * 历史：旧 controller 推 CHUNK 是为了让 UI 显示"流式预览"。
       * 旧 UI 直接 `<pre>` 展示 → 用户看到一堆 JSON → 产品不合格。
       *
       * 新版：side panel 收到 CHUNK 后**不**渲染到默认 UI，只在调试折叠项里
       * 展示（按 handoff §3 必修 A：默认不允许展示原始 JSON）。
       *
       * 默认使用 JSONL partial 事件；此字段保留是给"高级用户开调试"使用。
       */
      readonly type: 'VIDEO_TIMELINE_CHUNK';
      readonly requestId: string;
      /** LLM 增量文本，可能是单 token 也可能是多 token */
      readonly text: string;
    }
  | {
      readonly type: 'VIDEO_TIMELINE_DONE';
      readonly requestId: string;
    }
  | {
      readonly type: 'VIDEO_TIMELINE_ERROR';
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
    };

/**
 * 视频追问流式 Port 上推送的消息类型。
 *
 * 设计：
 * - 每条消息都带 `requestId`，side panel 据此判断是否忽略旧 requestId 的响应
 * - `chunk` / `reasoningChunk` 都是增量文本，调用方按到达顺序 append
 * - `done` 表示该 requestId 的流结束
 * - `error` 是该 requestId 专属错误，不会破坏其他进行中的请求
 *
 * 关键不变性：
 * - background 端同一时间只允许一个 active requestId；新 requestId 进来时
 *   旧 requestId 会被 abort（abort signal + 在 background 不再 yield 旧 chunk）
 * - side panel 端如果当前 active requestId 变了，旧的 chunk 会被忽略
 */
export type VideoFollowupPortMessage =
  | {
      readonly type: 'ASK_VIDEO_QUESTION';
      readonly requestId: string;
      readonly question: string;
      readonly includeCurrentSegment: boolean;
      readonly currentTime?: number;
      readonly selectedTimestamp?: number;
      /**
       * Round 17 必修 A：固定问题携带的强制锚点。true 时跳过意图识别直接走 current_segment。
       */
      readonly forceCurrentSegment?: boolean;
      /**
       * 回答依据。缺失时由 controller 归一化为 `'video_only'`。
       */
      readonly answerBasis?: FollowupAnswerBasis;
      /**
       * 回答语言由用户当前问题决定，不由视频字幕语言决定。
       */
      readonly answerLocale?: UiLocale;
      /**
       * 跨 Port 边界传输的对话历史；缺失时按空历史处理。
       */
      readonly conversationHistory?: readonly FollowupConversationMessage[];
      /**
       * 当前提问使用的上下文来源。公开版只支持 subtitle；旧值由
       * background 拦截并提示升级/重新保存设置。
       */
      readonly analysisMode?: LegacyAnalysisMode;
    }
  | {
      readonly type: 'CANCEL_VIDEO_QUESTION';
      readonly requestId: string;
    }
  | {
      readonly type: 'VIDEO_ANSWER_CHUNK';
      readonly requestId: string;
      readonly text: string;
    }
  | {
      readonly type: 'VIDEO_ANSWER_REASONING_CHUNK';
      readonly requestId: string;
      readonly text: string;
    }
  | {
      readonly type: 'VIDEO_ANSWER_DONE';
      readonly requestId: string;
    }
  | {
      readonly type: 'VIDEO_ANSWER_ERROR';
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
    };
