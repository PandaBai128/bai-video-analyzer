import type { UiLocale } from '@shared/locale-settings';

export type VideoPlatform = 'bilibili' | 'youtube';

/**
 * Round 29A 必修 A：内容底座（contentContext）类型。
 *
 * 设计原则（来自 SPEC.md "一个内容底座，多种派生产物" + docs/09-decisions.md ADR-012）：
 * - 内容底座只存"未加工的内容事实"（metadata + 字幕/转写 cues），**不**存派生产物。
 * - 派生产物（timelineAnalysis / followupSession / reviewAnalysis）**引用**底座。
 * - 用户只点 `提问` 时，**不**应被强制走时间线生成。
 *
 * 关键不变量：
 * - `contentKey` 沿用 `getVideoMetadataContentKey` / `getPageContextContentKey` 规则
 *   （B 站多 P 隔离、YouTube videoId 隔离）
 * - `transcriptCues` 是大文本的唯一存储点；`analysisCache.transcriptCues` 是
 *   旧链路副本，本轮**不**删除但**不**再写（不再从旧副本迁移）
 * - `kind: 'video'` 暂存 video 页；文章页 `kind: 'article'` 留到下轮
 */
export type ContentContextKind = 'video';

export type TranscriptSource = 'official' | 'asr' | 'page' | 'unknown';

export interface ContentContext {
  readonly schemaVersion: number;
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly videoId: string;
  readonly kind: ContentContextKind;
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly transcriptCueCount: number;
  readonly transcriptSource: TranscriptSource;
  readonly language?: string;
  /** 生成这份字幕时生效的浏览器语言偏好 key。 */
  readonly subtitlePreferenceKey?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Round 29A 必修 D：追问后端新增错误码。当追问只有 contentContext、没有
 * analysisCache 时**不**返回 `ANALYSIS_REQUIRED`（会暗示"需要先生成时间线"），
 * 改返回 `CONTENT_CONTEXT_REQUIRED`（提示"需要先开启当前视频内容"）。
 *
 * 不加进 `AdapterErrorCode`（那是 adapter 层错误码），仅用于追问流式链路
 * 错误响应（背景通过 postError 自由传字符串）。
 */
export const CONTENT_CONTEXT_REQUIRED_ERROR_CODE = 'CONTENT_CONTEXT_REQUIRED';

/**
 * Round 29A 必修 B：内容上下文不可用错误码。字幕为空 / 抓不到时返回这个
 * 错误码 + 清晰文案，让 UI 能区分"未开启"（"开启提问" CTA）vs
 * "无字幕"（提示当前公开版需要视频字幕）。
 */
export const NO_CONTENT_CONTEXT_ERROR_CODE = 'NO_CONTENT_CONTEXT';

/**
 * Round 29A 必修 A：内容底座缓存 schema 版本号。
 *
 * 当前版本 = 13（v12 是 contentContexts 表引入版本）。
 * - v13 将字幕偏好写入 contentContext；旧记录没有可靠的字幕语言选择，全部失效。
 * - analysisCache 旧副本不再迁移回 contentContext。
 * - 老 Dexie 数据**不**会被新 schema 主动清理；过期的 contentContext（如果有
 *   schemaVersion 不匹配）会在读取时按 null 处理。
 */
export const CONTENT_CONTEXT_SCHEMA_VERSION = 13;

export type AdapterErrorCode =
  | 'INVALID_URL'
  | 'NETWORK_ERROR'
  | 'API_ERROR'
  | 'NO_SUBTITLE'
  | 'PARSE_ERROR'
  | 'LLM_ERROR';

export interface AdapterError {
  readonly code: AdapterErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type Result<T, E = AdapterError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface AnalysisTiming {
  readonly label: string;
  readonly durationMs: number;
}

export interface AnalysisDebug {
  readonly label: string;
  readonly model: string;
  readonly content: string;
  readonly contentLength: number;
}

export interface SubtitleDiagnostics {
  readonly source: 'adapter' | 'page';
  readonly trackLabel?: string;
  readonly cueCount: number;
  readonly preview: readonly string[];
  readonly matchedTerms: readonly string[];
  readonly titleTerms: readonly string[];
  readonly consistencyScore: number;
}

export interface VideoMetadata {
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly url: string;
  readonly title: string;
  readonly author: string;
  readonly duration?: number;
  readonly thumbnailUrl?: string;
  readonly publishedAt?: number;
  readonly description?: string;
  readonly platformChapters?: readonly VideoPlatformChapter[];
  readonly platformSpecific?: Record<string, unknown>;
}

export interface VideoPlatformChapter {
  readonly title: string;
  readonly start: number;
  readonly end?: number;
}

export interface SubtitleTrack {
  readonly language: string;
  readonly label: string;
  readonly url: string;
  readonly source: 'official' | 'asr' | 'unknown';
}

export interface SubtitleCue {
  readonly start: number;
  readonly end?: number;
  readonly text: string;
}

export const TIMELINE_CONTENT_TAGS = [
  'concept',
  'method',
  'demo',
  'case',
  'tool',
  'setup',
  'comparison',
  'experience',
  'summary',
  'troubleshooting',
  'transition',
  'ad',
] as const;

export type TimelineContentTag = (typeof TIMELINE_CONTENT_TAGS)[number];

export interface TimelineNode {
  readonly id?: string;
  readonly timestamp: number;
  readonly endTimestamp?: number;
  readonly title: string;
  readonly summary: string;
  readonly importance: 'must-watch' | 'recommended' | 'optional' | 'skip';
  readonly contentTag?: TimelineContentTag;
  readonly reasoning?: string;
  readonly watchPrompt?: string;
  readonly sourceCueRange?: SourceCueRange;
}

export interface VideoChapter {
  readonly id?: string;
  readonly timestamp: number;
  readonly endTimestamp?: number;
  readonly title: string;
  readonly summary: string;
  readonly importance: 'must-watch' | 'recommended' | 'optional' | 'skip';
  readonly contentTag?: TimelineContentTag;
  readonly watchGuide: string;
  readonly reflectionPrompt?: string;
  readonly segments: readonly TimelineNode[];
  readonly sourceCueRange?: SourceCueRange;
}

export interface SourceCueRange {
  readonly startCueId: number;
  readonly endCueId: number;
}

export interface QuoteNode {
  readonly timestamp: number;
  readonly text: string;
}

export interface KeyConcept {
  readonly term: string;
  readonly explanation: string;
}

export interface VideoAnalysis {
  readonly outputLocale?: UiLocale;
  readonly overview: string;
  readonly watchStrategy: readonly string[];
  readonly coreTakeaways: readonly string[];
  readonly reviewSummary: string;
  readonly chapters: readonly VideoChapter[];
  readonly timeline: readonly TimelineNode[];
  readonly quotes: readonly QuoteNode[];
  readonly keyConcepts: readonly KeyConcept[];
  /** 兼容旧缓存，导看和深度反思后续再回到主 UI。 */
  readonly inspirations: readonly string[];
  readonly generatedAt: number;
  readonly modelUsed: string;
  readonly sourceMode: 'subtitle' | 'transcript' | 'multimodal';
  readonly contextDigest?: string;
  readonly timelineDigest?: string;
}

/**
 * Round 24 必修 D：旧"边看边记"片段记录能力废弃。`UserAnnotation` 仍在
 * `@core/types` 留 stub（避免破坏 markdown-exporter 等仍引用它的文件——它们的
 * 入参已经被标注为"deprecated by Round 24"），实际新增 UI / handler 都不再
 * 创建或读取该类型。
 *
 * 字段保留是为了让旧缓存 / 旧 reflection session storage 数据 schema 不破：
 * Dexie 表 `annotations` 已删除（见 `@core/storage/db.ts` Round 24 必修 D
 * migration），但如果旧 Dexie 数据残留 `UserAnnotation` 对象，反序列化仍
 * 能解析（只是不再被新代码使用）。
 *
 * 后续若重做"提问 → 笔记"流程里的片段记录数据形态，再基于新语义扩展。
 * 留接口不破坏。
 */
export interface UserAnnotation {
  readonly id: string;
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly timestamp: number;
  readonly content: string;
  readonly createdAt: number;
}

export type LearningReviewMode = 'adaptive' | 'understand' | 'apply' | 'challenge';

export type LearningMomentKind = 'note' | 'insight' | 'question' | 'action';
export type LearningMomentSource = 'manual' | 'mentor_card';

export type LearningCoachIntensity = 'off' | 'light' | 'deep';

export interface LearningGoal {
  readonly mode: LearningReviewMode;
  readonly focus: string;
  readonly guideOptionId?: string;
  readonly label?: string;
  readonly instruction?: string;
}

export interface LearningCoachSettings {
  readonly enabled: boolean;
  readonly intensity: LearningCoachIntensity;
  readonly customInstruction: string;
}

export type LearningGuideDecisionRating = 'worth_watching' | 'selective' | 'quick_browse' | 'skip';
export type LearningGuideValueTag =
  | 'must_watch'
  | 'watch'
  | 'skim'
  | 'skip'
  | 'uncertain'
  | 'case'
  | 'method'
  | 'ad';

export interface LearningGuideDecisionSegment {
  readonly nodeId?: string;
  readonly title: string;
  readonly tag: LearningGuideValueTag;
  readonly reason: string;
  readonly startTimestamp?: number;
  readonly endTimestamp?: number;
}

export interface LearningGuideTimePlan {
  readonly budget: '10min' | '20min' | '40min' | 'full';
  readonly label: string;
  readonly instruction: string;
  readonly segments: readonly LearningGuideDecisionSegment[];
}

export type LearningGuideValueProfileKind =
  | 'learning_tutorial'
  | 'interview_qa'
  | 'opinion_commentary'
  | 'product_review'
  | 'news_context'
  | 'entertainment_reaction'
  | 'gameplay_walkthrough'
  | 'mixed';

export interface LearningGuideValueCriterion {
  readonly label: string;
  readonly score: number;
  readonly reason: string;
}

export interface LearningGuideValueProfile {
  readonly kind: LearningGuideValueProfileKind;
  readonly label: string;
  readonly criteria: readonly LearningGuideValueCriterion[];
}

export interface LearningGuideDecision {
  readonly rating: LearningGuideDecisionRating;
  readonly score: number;
  readonly valueProfile: LearningGuideValueProfile;
  readonly verdict: string;
  readonly overallMeaning: string;
  readonly reason: string;
  readonly worthReasons?: readonly string[];
  readonly bestFor: readonly string[];
  readonly notFor: readonly string[];
  readonly learningValue?: readonly string[];
  readonly timePlans: readonly LearningGuideTimePlan[];
  readonly mustWatch: readonly LearningGuideDecisionSegment[];
  readonly canWatch: readonly LearningGuideDecisionSegment[];
  readonly canSkim: readonly LearningGuideDecisionSegment[];
  readonly canSkip: readonly LearningGuideDecisionSegment[];
  readonly reservations: readonly string[];
}

export interface LearningGuide {
  readonly outputLocale?: UiLocale;
  readonly decision: LearningGuideDecision;
  readonly contentType: string;
  readonly contentTypeReason: string;
  readonly suggestedStance: string;
  readonly generatedAt: number;
  readonly modelUsed: string;
  readonly generationDurationMs?: number;
  readonly contextDigest?: string;
  readonly timelineDigest?: string;
}

export interface LearningMomentCoach {
  readonly response: string;
  readonly handling: 'keep' | 'ask' | 'verify' | 'apply' | 'release';
  readonly suggestedQuestions: readonly string[];
  readonly nextAction?: string;
  readonly linkedTimestamps: readonly {
    readonly timestamp: number;
    readonly reason: string;
  }[];
  readonly generatedAt: number;
  readonly modelUsed: string;
}

export interface LearningMoment {
  readonly id: string;
  readonly kind: LearningMomentKind;
  readonly content: string;
  readonly source?: LearningMomentSource;
  readonly originTitle?: string;
  readonly timestamp?: number;
  readonly coach?: LearningMomentCoach;
  readonly createdAt: number;
}

export interface LearningExchange {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  /**
   * 用户明确选择“加入笔记”的问答才会参与学习笔记生成。
   * 未标记的普通问答不写入学习会话，避免长期缓存膨胀。
   */
  readonly includedInReview?: boolean;
  readonly createdAt: number;
}

export interface LearningReviewKeyIdea {
  readonly title: string;
  readonly explanation: string;
  readonly evidenceTimestamp?: number;
}

export interface LearningReview {
  readonly outputLocale?: UiLocale;
  readonly coreSummary: string;
  readonly keyIdeas: readonly LearningReviewKeyIdea[];
  /**
   * “我可以带走的收获”：AI 基于视频主动提炼，并用用户记录 / 加入笔记问答提高权重。
   * 不能编造用户已经做过、想过或经历过的事情。
   */
  readonly personalInsights: readonly string[];
  /**
   * “我可以根据这个做什么”：把收获迁移到用户自己的学习 / 工作流里。
   * 可选是为了兼容已保存的旧学习笔记。
   */
  readonly transferReflection?: string;
  readonly openQuestions: readonly string[];
  readonly actionItems: readonly string[];
  readonly finalReflection: string;
  readonly generatedAt: number;
  readonly modelUsed: string;
  readonly contextDigest?: string;
  readonly timelineDigest?: string;
}

/**
 * 单个视频的一次学习轨迹。`videoId` 字段沿用旧表命名，但存储身份必须使用
 * contentKey，从而隔离 B 站多 P。
 */
export interface LearningSession {
  readonly id: string;
  readonly schemaVersion: number;
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly goal: LearningGoal;
  readonly coach: LearningCoachSettings;
  readonly guide?: LearningGuide;
  readonly guidesByLocale?: Partial<Record<UiLocale, LearningGuide>>;
  readonly moments: readonly LearningMoment[];
  readonly exchanges: readonly LearningExchange[];
  readonly review?: LearningReview;
  readonly reviewsByLocale?: Partial<Record<UiLocale, LearningReview>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const LEARNING_SESSION_SCHEMA_VERSION = 3;
