import type { SubtitleCue, VideoAnalysis } from '@core/types';
import { mapCueIdsToTimestamps, MissingTimeAnchorError } from './timeline-cue-mapping';
import { normalizeChapterTimelineStructure } from './timeline-normalize';
import { rawVideoAnalysisSchema } from './video-analysis-raw-schema';
import {
  createFallbackChaptersFromTimeline,
  createFallbackOverview,
  createFallbackReviewSummary,
  createFallbackWatchStrategy,
  normalizeChapter,
  normalizeTimelineNode,
} from './video-analysis-normalize-result';
import {
  describeAnchorLocation,
  enhanceJsonParseError,
  parseJsonWithRepair,
  stripJsonFence,
} from './video-analysis-json-repair';

/**
 * 视频分析公共入口 —— 仅承担"管线编排"职责：
 *
 * 1. `stripJsonFence` 剥 markdown fence / 思考标签 / 提取首尾 `{}`。
 * 2. `parseJsonWithRepair` 重复 key 合并 → JSON.parse → jsonrepair → 松散引号修复。
 * 3. `rawVideoAnalysisSchema.parse` 走 Zod 解析 + 默认值填充。
 * 4. `mapCueIdsToTimestamps` 把 startCueId / endCueId 映射回字幕时间戳；
 *    cue id 优先于 timestamp；缺锚点抛 `MissingTimeAnchorError`。
 * 5. normalize-result 编排：chapters 非空 → chapters.flatMap(segments)；
 *    chapters 空 → 顶层 timeline 兜底拆 4 段。
 * 6. 组装最终 `VideoAnalysis`（overview / reviewSummary / watchStrategy fallback）。
 *
 * 内部模块拆在 4 个文件里（raw-schema / normalize-result / json-repair /
 * duplicate-top-level-keys）。本入口保持原公开 API：
 *   - `parseVideoAnalysisJson`
 *   - `stripJsonFence`（re-export）
 *   - `mergeDuplicateTopLevelKeys`（re-export）
 */

export { stripJsonFence } from './video-analysis-json-repair';
export { mergeDuplicateTopLevelKeys } from './duplicate-top-level-keys';

export function parseVideoAnalysisJson(input: {
  readonly content: string;
  readonly modelUsed: string;
  readonly sourceMode: VideoAnalysis['sourceMode'];
  /**
   * 完整字幕 cue 列表。Round 23 必修 B2：用于把模型的 `startCueId` / `endCueId`
   * 映射回真实时间戳（防御"0:39 标成 0:50 才开始的主题"这类提前归纳 bug）。
   * 不传时，cue id 映射跳过，fallback 到模型自报 timestamp（旧 schema 兼容）。
   */
  readonly subtitles?: readonly SubtitleCue[];
  /** 完整响应 JSON，JSON 解析失败时拼到错误信息里方便诊断。 */
  readonly rawResponse?: unknown;
}): VideoAnalysis {
  const jsonText = stripJsonFence(input.content);
  let parsed: ReturnType<typeof rawVideoAnalysisSchema.parse>;
  try {
    parsed = rawVideoAnalysisSchema.parse(parseJsonWithRepair(jsonText));
  } catch (error) {
    throw enhanceJsonParseError(error, jsonText, input.rawResponse);
  }

  // Round 23 必修 B2 + QA 必修 A：把 startCueId / endCueId 映射回字幕时间戳。
  // - cue id 优先于 timestamp（旧 schema 兼容）
  // - 缺 cue id + 缺 timestamp + 无 subtitles → 抛 MissingTimeAnchorError
  //   让上层给出清晰错误（不再 silent 0 / -1）
  let cueMappedChapters: ReturnType<typeof mapCueIdsToTimestamps> = [];
  if (parsed.chapters.length > 0) {
    try {
      cueMappedChapters = mapCueIdsToTimestamps({
        chapters: parsed.chapters.map((chapter) => ({
          timestamp: chapter.timestamp,
          endTimestamp: chapter.endTimestamp,
          title: chapter.title,
          summary: chapter.summary,
          importance: chapter.importance,
          ...(chapter.contentTag ? { contentTag: chapter.contentTag } : {}),
          watchGuide: chapter.watchGuide,
          ...(chapter.reflectionPrompt !== undefined
            ? { reflectionPrompt: chapter.reflectionPrompt }
            : {}),
          startCueId: chapter.startCueId,
          endCueId: chapter.endCueId,
          segments: chapter.segments.map((segment) => ({
            timestamp: segment.timestamp,
            endTimestamp: segment.endTimestamp,
            title: segment.title,
            summary: segment.summary,
            importance: segment.importance,
            ...(segment.contentTag ? { contentTag: segment.contentTag } : {}),
            ...(segment.reasoning !== undefined ? { reasoning: segment.reasoning } : {}),
            ...(segment.watchPrompt !== undefined ? { watchPrompt: segment.watchPrompt } : {}),
            startCueId: segment.startCueId,
            endCueId: segment.endCueId,
          })),
        })),
        ...(input.subtitles && input.subtitles.length > 0 ? { subtitles: input.subtitles } : {}),
      });
    } catch (error) {
      if (error instanceof MissingTimeAnchorError) {
        // 给一个用户/调试都能看懂的错误，包含 JSON 上下文
        throw new Error(
          `模型返回的 JSON 时间依据不完整：${error.message}（位置：${describeAnchorLocation(
            error,
          )}）。`,
        );
      }
      throw error;
    }
  }

  // Round 22 必修 B1：单一 timeline 来源。
  // - chapters.length > 0 → timeline = chapters.flatMap(segments)
  // - chapters.length === 0 → 用顶层 timeline 兜底（拆 4 段）
  // - prompt 已禁止输出顶层 timeline，但解析层防御模型仍输出 timeline
  //   时**不**让顶层 timeline 参与高亮/追问 —— 顶层 timeline 仅作 fallback。
  const normalizedChaptersInput =
    cueMappedChapters.length > 0
      ? cueMappedChapters.map((chapter) => normalizeChapter(chapter, []))
      : [];

  // Round 22 必修 B2：排序 + 范围校验
  const { chapters, timeline } =
    normalizedChaptersInput.length > 0
      ? normalizeChapterTimelineStructure(normalizedChaptersInput)
      : createFallbackChaptersFromTimeline(parsed.timeline.map(normalizeTimelineNode));

  return {
    overview: parsed.overview || createFallbackOverview(parsed.coreTakeaways, chapters),
    watchStrategy:
      parsed.watchStrategy.length > 0
        ? parsed.watchStrategy
        : createFallbackWatchStrategy(chapters),
    coreTakeaways: parsed.coreTakeaways,
    reviewSummary:
      parsed.reviewSummary ||
      createFallbackReviewSummary(parsed.coreTakeaways, parsed.inspirations, chapters),
    chapters,
    timeline,
    quotes: parsed.quotes,
    keyConcepts: parsed.keyConcepts,
    inspirations: parsed.inspirations,
    generatedAt: Date.now(),
    modelUsed: input.modelUsed,
    sourceMode: input.sourceMode,
  };
}
