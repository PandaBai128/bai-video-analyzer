import type { TimelineNode, VideoChapter } from '@core/types';
import type { RawTimelineNode, RawVideoChapter } from './video-analysis-raw-schema';

/**
 * 已通过 raw schema 且已完成 cue 映射的数据 → 最终领域结果结构。
 *
 * 职责范围：
 * - 顶层 timeline 节点 → TimelineNode 归一化。
 * - 章节 → VideoChapter 归一化 + segment fallback。
 * - chapters 存在时 timeline 仅来自 chapters.flatMap(segments)；
 *   chapters 缺失时用顶层 timeline 兜底拆 4 段。
 * - overview / reviewSummary / watchStrategy fallback + chapter watchGuide fallback。
 * - 排序和范围修复复用 timeline-normalize.ts。
 *
 * 不负责：
 * - JSON 字符串修复 / fence 剥离：video-analysis-json-repair
 * - 重复顶层 key 合并：duplicate-top-level-keys
 * - Zod schema 与字段映射：video-analysis-raw-schema
 * - 错误文案与 raw response 诊断：video-analysis-json-repair
 */

export function normalizeTimelineNode(node: RawTimelineNode): TimelineNode {
  let normalized: TimelineNode = {
    timestamp: node.timestamp,
    title: node.title,
    summary: node.summary,
    importance: node.importance,
  };

  if (node.contentTag) {
    normalized = { ...normalized, contentTag: node.contentTag };
  }

  if (typeof node.endTimestamp === 'number') {
    normalized = { ...normalized, endTimestamp: node.endTimestamp };
  }

  if (node.reasoning) {
    normalized = { ...normalized, reasoning: node.reasoning };
  }

  if (node.watchPrompt) {
    normalized = { ...normalized, watchPrompt: node.watchPrompt };
  }

  return normalized;
}

/**
 * 章节归一化。fallbackTimeline 之前用于补全 chapter.segments，现在改用 chapter
 * 自身信息生成 fallback segment（保留旧行为，不让 chapter 看起来是空的）。
 */
export function normalizeChapter(
  chapter: RawVideoChapter,
  _fallbackTimeline: readonly TimelineNode[],
): VideoChapter {
  const segments = chapter.segments.length > 0
    ? chapter.segments.map(normalizeTimelineNode)
    : [];
  const normalizedSegments = segments.length > 0 ? segments : [createFallbackSegment(chapter)];
  let normalized: VideoChapter = {
    timestamp: chapter.timestamp,
    title: chapter.title,
    summary: chapter.summary,
    importance: chapter.importance,
    watchGuide: chapter.watchGuide || createChapterWatchGuide(chapter.importance),
    segments: normalizedSegments,
  };

  if (chapter.contentTag) {
    normalized = { ...normalized, contentTag: chapter.contentTag };
  }

  if (typeof chapter.endTimestamp === 'number') {
    normalized = { ...normalized, endTimestamp: chapter.endTimestamp };
  }

  if (chapter.reflectionPrompt) {
    normalized = { ...normalized, reflectionPrompt: chapter.reflectionPrompt };
  }

  return normalized;
}

function createFallbackSegment(chapter: RawVideoChapter): TimelineNode {
  const segment: TimelineNode = {
    timestamp: chapter.timestamp,
    title: chapter.title,
    summary: chapter.summary,
    importance: chapter.importance,
  };

  return {
    ...segment,
    ...(chapter.contentTag ? { contentTag: chapter.contentTag } : {}),
    ...(typeof chapter.endTimestamp === 'number' ? { endTimestamp: chapter.endTimestamp } : {}),
  };
}

/**
 * 顶层 timeline 兜底：把整段 timeline 平均切成 4 个章节（至少 2 个/段）。
 * 章节缺失或为空时返回空数组。
 */
export function createFallbackChaptersFromTimeline(
  timeline: readonly TimelineNode[],
): { chapters: readonly VideoChapter[]; timeline: readonly TimelineNode[] } {
  if (timeline.length === 0) {
    return { chapters: [], timeline: [] };
  }

  const chunkSize = Math.max(2, Math.ceil(timeline.length / 4));
  const chapters: VideoChapter[] = [];

  for (let index = 0; index < timeline.length; index += chunkSize) {
    const segments = timeline.slice(index, index + chunkSize);
    const first = segments[0];

    if (!first) {
      continue;
    }

    const last = segments[segments.length - 1];
    const chapter: VideoChapter = {
      timestamp: first.timestamp,
      title: first.title,
      summary: segments.map((node) => node.summary).join(' '),
      importance: first.importance,
      ...(first.contentTag ? { contentTag: first.contentTag } : {}),
      watchGuide: createChapterWatchGuide(first.importance),
      segments,
    };

    chapters.push(
      typeof last?.endTimestamp === 'number'
        ? { ...chapter, endTimestamp: last.endTimestamp }
        : chapter,
    );
  }

  return { chapters, timeline };
}

export function createFallbackOverview(
  coreTakeaways: readonly string[],
  chapters: readonly VideoChapter[],
): string {
  if (coreTakeaways.length > 0) {
    return coreTakeaways.slice(0, 2).join(' ');
  }

  return chapters[0]?.summary ?? '已生成视频核心和导航。';
}

export function createFallbackReviewSummary(
  coreTakeaways: readonly string[],
  inspirations: readonly string[],
  chapters: readonly VideoChapter[],
): string {
  if (inspirations.length > 0) {
    return inspirations.join(' ');
  }

  if (coreTakeaways.length > 0) {
    return coreTakeaways.join(' ');
  }

  return chapters.length > 0
    ? chapters.map((chapter) => chapter.summary).join(' ')
    : '当前视频已经生成导航和核心要点，可结合自己的标注继续整理。';
}

export function createFallbackWatchStrategy(chapters: readonly VideoChapter[]): readonly string[] {
  const mustWatch = chapters.find((chapter) => chapter.importance === 'must-watch');

  return [
    mustWatch ? `优先看「${mustWatch.title}」。` : '先看时间线章节，再决定是否展开细分节点。',
    '看到关键段落时暂停想一下：这和自己的问题有什么关系。',
  ];
}

export function createChapterWatchGuide(importance: VideoChapter['importance']): string {
  switch (importance) {
    case 'must-watch':
      return '重点看这一章，先理解主线再看细节。';
    case 'recommended':
      return '建议看这一章，关注它和前后内容的关系。';
    case 'optional':
      return '可以按需看，重点抓对自己有用的部分。';
    case 'skip':
      return '可以快速浏览，除非你对这个话题特别关心。';
  }
}
