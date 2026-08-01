import { BilibiliAdapter, YouTubeAdapter, type VideoAdapter } from '@core/adapters';
import { createLanguageModelClient } from '@core/llm/language-model-factory';
import type { LanguageModelChatResult, LanguageModelClient } from '@core/llm/language-model-client';
import { buildVideoTimelinePrompt } from '@core/prompts/video-timeline';
import type {
  Result,
  AnalysisDebug,
  AnalysisTiming,
  SubtitleCue,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
  VideoPlatform,
} from '@core/types';
import type { PageContext } from '@shared/page-context';
import type { TextProviderSettings } from '@shared/settings';
import { getActiveTextModel } from '@shared/settings';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import { parseVideoAnalysisJson } from './video-analysis-schema';
import { createModelAnalysisTimingLabel } from './timing-labels';
import { alignAnalysisToPlatformChapters } from './platform-chapter-alignment';

const adapters: readonly VideoAdapter[] = [new BilibiliAdapter(), new YouTubeAdapter()];

/**
 * 给指定平台返回拼好的 `Cookie:` 头。返回 `null` 表示该平台不需要 / 没有登录态。
 * core 层不直接读 chrome.cookies，由 service-worker 注入。
 */
export type CookieProvider = (platform: VideoPlatform) => Promise<string | null>;

export interface AnalyzeVideoInput {
  readonly context: PageContext;
  readonly settings: TextProviderSettings;
  readonly outputLocale?: UiLocale;
  readonly usageFeature?: 'analysis' | 'navigation';
  readonly cookieProvider?: CookieProvider;
  /** 浏览器字幕语言偏好，由 extension 层读取后注入。 */
  readonly subtitleLanguages?: readonly string[];
  /**
   * content script 预先抓好的 YouTube 字幕（YouTube 快速分析主路）。
   * 传入时跳过 YouTubeAdapter 的 watch HTML + fmt=json3 路径，**避免**拿不到 caption body。
   * 其它平台 / fallback 路径不传。
   */
  readonly prefetchedTranscript?: YouTubePrefetchedTranscript;
}

/**
 * YouTube 字幕预取结果：metadata + cue 列表 + 抓取阶段耗时。
 * 由 background 把 content script 返回的 YOUTUBE_TRANSCRIPT 翻译成这个结构。
 */
export interface YouTubePrefetchedTranscript {
  readonly metadata: VideoMetadata;
  readonly cues: readonly SubtitleCue[];
  readonly source?: 'official' | 'asr' | 'unknown';
  readonly language?: string;
  /** content script 返回的抓取阶段耗时（如 dom_panel / parse_dom）。 */
  readonly timings?: readonly { readonly stage: string; readonly durationMs: number }[];
}

export interface AnalyzeVideoResult {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis;
  readonly subtitleCueCount: number;
  /**
   * Round 16 必修 1：缓存完整字幕 cue 列表，让追问能拿到原文（之前只存
   * `subtitleCueCount`，导致 `VideoContextPackage.transcriptCues` 永远是空数组，
   * `<transcript_cues>` 在 prompt 里被替换成"无相关字幕"，模型无法回答）。
   *
   * 字幕不可用时不设置或填空数组均可，语义清楚。
   */
  readonly transcriptCues?: readonly SubtitleCue[];
  readonly timings: readonly AnalysisTiming[];
  readonly debug?: AnalysisDebug;
}

export async function analyzeVideo(input: AnalyzeVideoInput): Promise<Result<AnalyzeVideoResult>> {
  const timings: AnalysisTiming[] = [];
  const totalStartedAt = Date.now();
  const adapter = findAdapter(input.context.url);

  if (!adapter) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: '当前页面不是已支持的视频平台',
        retryable: false,
      },
    };
  }

  const metadataStartedAt = Date.now();
  await injectCookie(adapter, input.cookieProvider);
  // YouTube 快速分析主路：prefetchedTranscript 已经带了当前页面解析出的 metadata。
  // 标题 / 作者 / 时长都来自当前页面，比 oEmbed 更准。此时直接用，不再走 fetchMetadata。
  const metadata = input.prefetchedTranscript
    ? ({ ok: true, value: input.prefetchedTranscript.metadata } as const)
    : await adapter.fetchMetadata(input.context.url);
  timings.push(createTiming('读取视频信息', metadataStartedAt));

  if (!metadata.ok) {
    return metadata;
  }

  const textClient = createLanguageModelClient(input.settings);

  const subtitleStartedAt = Date.now();
  const subtitlesResult: Result<readonly SubtitleCue[]> = input.prefetchedTranscript
    ? { ok: true, value: input.prefetchedTranscript.cues }
    : await collectSubtitleCues(adapter, metadata.value.url, input.subtitleLanguages);
  timings.push(createTiming('读取字幕', subtitleStartedAt));

  if (input.prefetchedTranscript?.timings) {
    // 合并 content script 抓字幕的阶段耗时，如 dom_panel / parse_dom。
    for (const attempt of input.prefetchedTranscript.timings) {
      timings.push({
        label: `字幕预取 · ${attempt.stage}`,
        durationMs: attempt.durationMs,
      });
    }
  }

  if (!subtitlesResult.ok) {
    return subtitlesResult;
  }

  // Round 23 必修 B1：subtitle 路径的"分析"现在只生成时间线。
  // 复盘（要点 + 整体总结）由后续按需单独生成，**不**和这条路径一起跑。
  return analyzeTimelineFromSubtitles({
    metadata: metadata.value,
    subtitles: subtitlesResult.value,
    client: textClient,
    settings: input.settings,
    outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE,
    ...(input.usageFeature ? { usageFeature: input.usageFeature } : {}),
    timings,
    totalStartedAt,
    sourceMode: 'subtitle',
  });
}

/**
 * Round 23 必修 B1：从字幕生成"时间线"（不再生成复盘）。
 *
 * 与 `analyzeVideo()` 的关系：
 * - 抽出来是为了让 `REQUEST_TIMELINE` 消息路径直接复用，不重复抓字幕
 * - 复盘（要点 / 整体总结）字段在 prompt 层已不再要求生成
 * - 解析层仍然解析出 VideoAnalysis envelope，**但** coreTakeaways / reviewSummary /
 *   inspirations / watchStrategy / quotes / keyConcepts 在 timeline-only prompt 下都是
 *   兜底空值（parseVideoAnalysisJson 不强制要求 LLM 输出）
 *
 * 验收（AGENT_HANDOFF 必修 C）：
 * - 点击 `生成导航` 只跑导航 prompt
 * - 不生成 reviewSummary 的 LLM 内容（VideoAnalysis.reviewSummary 走兜底逻辑）
 * - 旧缓存如含 reviewSummary，恢复时**不**被误当作本轮新复盘（sidepanel 时间线 tab
 *   不展示 reviewSummary）
 */
export async function analyzeTimelineFromSubtitles(input: {
  readonly metadata: VideoMetadata;
  readonly subtitles: readonly SubtitleCue[];
  readonly client: LanguageModelClient;
  readonly settings: TextProviderSettings;
  readonly outputLocale?: UiLocale;
  readonly usageFeature?: 'analysis' | 'navigation';
  readonly timings: AnalysisTiming[];
  readonly totalStartedAt: number;
  readonly sourceMode?: Extract<VideoAnalysis['sourceMode'], 'subtitle'>;
}): Promise<Result<AnalyzeVideoResult>> {
  const sourceMode = input.sourceMode ?? 'subtitle';
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  if (input.subtitles.length === 0) {
    return {
      ok: false,
      error: {
        code: 'NO_SUBTITLE',
        message: '当前视频没有可用字幕。稳定导航需要字幕。',
        retryable: false,
      },
    };
  }

  const subtitleTextLength = input.subtitles.reduce(
    (total, cue) => total + cue.text.trim().length,
    0,
  );

  if (input.subtitles.length < 8 || subtitleTextLength < 120) {
    return {
      ok: false,
      error: {
        code: 'NO_SUBTITLE',
        message: `当前字幕内容不足或不可信（${input.subtitles.length} 条，${subtitleTextLength} 字）。稳定导航需要足够字幕。`,
        retryable: false,
      },
    };
  }

  try {
    const llmStartedAt = Date.now();
    const activeModel = getActiveTextModel(input.settings);
    const response = await input.client.chat(
      [
        {
          role: 'user',
          content: buildVideoTimelinePrompt({
            metadata: input.metadata,
            subtitles: input.subtitles,
            outputLocale,
          }),
        },
      ],
      { model: activeModel, usageFeature: input.usageFeature ?? 'navigation' },
    );
    input.timings.push(createTiming(createModelAnalysisTimingLabel(activeModel), llmStartedAt));

    const parseStartedAt = Date.now();
    const parsedAnalysis = parseVideoAnalysisJson({
      content: response.content,
      modelUsed: response.model,
      sourceMode,
      // Round 23 必修 B2：把字幕 cue 列表传进 parser，让 startCueId /
      // endCueId 能映射回真实时间戳。模型只给 timestamp 时不传也行（fallback）。
      subtitles: input.subtitles,
      rawResponse: response.rawResponse,
    });
    const analysis = constrainAnalysisToDuration(
      alignAnalysisToPlatformChapters({
        analysis: { ...parsedAnalysis, outputLocale },
        platformChapters: input.metadata.platformChapters,
        duration: input.metadata.duration,
      }),
      input.metadata.duration,
    );
    input.timings.push(createTiming('解析分析结果', parseStartedAt));
    input.timings.push(createTiming('总耗时', input.totalStartedAt));

    return {
      ok: true,
      value: {
        metadata: input.metadata,
        analysis,
        subtitleCueCount: input.subtitles.length,
        transcriptCues: input.subtitles,
        timings: input.timings,
        debug: createDebugOutput('模型分析原始输出', response),
      },
    };
  } catch (error) {
    return createLlmError(error);
  }
}

export function findAdapter(url: string): VideoAdapter | null {
  return adapters.find((adapter) => adapter.match(url)) ?? null;
}

async function injectCookie(
  adapter: VideoAdapter,
  provider: CookieProvider | undefined,
): Promise<void> {
  if (!provider || !adapter.setCookieHeader) {
    return;
  }
  const header = await provider(adapter.platform);
  adapter.setCookieHeader(header);
}

async function collectSubtitleCues(
  adapter: VideoAdapter,
  videoUrl: string,
  languages?: readonly string[],
): Promise<Result<readonly SubtitleCue[]>> {
  const tracks = await adapter.fetchSubtitleTracks(videoUrl, languages);

  if (!tracks.ok) {
    return tracks;
  }

  for (const track of tracks.value) {
    const cues = await adapter.fetchSubtitleCues(track);

    if (cues.ok && cues.value.length > 0) {
      return cues;
    }
  }

  return { ok: true, value: [] };
}

function createDebugOutput(label: string, response: LanguageModelChatResult): AnalysisDebug {
  return {
    label,
    model: response.model,
    content: response.content,
    contentLength: response.content.length,
  };
}

function createTiming(label: string, startedAt: number): AnalysisTiming {
  return {
    label,
    durationMs: Date.now() - startedAt,
  };
}

function constrainAnalysisToDuration(
  analysis: VideoAnalysis,
  duration: number | undefined,
): VideoAnalysis {
  if (typeof duration !== 'number' || duration <= 0) {
    return analysis;
  }

  const timeline = analysis.timeline
    .filter((node) => node.timestamp <= duration)
    .map((node) => constrainTimelineNode(node, duration));
  const chapters = analysis.chapters
    .filter((chapter) => chapter.timestamp <= duration)
    .map((chapter) => constrainChapter(chapter, duration));

  return {
    ...analysis,
    chapters,
    timeline,
    quotes: analysis.quotes.filter((quote) => quote.timestamp <= duration),
  };
}

function constrainTimelineNode(node: TimelineNode, duration: number): TimelineNode {
  const timestamp = Math.min(node.timestamp, duration);
  const endTimestamp =
    typeof node.endTimestamp === 'number'
      ? Math.min(Math.max(node.endTimestamp, timestamp), duration)
      : undefined;
  const base: TimelineNode = {
    timestamp,
    title: node.title,
    summary: node.summary,
    importance: node.importance,
  };

  return {
    ...base,
    ...(node.contentTag ? { contentTag: node.contentTag } : {}),
    ...(typeof endTimestamp === 'number' ? { endTimestamp } : {}),
    ...(node.reasoning ? { reasoning: node.reasoning } : {}),
    ...(node.watchPrompt ? { watchPrompt: node.watchPrompt } : {}),
  };
}

function constrainChapter(chapter: VideoChapter, duration: number): VideoChapter {
  const timestamp = Math.min(chapter.timestamp, duration);
  const endTimestamp =
    typeof chapter.endTimestamp === 'number'
      ? Math.min(Math.max(chapter.endTimestamp, timestamp), duration)
      : undefined;
  const constrained: VideoChapter = {
    timestamp,
    title: chapter.title,
    summary: chapter.summary,
    importance: chapter.importance,
    ...(chapter.contentTag ? { contentTag: chapter.contentTag } : {}),
    watchGuide: chapter.watchGuide,
    segments: chapter.segments
      .filter((node) => node.timestamp <= duration)
      .map((node) => constrainTimelineNode(node, duration)),
  };

  return {
    ...constrained,
    ...(typeof endTimestamp === 'number' ? { endTimestamp } : {}),
    ...(chapter.reflectionPrompt ? { reflectionPrompt: chapter.reflectionPrompt } : {}),
  };
}

function createLlmError(error: unknown): Result<never> {
  return {
    ok: false,
    error: {
      code: 'LLM_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    },
  };
}
