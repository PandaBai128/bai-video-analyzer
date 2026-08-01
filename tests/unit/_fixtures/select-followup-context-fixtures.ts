/**
 * 共享 fixtures —— selectFollowupContext 路由层测试文件用。
 *
 * 之前 select-followup-context.test.ts 单文件 943 行（> 800 项目规则），按职责拆
 * 到 6 个新文件后 fixtures 抽到本文件统一 import。
 */
import {
  buildVideoContextPackage,
  type VideoContextPackage,
} from '@core/followup/video-context-package';
import type {
  SubtitleCue,
  TimelineNode,
  UserAnnotation,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
} from '@core/types';

export const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  author: '作者',
  duration: 600,
};

export const TIMELINE: readonly TimelineNode[] = [
  { timestamp: 0, title: '开场', summary: '引入主题', importance: 'must-watch' },
  { timestamp: 120, title: '第一段', summary: '展开 A 点', importance: 'recommended' },
  { timestamp: 300, title: '第二段', summary: '展开 B 点', importance: 'recommended' },
];

export const CHAPTERS: readonly VideoChapter[] = [
  {
    timestamp: 0,
    endTimestamp: 200,
    title: '章节一',
    summary: 'A 段',
    importance: 'must-watch',
    watchGuide: '重点',
    segments: [TIMELINE[0]!, TIMELINE[1]!],
  },
  {
    timestamp: 200,
    endTimestamp: 500,
    title: '章节二',
    summary: 'B 段',
    importance: 'recommended',
    watchGuide: '可快进',
    segments: [TIMELINE[2]!],
  },
];

export const CUES: readonly SubtitleCue[] = [
  { start: 0, end: 5, text: '今天聊搜索算法' },
  { start: 5, end: 10, text: '从倒排索引讲起' },
  { start: 120, end: 130, text: 'BM25 的核心思想' },
  { start: 130, end: 140, text: 'TF-IDF 关系' },
  { start: 300, end: 310, text: '深度学习排序的进展' },
  { start: 310, end: 320, text: '向量召回' },
];

export const ANALYSIS: VideoAnalysis = {
  overview: '视频核心',
  watchStrategy: [],
  coreTakeaways: ['要点 A', '要点 B'],
  reviewSummary: '整体总结段落',
  chapters: CHAPTERS,
  timeline: TIMELINE,
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

export const ANNOTATIONS: readonly UserAnnotation[] = [
  {
    id: 'a-1',
    platform: 'bilibili',
    videoId: 'BV1xx',
    timestamp: 30,
    content: '记一下',
    createdAt: 1,
  },
];

export function buildPackage(overrides?: {
  transcriptCues?: readonly SubtitleCue[];
}): VideoContextPackage {
  return buildVideoContextPackage({
    metadata: METADATA,
    analysis: ANALYSIS,
    transcriptCues: overrides?.transcriptCues ?? CUES,
    annotations: ANNOTATIONS,
  });
}
