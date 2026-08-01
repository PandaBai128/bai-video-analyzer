import type { SubtitleCue, TimelineNode, VideoChapter } from '@core/types';
import type { VideoContextPackage } from './video-context-package';
import {
  applyTranscriptFallback,
  pickChaptersCovering,
  pickCuesInRange,
  pickTimelineCovering,
  pickRepresentativeCues,
} from './transcript-sampling';
import { normalizeForMatching } from './followup-query-topic';
import {
  dedupeHitsBySize,
  hasReliableQueryHit,
  pickQuestionMatchCues,
  type ScoredHit,
} from './transcript-retrieval';
import type { FollowupQueryPlan } from './followup-query-topic';

/**
 * 各 scope 的上下文组装 —— 把 pkg + 路由层决策转换成 FollowupContext。
 *
 * 不负责：
 * - 路由决策 / 意图识别 / 时间点解析 / 关键词触发词：select-followup-context + intent-detection
 * - 全字幕检索 / 评分：transcript-retrieval
 * - 全片均匀采样 / 字符预算：transcript-sampling
 */

// ---------------------------------------------------------------------------
// Scope 窗口 / 时间预算常量
// ---------------------------------------------------------------------------

const EXPLICIT_TIME_BEFORE_S = 30;
const EXPLICIT_TIME_AFTER_S = 90;
const CURRENT_SEGMENT_BEFORE_S = 20;
const CURRENT_SEGMENT_AFTER_S = 60;
const KEYWORD_HIT_BEFORE_S = 15;
const KEYWORD_HIT_AFTER_S = 30;
const MAX_KEYWORD_HITS = 8;
const CUE_FALLBACK_MIN = 3;
const CUE_FALLBACK_MAX = 8;
const GLOBAL_CHAPTER_PREVIEW = 4;
const GLOBAL_TIMELINE_PREVIEW = 6;
const TIMELINE_MATCH_CUE_BEFORE_S = 10;
const TIMELINE_MATCH_CUE_AFTER_S = 45;
const MAX_TIMELINE_MATCHES = 6;

// ---------------------------------------------------------------------------
// Explicit time / selected segment / current segment
// ---------------------------------------------------------------------------

export function buildExplicitTimeContext(
  pkg: VideoContextPackage,
  timestamp: number,
): import('./select-followup-context').FollowupContext {
  const range = pickCuesInRange(
    pkg.transcriptCues,
    timestamp - EXPLICIT_TIME_BEFORE_S,
    timestamp + EXPLICIT_TIME_AFTER_S,
  );
  const { cues, fallback } = applyTranscriptFallback(
    pkg.transcriptCues,
    range,
    timestamp,
    CUE_FALLBACK_MIN,
    CUE_FALLBACK_MAX,
  );
  const chapters = pickChaptersCovering(pkg.chapters, timestamp);
  const timeline = pickTimelineCovering(pkg.timeline, timestamp);
  return {
    primaryScope: 'explicit_time',
    selectedTimelineItems: timeline,
    selectedTranscriptCues: cues,
    selectedChapters: chapters,
    reviewSummary: pkg.review.summary,
    overviewLine: pkg.overview,
    anchorTimestamp: timestamp,
    anchorLabel: 'explicit_time',
    ...(fallback ? { transcriptFallback: true } : {}),
  };
}

export function buildSelectedTimestampContext(
  pkg: VideoContextPackage,
  timestamp: number,
): import('./select-followup-context').FollowupContext {
  const exact = pkg.timeline.find((node) => node.timestamp === timestamp);
  const range = pickCuesInRange(
    pkg.transcriptCues,
    timestamp - EXPLICIT_TIME_BEFORE_S,
    timestamp + EXPLICIT_TIME_AFTER_S,
  );
  const { cues, fallback } = applyTranscriptFallback(
    pkg.transcriptCues,
    range,
    timestamp,
    CUE_FALLBACK_MIN,
    CUE_FALLBACK_MAX,
  );
  const chapters = pickChaptersCovering(pkg.chapters, timestamp);
  return {
    primaryScope: 'selected_segment',
    selectedTimelineItems: exact ? [exact] : pickTimelineCovering(pkg.timeline, timestamp),
    selectedTranscriptCues: cues,
    selectedChapters: chapters,
    reviewSummary: pkg.review.summary,
    overviewLine: pkg.overview,
    anchorTimestamp: timestamp,
    anchorLabel: 'selected_timestamp',
    ...(fallback ? { transcriptFallback: true } : {}),
  };
}

export function buildCurrentSegmentContext(
  pkg: VideoContextPackage,
  currentTime: number,
): import('./select-followup-context').FollowupContext {
  // Round 16 必修 1：先按 ±20s/±60s 主窗口取 cue；主窗口为 0 但全视频有 cue
  // 时再扩到 ±90s 重试一次；再失败用"最近的 3-8 条 cue"兜底。
  // prompt 看到 transcriptFallback=true 时标"附近字幕兜底"，不再写"无相关字幕"。
  const range = pickCuesInRange(
    pkg.transcriptCues,
    currentTime - CURRENT_SEGMENT_BEFORE_S,
    currentTime + CURRENT_SEGMENT_AFTER_S,
  );
  const { cues, fallback } = applyTranscriptFallback(
    pkg.transcriptCues,
    range,
    currentTime,
    CUE_FALLBACK_MIN,
    CUE_FALLBACK_MAX,
  );
  const chapters = pickChaptersCovering(pkg.chapters, currentTime);
  const timeline = pickTimelineCovering(pkg.timeline, currentTime);
  return {
    primaryScope: 'current_segment',
    selectedTimelineItems: timeline,
    selectedTranscriptCues: cues,
    selectedChapters: chapters,
    reviewSummary: pkg.review.summary,
    overviewLine: pkg.overview,
    anchorTimestamp: currentTime,
    anchorLabel: 'current_time',
    ...(fallback ? { transcriptFallback: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Keyword match —— "有没有提到 X" 模板触发
// ---------------------------------------------------------------------------

export function buildKeywordContext(
  pkg: VideoContextPackage,
  keyword: string,
): import('./select-followup-context').FollowupContext {
  const normalizedKeyword = normalizeForMatching(keyword);
  if (!isSearchableKeyword(normalizedKeyword)) {
    return {
      primaryScope: 'keyword_match',
      selectedTimelineItems: [],
      selectedTranscriptCues: [],
      selectedChapters: [],
      reviewSummary: pkg.review.summary,
      overviewLine: pkg.overview,
      matchInfo: { keyword, hitCount: 0, hitTimestamps: [] },
    };
  }
  const hitCues: SubtitleCue[] = [];
  const hitTimestamps = new Set<number>();

  for (const cue of pkg.transcriptCues) {
    if (normalizeForMatching(cue.text).includes(normalizedKeyword)) {
      hitCues.push(cue);
      hitTimestamps.add(Math.floor(cue.start));
      if (hitCues.length >= MAX_KEYWORD_HITS) {
        break;
      }
    }
  }

  if (hitCues.length === 0) {
    // 没命中只代表"完整字幕里没有精确字符串"；给少量全局候选供模型判断
    // 是否存在同义 / ASR 错字 / 标题或时间线相关表达，不能直接下"视频没讲"结论。
    return {
      primaryScope: 'keyword_match',
      selectedTimelineItems: pkg.timeline.slice(0, GLOBAL_TIMELINE_PREVIEW),
      selectedTranscriptCues: pickRepresentativeCues(pkg.transcriptCues, pkg.duration),
      selectedChapters: pkg.chapters.slice(0, GLOBAL_CHAPTER_PREVIEW),
      reviewSummary: pkg.review.summary,
      overviewLine: pkg.overview,
      matchInfo: { keyword, hitCount: 0, hitTimestamps: [] },
    };
  }

  // 命中：以命中时间点为中心扩窗（第一个 hit 之前 / 最后一个 hit 之后各扩）
  const firstHit = hitCues[0]!.start;
  const lastHit = hitCues[hitCues.length - 1]!.start;
  const windowCues = pickCuesInRange(
    pkg.transcriptCues,
    firstHit - KEYWORD_HIT_BEFORE_S,
    lastHit + KEYWORD_HIT_AFTER_S,
  );

  const chapterSet = new Set<VideoChapter>();
  for (const cue of hitCues) {
    for (const chapter of pickChaptersCovering(pkg.chapters, cue.start)) {
      chapterSet.add(chapter);
    }
  }
  const timelineSet = new Set<TimelineNode>();
  for (const cue of hitCues) {
    for (const node of pickTimelineCovering(pkg.timeline, cue.start)) {
      timelineSet.add(node);
    }
  }

  return {
    primaryScope: 'keyword_match',
    selectedTimelineItems: [...timelineSet],
    selectedTranscriptCues: windowCues,
    selectedChapters: [...chapterSet],
    reviewSummary: pkg.review.summary,
    overviewLine: pkg.overview,
    matchInfo: {
      keyword,
      hitCount: hitCues.length,
      hitTimestamps: [...hitTimestamps].sort((a, b) => a - b),
    },
  };
}

function isSearchableKeyword(normalizedKeyword: string): boolean {
  return normalizedKeyword.length >= 2 || /^[\u3400-\u9fff]$/u.test(normalizedKeyword);
}

// ---------------------------------------------------------------------------
// Question match —— 普通事实问题的全字幕检索（SG-05B §3）
// ---------------------------------------------------------------------------

/**
 * 普通事实问题检索。`hasReliableQueryHit(scored) === true` 时调用本函数；
 * 否则路由层应回落 global（**不**调用本函数，也**不**返回"完整字幕零命中"否认信号）。
 *
 * 与 keyword_match 的关键差异：
 * - keyword_match 用单一 keyword 做完整字幕精确 substring；hitCount=0 只表示
 *   "字面未命中"，不直接下"视频没讲"结论。
 * - question_match 用完整主题词 substring 评分（FR-01 §3A 单条 + 1-3 条相邻窗口）；
 *   命中 → 输出窗口 + 时间线 / 章节摘要；无命中由路由层兜底，**不**在 prompt
 *   里出现 "未在上下文中提到"。
 *
 * FR-01 §3A 关键修复：
 * - `dedupeHitsBySize` 去重重叠命中：同一位置多窗口命中 → 保留更小窗口。
 * - `matchInfo.hitTimestamps` 基于真实命中窗口时间（`window.startMin`）。
 * - 命中窗口涉及的所有原始 cues 都参与章节 / 时间线收集（不只是代表 cue）。
 */
export function buildQuestionMatchContext(input: {
  readonly pkg: VideoContextPackage;
  readonly scored: readonly ScoredHit[];
  readonly plan: FollowupQueryPlan;
}): import('./select-followup-context').FollowupContext {
  const { pkg, scored, plan } = input;
  if (!hasReliableQueryHit(scored)) {
    // 兜底：调用方应保证 hasReliableQueryHit 为 true；这里给出空结果，路由层用 global 兜底。
    return {
      primaryScope: 'global',
      selectedTimelineItems: pkg.timeline.slice(0, GLOBAL_TIMELINE_PREVIEW),
      selectedTranscriptCues: pickRepresentativeCues(pkg.transcriptCues, pkg.duration),
      selectedChapters: pkg.chapters.slice(0, GLOBAL_CHAPTER_PREVIEW),
      reviewSummary: pkg.review.summary,
      overviewLine: pkg.overview,
      globalContextMode: 'transcript_only',
    };
  }

  // FR-01 §3A：去重重叠命中（更小窗口优先 + 时间升序稳定）
  const deduped = dedupeHitsBySize(scored);
  const topCues = pickQuestionMatchCues(deduped, pkg.transcriptCues);

  // FR-01 §3A：取前 6 个命中窗口，每个窗口的最早 cue.start 作为锚点时间
  const topHits = deduped.slice(0, 6);
  const hitTimestamps = topHits.map((entry) => Math.floor(entry.window.startMin));

  // 命中窗口涉及的所有原始 cues + 章节 / 时间线（与 keyword_match 同款逻辑）
  const topHitCues = topHits.flatMap((entry) => entry.window.cues);
  const chapterSet = new Set<VideoChapter>();
  const timelineSet = new Set<TimelineNode>();
  for (const cue of topHitCues) {
    for (const chapter of pickChaptersCovering(pkg.chapters, cue.start)) {
      chapterSet.add(chapter);
    }
    for (const node of pickTimelineCovering(pkg.timeline, cue.start)) {
      timelineSet.add(node);
    }
  }

  // FR-02 §3 集成接线：matchInfo 写入 matchKind / originalQuestion / keyword
  // - matchKind 取顶层最严格命中（dedupeHitsBySize 已按 matchKind rank 排序，
  //   topHits[0] 是最严格层），保证 prompt 看到的层级准确。
  // - keyword 改为 plan.exactTopic，让 prompt 用 `X` 反引号回引用户主题。
  // - originalQuestion 用 plan.originalQuestion（保留 user 表述，给容错话术
  //   "你说的 X 可能对应字幕里的 Y" 提供原文）。
  const topMatchKind = topHits[0]?.matchKind;

  return {
    primaryScope: 'question_match',
    selectedTimelineItems: [...timelineSet],
    selectedTranscriptCues: topCues,
    selectedChapters: [...chapterSet],
    reviewSummary: pkg.review.summary,
    overviewLine: pkg.overview,
    matchInfo: {
      keyword: plan.exactTopic,
      hitCount: topHitCues.length,
      hitTimestamps,
      ...(topMatchKind !== undefined ? { matchKind: topMatchKind } : {}),
      ...(plan.originalQuestion ? { originalQuestion: plan.originalQuestion } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Timeline match —— 字幕检索未命中，但时间线标题/摘要命中
// ---------------------------------------------------------------------------

export interface TimelineMatchResult {
  readonly timeline: readonly TimelineNode[];
  readonly chapters: readonly VideoChapter[];
}

export function findTimelineMatches(
  pkg: VideoContextPackage,
  topic: string,
): TimelineMatchResult {
  const normalizedTopic = normalizeForMatching(topic);
  if (normalizedTopic.length < 2) {
    return { timeline: [], chapters: [] };
  }

  const timeline = pkg.timeline
    .filter((node) => timelineTextMatchesTopic(node.title, node.summary, normalizedTopic))
    .slice(0, MAX_TIMELINE_MATCHES);
  const chapterSet = new Set<VideoChapter>();

  for (const node of timeline) {
    for (const chapter of pickChaptersCovering(pkg.chapters, node.timestamp)) {
      chapterSet.add(chapter);
    }
  }

  for (const chapter of pkg.chapters) {
    if (timelineTextMatchesTopic(chapter.title, chapter.summary, normalizedTopic)) {
      chapterSet.add(chapter);
    }
    if (chapterSet.size >= MAX_TIMELINE_MATCHES) {
      break;
    }
  }

  return {
    timeline,
    chapters: [...chapterSet].slice(0, MAX_TIMELINE_MATCHES),
  };
}

export function buildTimelineMatchContext(input: {
  readonly pkg: VideoContextPackage;
  readonly topic: string;
  readonly matches: TimelineMatchResult;
}): import('./select-followup-context').FollowupContext {
  const hitTimestamps = [
    ...input.matches.timeline.map((node) => Math.floor(node.timestamp)),
    ...input.matches.chapters.map((chapter) => Math.floor(chapter.timestamp)),
  ]
    .filter((timestamp, index, array) => array.indexOf(timestamp) === index)
    .sort((a, b) => a - b);

  const selectedTranscriptCues = pickTimelineMatchCues(input.pkg, input.matches);

  return {
    primaryScope: 'timeline_match',
    selectedTimelineItems: input.matches.timeline,
    selectedTranscriptCues,
    selectedChapters: input.matches.chapters,
    reviewSummary: input.pkg.review.summary,
    overviewLine: input.pkg.overview,
    matchInfo: {
      keyword: input.topic,
      hitCount: hitTimestamps.length,
      hitTimestamps,
      matchKind: 'exact',
      originalQuestion: input.topic,
    },
  };
}

function timelineTextMatchesTopic(title: string, summary: string, normalizedTopic: string): boolean {
  const normalizedText = normalizeForMatching(`${title} ${summary}`);
  return normalizedText.includes(normalizedTopic);
}

function pickTimelineMatchCues(
  pkg: VideoContextPackage,
  matches: TimelineMatchResult,
): readonly SubtitleCue[] {
  const cueMap = new Map<number, SubtitleCue>();
  for (const node of matches.timeline) {
    for (const cue of pickCuesInRange(
      pkg.transcriptCues,
      node.timestamp - TIMELINE_MATCH_CUE_BEFORE_S,
      (node.endTimestamp ?? node.timestamp) + TIMELINE_MATCH_CUE_AFTER_S,
    )) {
      cueMap.set(cue.start, cue);
    }
  }
  for (const chapter of matches.chapters) {
    for (const cue of pickCuesInRange(
      pkg.transcriptCues,
      chapter.timestamp - TIMELINE_MATCH_CUE_BEFORE_S,
      (chapter.endTimestamp ?? chapter.timestamp) + TIMELINE_MATCH_CUE_AFTER_S,
    )) {
      cueMap.set(cue.start, cue);
    }
  }
  return [...cueMap.values()].sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Global —— 全片均匀采样（SG-05B §4）
// ---------------------------------------------------------------------------

/**
 * 全视频上下文兜底。
 *
 * SG-05B §4：
 * - **删除**"有派生分析就只取前 8 条字幕"逻辑 —— 那是 §1 提到的真实用户 bug。
 * - **统一**：无论 timeline / chapters / review 是否存在，global 都从全片确定性采样，
 *   覆盖开头、中段、结尾。
 * - 派生分析（时间线 + 章节 + 复盘）继续作为补充，**不**再单独走"少量代表性字幕"。
 *
 * prompt 描述与实际输入保持一致 —— `globalContextMode` 标记 `transcript_only`。
 */
export function buildGlobalContext(pkg: VideoContextPackage): import('./select-followup-context').FollowupContext {
  return {
    primaryScope: 'global',
    selectedTimelineItems: pkg.timeline.slice(0, GLOBAL_TIMELINE_PREVIEW),
    selectedTranscriptCues: pickRepresentativeCues(pkg.transcriptCues, pkg.duration),
    selectedChapters: pkg.chapters.slice(0, GLOBAL_CHAPTER_PREVIEW),
    reviewSummary: pkg.review.summary,
    overviewLine: pkg.overview,
    globalContextMode: 'transcript_only',
  };
}

// ---------------------------------------------------------------------------
// 公开辅助（保持原公共 API）
// ---------------------------------------------------------------------------

/**
 * 判断 pkg 是否含有派生分析结果（时间线 / 章节 / 复盘）。
 *
 * 用于路由层未来扩展。当前 SG-05B 不再用此函数分流 global 上下文（global 现在统一
 * 走 transcript_only 采样），保留导出仅为向后兼容。
 *
 * 关键不变量：**不**看 `transcriptCues` 本身 —— 字幕不算派生分析。
 */
export function hasDerivedAnalysis(pkg: VideoContextPackage): boolean {
  if (pkg.timeline.length > 0) return true;
  if (pkg.chapters.length > 0) return true;
  if (pkg.review.summary && pkg.review.summary.trim().length > 0) return true;
  if (pkg.review.keyPoints.length > 0) return true;
  return false;
}

/**
 * 把 followup-builders 模块的字符预算常量透出给 schema 入口（避免重复定义）。
 */
export { QUESTION_MATCH_MAX_CHARS, QUESTION_MATCH_MAX_HITS } from './transcript-retrieval';
