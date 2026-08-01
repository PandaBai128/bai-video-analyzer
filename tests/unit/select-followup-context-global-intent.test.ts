import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
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

/**
 * 全局 / 概览问题不应被字幕里的通用问句词误路由到 `question_match`。
 * 这里保留端到端路由行为，不锁内部 token 规则。
 */

// ---------------------------------------------------------------------------
// Fixtures（与主测试文件同源，独立 copy 避免循环 import）
// ---------------------------------------------------------------------------

const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  author: '作者',
  duration: 1800,
};

const TIMELINE: readonly TimelineNode[] = [
  { timestamp: 0, title: '开场', summary: '引入主题', importance: 'must-watch' },
  { timestamp: 1050, title: '17:29 段落', summary: '维琳娜一命效果相关', importance: 'must-watch' },
];

const CHAPTERS: readonly VideoChapter[] = [
  {
    timestamp: 0,
    endTimestamp: 1000,
    title: '章节一',
    summary: '基础介绍',
    importance: 'must-watch',
    watchGuide: '看',
    segments: [TIMELINE[0]!],
  },
  {
    timestamp: 1000,
    endTimestamp: 1800,
    title: '章节二',
    summary: '包含维琳娜段落',
    importance: 'must-watch',
    watchGuide: '看',
    segments: [TIMELINE[1]!],
  },
];

const ANALYSIS: VideoAnalysis = {
  overview: '视频核心',
  watchStrategy: [],
  coreTakeaways: ['要点 A', '要点 B'],
  reviewSummary: '整体总结',
  chapters: CHAPTERS,
  timeline: TIMELINE,
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

const ANNOTATIONS: readonly UserAnnotation[] = [];

function buildPackage(transcriptCues: readonly SubtitleCue[]): VideoContextPackage {
  return buildVideoContextPackage({
    metadata: METADATA,
    analysis: ANALYSIS,
    transcriptCues,
    annotations: ANNOTATIONS,
  });
}

// ---------------------------------------------------------------------------
// 全局 / 概览问题必须落 global，**不**走 question_match
// ---------------------------------------------------------------------------

describe('selectFollowupContext (全局 / 概览问题)', () => {
  it('"这个视频主要讲什么" 即使字幕含"这个"也必须走 global', () => {
    // 字幕含"这个机制需要先说明"，但"这个"只是通用问句词。
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '这个机制需要先说明' },
      { start: 200, end: 205, text: '向量召回原理' },
    ];
    const result = selectFollowupContext({
      question: '这个视频主要讲什么',
      contextPackage: buildPackage(cues),
    });
    expect(result.primaryScope).toBe('global');
    // global 上下文应是全片均匀采样
    expect(result.globalContextMode).toBe('transcript_only');
  });

  it('"总结一下" / "学习笔记" 等白名单触发词也走 global', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: 'BM25 算法核心思想' },
      { start: 200, end: 205, text: '向量召回进展' },
    ];
    for (const question of ['总结一下', '帮我整理成学习笔记', '整体讲什么']) {
      const result = selectFollowupContext({
        question,
        contextPackage: buildPackage(cues),
      });
      expect(result.primaryScope, `question="${question}"`).toBe('global');
    }
  });

  it('"系统方法是什么" 在分散弱命中时回落 global', () => {
    // 两个 cue 分别含 "系统" / "方法"，但单 cue 不含完整主题词。
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '系统设计方法论介绍' },
      { start: 1500, end: 1505, text: '方法系统化思考讲解' },
    ];
    const result = selectFollowupContext({
      question: '系统方法是什么',
      contextPackage: buildPackage(cues),
    });
    expect(result.primaryScope).toBe('global');
  });

  it('"维琳娜一命效果是什么" 真实场景继续走 question_match（不被新逻辑误伤）', () => {
    // 真实场景：cue 含明确主题词，应继续命中 question_match。
    const cues: readonly SubtitleCue[] = [
      { start: 1049, end: 1059, text: '现在讲解维琳娜的一命效果触发逻辑' },
      { start: 1059, end: 1069, text: '维琳娜的一命效果持续 1.5 秒' },
    ];
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: buildPackage(cues),
    });
    expect(result.primaryScope).toBe('question_match');
    // 命中 cue 至少 1 条
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(0);
  });

  it('真实场景 "BM25 算法核心思想是什么" 走 question_match', () => {
    // 区分度 token: "BM25"(4) + "核心思想"(4) → distinguishingTokenLength >= 4
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: 'BM25 算法核心思想讲解' },
      { start: 200, end: 210, text: 'BM25 与 TF-IDF 关系' },
    ];
    const result = selectFollowupContext({
      question: 'BM25 算法核心思想是什么',
      contextPackage: buildPackage(cues),
    });
    expect(result.primaryScope).toBe('question_match');
  });
});

// ---------------------------------------------------------------------------
// 短专有词可靠命中（3 字符中文专名 / 3+ 字符 ASCII 缩写）
// ---------------------------------------------------------------------------

describe('selectFollowupContext (短专有词可靠命中)', () => {
  it('"RAG 是什么" 命中字幕含 RAG 并走 question_match', () => {
    // RAG 是明确专有词/缩写，不能仅因长度短而忽略。
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: '这里介绍 RAG 的检索增强生成流程' },
    ];
    const result = selectFollowupContext({
      question: 'RAG 是什么',
      contextPackage: buildPackage(cues),
    });
    expect(result.primaryScope).toBe('question_match');
    // 命中 cue 至少 1 条
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(0);
  });

  it('"API 是什么" / "GPT 是什么" 也命中并走 question_match', () => {
    const cases: Array<{ question: string; cueText: string }> = [
      { question: 'API 是什么', cueText: '本节讲 API 接口设计原则' },
      { question: 'GPT 是什么', cueText: '介绍 GPT 模型架构' },
    ];
    for (const { question, cueText } of cases) {
      const result = selectFollowupContext({
        question,
        contextPackage: buildPackage([{ start: 100, end: 110, text: cueText }]),
      });
      expect(result.primaryScope, `question="${question}"`).toBe('question_match');
    }
  });

  it('2-3 字中文专名的普通事实问题能命中对应字幕', () => {
    // 苏格拉底 (3 字符专名) — reliableScore > 0 → question_match
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: '苏格拉底哲学思想讲解' },
      { start: 200, end: 210, text: '苏格拉底的弟子柏拉图' },
    ];
    const result = selectFollowupContext({
      question: '苏格拉底是谁',
      contextPackage: buildPackage(cues),
    });
    expect(result.primaryScope).toBe('question_match');
  });

  it('"这个视频主要讲什么" + 仅通用弱词问题继续走 global', () => {
    // 通用弱词仍不能触发 question_match。
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '这个机制需要先说明' },
      { start: 200, end: 205, text: '向量召回原理' },
    ];
    const result = selectFollowupContext({
      question: '这个视频主要讲什么',
      contextPackage: buildPackage(cues),
    });
    expect(result.primaryScope).toBe('global');
  });
});
