import { db, type AnalysisCacheRecord } from './db';
import type {
  AnalysisTiming,
  SubtitleCue,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
  VideoPlatform,
} from '@core/types';
import { getVideoMetadataContentKey } from '@shared/content-key';
import { DEFAULT_UI_LOCALE, getArtifactLocale, type UiLocale } from '@shared/locale-settings';

/**
 * Round 16 必修 1：从 9 升到 10。
 *
 * v10 之前 `AnalysisCacheRecord` 没有 `transcriptCues` 字段，缓存恢复时
 * `VideoContextPackage.transcriptCues` 永远是空数组，`<transcript_cues>` 在
 * prompt 里被替换成"无相关字幕"，模型无法回答"解释当前片段"等需要附近字幕
 * 上下文的问题。
 *
 * Round 22 必修 A3：从 10 升到 11。
 *
 * v11 引入 `contentKey` 字段。B 站多 P（`?p=10` vs `?p=1`）的缓存必须用
 * `${BV}:p=${page}` 隔离；旧缓存没有 contentKey 会被 `getCachedAnalysis` 视为
 * 过期，side panel 提示用户重新分析一次。
 *
 * 升 schema 后旧缓存会被 `getCachedAnalysis()` 视为过期，side panel 触发
 * `restoreCache: true` 失败 → `analysisResult === null` → UI 提示用户
 * "请重新分析"（用户原本就会去点一次重新分析，问题被修复）。
 *
 * 2026-06 时间线精度修正：从 11 升到 12。
 *
 * v11 期间 30 分钟以上视频曾按固定窗口预切章节，40 分钟视频会出现
 * `0:00-5:06 / 5:06-10:12 ...` 这类机械切章。它们会继续污染时间线页、
 * 判断页和提问定位，因此直接让旧分析缓存过期，要求重新生成。
 *
 * 2026-06 同源观看决策包：从 12 升到 13。
 *
 * v12 的判断和时间线仍可能分别由两套上下文生成；旧缓存还会带入机械
 * 字幕证据校准后的时间线。v13 开始，判断和时间线必须由同一次观看决策包
 * 产出，并带 contextDigest / timelineDigest 供调用方校验一致性。
 *
 * 2026-07 中英文适配：从 13 升到 14。
 *
 * 派生产物必须按输出语言隔离缓存，避免英文 UI 命中中文导航 / 分析。
 *
 * 2026-07 字幕偏好适配：从 14 升到 15。
 * 旧分析副本没有记录浏览器字幕偏好，不能证明其中的 cues 是当前语言，全部失效。
 */
const ANALYSIS_CACHE_SCHEMA_VERSION = 15;

export interface CachedAnalysisValue {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis;
  readonly subtitleCueCount: number;
  /**
   * Round 16 必修 1：缓存完整字幕 cue 列表，让追问能拿到原文。v10 之前的缓存
   * 没有此字段，schema 不匹配会直接被 `getCachedAnalysis()` 视为 null。
   *
   * 缺省（undefined）表示 v10 之前的旧缓存正在迁移窗口内，调用方应通过
   * `record.subtitleCueCount > 0` 判断是否有字幕，决定是否走兜底逻辑。
   */
  readonly transcriptCues?: readonly SubtitleCue[];
  /** 生成分析时生效的浏览器字幕语言偏好；旧缓存缺失时不可命中。 */
  readonly subtitlePreferenceKey?: string;
  readonly timings: readonly AnalysisTiming[];
}

/**
 * Round 22 必修 A3：缓存按 contentKey 隔离。
 *
 * 不传 contentKey 时降级到 [platform+videoId] —— 仅用于：
 * - 测试
 * - 旧缓存迁移窗口（schemaVersion < 11 且没 contentKey 的记录**本就不该被
 *   命中**，所以这条降级是兜底）
 */
export async function getCachedAnalysis(input: {
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly contentKey?: string;
  readonly sourceMode?: VideoAnalysis['sourceMode'];
  readonly outputLocale?: UiLocale;
  readonly subtitlePreferenceKey?: string;
}): Promise<CachedAnalysisValue | null> {
  const sourceMode = input.sourceMode;
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  let record: AnalysisCacheRecord | undefined;

  if (input.contentKey) {
    // Round 22 必修 A3：新主索引。
    record = sourceMode
      ? await db.analysisCache
          .where('[platform+contentKey+sourceMode+outputLocale]')
          .equals([input.platform, input.contentKey, sourceMode, outputLocale])
          .first()
      : await db.analysisCache
          .where('[platform+contentKey]')
          .equals([input.platform, input.contentKey])
          .filter((candidate) => getArtifactLocale(candidate.analysis) === outputLocale)
          .first();
  } else {
    // 降级路径：不传 contentKey 时退到旧 [platform+videoId] 索引。
    // Round 22 之前的所有代码都走这条；它和 contentKey 索引不会冲突，因为
    // 旧缓存（schemaVersion < 11）没 contentKey 字段，schema mismatch 直接
    // 被视为过期。
    record = sourceMode
      ? await db.analysisCache
          .where('[platform+videoId+sourceMode]')
          .equals([input.platform, input.videoId, sourceMode])
          .filter((candidate) => getArtifactLocale(candidate.analysis) === outputLocale)
          .first()
      : await db.analysisCache
          .where('[platform+videoId]')
          .equals([input.platform, input.videoId])
          .filter((candidate) => getArtifactLocale(candidate.analysis) === outputLocale)
          .first();
  }

  if (!record) {
    return null;
  }

  if (record.schemaVersion !== ANALYSIS_CACHE_SCHEMA_VERSION) {
    // 旧缓存直接当过期，不返回。
    return null;
  }

  // 防御：即使 schemaVersion 对得上，若 record.contentKey 缺失/不匹配调用方
  // 期望的 contentKey，仍然不命中 —— 防 Dexie 旧索引残留。
  if (input.contentKey && record.contentKey !== input.contentKey) {
    return null;
  }

  if (getArtifactLocale(record.analysis) !== outputLocale) {
    return null;
  }

  if (
    input.subtitlePreferenceKey !== undefined &&
    record.subtitlePreferenceKey !== input.subtitlePreferenceKey
  ) {
    return null;
  }

  return {
    metadata: record.metadata,
    analysis: normalizeCachedAnalysis(record.analysis, record.metadata.duration),
    subtitleCueCount: record.subtitleCueCount,
    ...(record.transcriptCues ? { transcriptCues: record.transcriptCues } : {}),
    ...(record.subtitlePreferenceKey
      ? { subtitlePreferenceKey: record.subtitlePreferenceKey }
      : {}),
    timings: record.timings ?? [],
  };
}

export async function saveCachedAnalysis(input: CachedAnalysisValue): Promise<void> {
  const platform = input.metadata.platform;
  const videoId = input.metadata.videoId;
  // Round 22 必修 A3：contentKey 永远从 metadata 派生，不要让调用方传。
  const contentKey = getVideoMetadataContentKey(input.metadata);
  const sourceMode = input.analysis.sourceMode;
  const outputLocale = getArtifactLocale(input.analysis);
  const now = Date.now();
  const existing = await db.analysisCache
    .where('[platform+contentKey+sourceMode+outputLocale]')
    .equals([platform, contentKey, sourceMode, outputLocale])
    .first();
  const record: AnalysisCacheRecord = {
    id: existing?.id ?? createAnalysisCacheId(platform, contentKey, sourceMode, outputLocale),
    schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
    platform,
    videoId,
    contentKey,
    sourceMode,
    outputLocale,
    metadata: input.metadata,
    analysis: { ...input.analysis, outputLocale },
    subtitleCueCount: input.subtitleCueCount,
    ...(input.transcriptCues ? { transcriptCues: input.transcriptCues } : {}),
    ...(input.subtitlePreferenceKey ? { subtitlePreferenceKey: input.subtitlePreferenceKey } : {}),
    timings: input.timings,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await db.analysisCache.put(record);
}

function createAnalysisCacheId(
  platform: VideoPlatform,
  contentKey: string,
  sourceMode: VideoAnalysis['sourceMode'],
  outputLocale: UiLocale,
): string {
  return `${platform}:${contentKey}:${sourceMode}:${outputLocale}`;
}

function normalizeCachedAnalysis(
  analysis: VideoAnalysis,
  duration: number | undefined,
): VideoAnalysis {
  const timeline = Array.isArray(analysis.timeline) ? analysis.timeline : [];
  const chapters =
    Array.isArray(analysis.chapters) && analysis.chapters.length > 0
      ? analysis.chapters
      : createFallbackChapters(timeline);
  const normalized: VideoAnalysis = {
    ...analysis,
    overview:
      analysis.overview ||
      analysis.coreTakeaways?.slice(0, 2).join(' ') ||
      '已生成视频核心和导航。',
    reviewSummary:
      analysis.reviewSummary ||
      analysis.inspirations?.join(' ') ||
      analysis.coreTakeaways?.join(' ') ||
      '当前视频已经生成导航和核心要点，可结合自己的标注继续整理。',
    watchStrategy:
      Array.isArray(analysis.watchStrategy) && analysis.watchStrategy.length > 0
        ? analysis.watchStrategy
        : [],
    chapters,
  };

  return constrainCachedAnalysisToDuration(normalized, duration);
}

function createFallbackChapters(timeline: readonly TimelineNode[]): readonly VideoChapter[] {
  if (timeline.length === 0) {
    return [];
  }

  const chunkSize = Math.max(2, Math.ceil(timeline.length / 4));
  const chapters: VideoChapter[] = [];

  for (let index = 0; index < timeline.length; index += chunkSize) {
    const segments = timeline.slice(index, index + chunkSize);
    const first = segments[0];

    if (!first) {
      continue;
    }

    const chapter: VideoChapter = {
      timestamp: first.timestamp,
      title: first.title,
      summary: segments.map((node) => node.summary).join(' '),
      importance: first.importance,
      ...(first.contentTag ? { contentTag: first.contentTag } : {}),
      watchGuide: '先按这一组理解主线，再展开细分节点看细节。',
      segments,
    };
    const endTimestamp = segments[segments.length - 1]?.endTimestamp;

    chapters.push(typeof endTimestamp === 'number' ? { ...chapter, endTimestamp } : chapter);
  }

  return chapters;
}

function constrainCachedAnalysisToDuration(
  analysis: VideoAnalysis,
  duration: number | undefined,
): VideoAnalysis {
  if (typeof duration !== 'number' || duration <= 0) {
    return analysis;
  }

  return {
    ...analysis,
    timeline: analysis.timeline
      .filter((node) => node.timestamp <= duration)
      .map((node) => ({
        ...node,
        ...(typeof node.endTimestamp === 'number'
          ? { endTimestamp: Math.min(Math.max(node.endTimestamp, node.timestamp), duration) }
          : {}),
      })),
    chapters: analysis.chapters
      .filter((chapter) => chapter.timestamp <= duration)
      .map((chapter) => ({
        ...chapter,
        ...(typeof chapter.endTimestamp === 'number'
          ? { endTimestamp: Math.min(Math.max(chapter.endTimestamp, chapter.timestamp), duration) }
          : {}),
        segments: chapter.segments
          .filter((node) => node.timestamp <= duration)
          .map((node) => ({
            ...node,
            ...(typeof node.endTimestamp === 'number'
              ? { endTimestamp: Math.min(Math.max(node.endTimestamp, node.timestamp), duration) }
              : {}),
          })),
      })),
    quotes: analysis.quotes.filter((quote) => quote.timestamp <= duration),
  };
}
