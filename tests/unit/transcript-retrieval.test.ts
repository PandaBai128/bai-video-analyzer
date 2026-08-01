import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import {
  buildVideoContextPackage,
  type VideoContextPackage,
} from '@core/followup/video-context-package';
import { buildFollowupChatPrompt } from '@core/prompts/video-followup-chat';
import type {
  SubtitleCue,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
} from '@core/types';

/**
 * FR-01 + SG-05B 端到端集成测试 —— 普通事实问题全字幕检索的用户可见行为。
 *
 * 文件拆分（FR-01 §3C）：
 * - 主题提取纯函数 → `followup-query-topic.test.ts`。
 * - 检索 / 评分 / 字符预算纯函数 → `transcript-retrieval-pure.test.ts`。
 * - 本文件：**端到端集成测试**（用 `selectFollowupContext` + `buildVideoContextPackage`），
 *   覆盖 SG-05B 验收 1-7 + FR-01 §4 验收 1-10 的用户行为契约。
 *
 * 不变量（用户可见行为）：
 * - 普通事实问题（如"维琳娜一命效果是什么"）触发 `question_match` scope。
 * - FR-01：主题被切到相邻字幕时，1-3 条 cue 窗口可命中（§1 真实 bug 修复）。
 * - `question_match` 无可靠命中 → 路由回落 `global`（**不**进 `keyword_match`，
 *   **不**返回 `matchInfo.hitCount=0` 否认信号）。
 * - `keyword_match` 无命中 → 保留显式 `hitCount=0`，但只表示完整字幕精确字面未命中。
 * - 有派生分析（timeline / chapters / review）时，global 仍走 transcript_only
 *   全片均匀采样。
 */

// ---------------------------------------------------------------------------
// Fixtures
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

/**
 * §1 真实用户 bug 场景：视频 30 分钟，前半段无关，17:29（≈1049s）附近含
 * "维琳娜的一命效果"。问"维琳娜一命效果是什么"应命中后半段 cue。
 */
const CUES_FOR_RETRIEVAL: readonly SubtitleCue[] = [
  // 前半段无关
  { start: 0, end: 5, text: '今天我们聊聊搜索算法' },
  { start: 30, end: 35, text: '从倒排索引讲起' },
  { start: 120, end: 130, text: 'BM25 的核心思想' },
  { start: 300, end: 310, text: 'TF-IDF 关系' },
  // 中段过渡
  { start: 700, end: 705, text: '向量检索与 BM25 关系' },
  // 17:29 附近含 "维琳娜的一命效果"
  { start: 1049, end: 1059, text: '现在讲解维琳娜的一命效果触发逻辑' },
  { start: 1059, end: 1069, text: '维琳娜的一命效果持续 1.5 秒' },
  { start: 1075, end: 1085, text: '维琳娜技能冷却时间分析' },
  // 结尾
  { start: 1500, end: 1510, text: '总结本期要点' },
];

const CUES_NO_HIT: readonly SubtitleCue[] = [
  { start: 0, end: 5, text: 'BM25 算法核心思想' },
  { start: 100, end: 110, text: 'TF-IDF 与 BM25 关系' },
  { start: 600, end: 610, text: '深度学习排序的进展' },
];

function buildPkg(options?: {
  readonly transcriptCues?: readonly SubtitleCue[];
  readonly analysis?: VideoAnalysis;
}): VideoContextPackage {
  return buildVideoContextPackage({
    metadata: METADATA,
    analysis: options?.analysis ?? ANALYSIS,
    transcriptCues: options?.transcriptCues ?? CUES_FOR_RETRIEVAL,
    annotations: [],
  });
}

// ---------------------------------------------------------------------------
// SG-05B 端到端验收 1-7（保留高价值回归）
// ---------------------------------------------------------------------------

describe('SG-05B 端到端验收 1: 普通事实问题命中 17:29 cue（§1 真实用户 bug）', () => {
  it('问"维琳娜一命效果是什么"命中后半段 cue，scope=question_match', () => {
    const pkg = buildPkg();
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts.some((s) => s >= 1040 && s <= 1090)).toBe(true);
    expect(result.matchInfo?.hitCount).toBeGreaterThan(0);
  });

  it('轻微差异：字幕"维琳娜的一命效果" vs 问句"维琳娜一命效果"归一化后能命中', () => {
    const pkg = buildPkg();
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    expect(result.matchInfo?.hitCount).toBeGreaterThanOrEqual(1);
  });
});

describe('SG-05B 端到端验收 2: 派生分析存在时仍命中后半段', () => {
  it('有 timeline + chapters + review 时，问"维琳娜一命效果"仍 question_match 命中后半段', () => {
    const pkg = buildPkg({ transcriptCues: CUES_FOR_RETRIEVAL, analysis: ANALYSIS });
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts.some((s) => s >= 1040 && s <= 1090)).toBe(true);
  });
});

describe('SG-05B 端到端验收 3: 普通事实问题零命中 → 回落 global，不产生 keyword_match 信号', () => {
  it('问"请简述星舰建造"（不在字幕中），scope=global；matchInfo.hitCount !== 0', () => {
    const pkg = buildPkg({ transcriptCues: CUES_NO_HIT });
    const result = selectFollowupContext({
      question: '请简述星舰建造',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    if (result.matchInfo) {
      expect(result.matchInfo.hitCount).not.toBe(0);
    }
  });
});

describe('SG-05B 端到端验收 4: "有没有提到 X" 零命中保留显式 hitCount=0', () => {
  it('问"有没有提到向量召回？"字幕无 → keyword_match + hitCount=0', () => {
    const pkg = buildPkg({ transcriptCues: CUES_NO_HIT });
    const result = selectFollowupContext({
      question: '有没有提到向量召回？',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('keyword_match');
    expect(result.matchInfo?.keyword).toBe('向量召回');
    expect(result.matchInfo?.hitCount).toBe(0);
  });
});

describe('SG-05B 端到端验收 5: 有派生分析的 global 仍覆盖开头 / 中段 / 结尾', () => {
  it('有 timeline + chapters + review 时，global 仍 transcript_only 全片均匀采样', () => {
    const pkg = buildPkg({ transcriptCues: CUES_FOR_RETRIEVAL, analysis: ANALYSIS });
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.globalContextMode).toBe('transcript_only');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts.length).toBeGreaterThan(3);
    expect(starts[0]).toBeLessThanOrEqual(300);
    expect(starts.some((s) => s >= 1000 && s <= 1100)).toBe(true);
    expect(starts.some((s) => s >= 1400)).toBe(true);
  });

  it('§1 真实用户 bug：问"这个视频讲什么"，不再只返回前 8 条字幕', () => {
    const cues: readonly SubtitleCue[] = Array.from({ length: 60 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 5,
      text: `cue-${i}`,
    }));
    const pkg = buildPkg({ transcriptCues: cues, analysis: ANALYSIS });
    const result = selectFollowupContext({
      question: '这个视频讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    expect(result.selectedTranscriptCues.length).toBeGreaterThan(8);
  });
});

describe('SG-05B 端到端验收 7: Prompt 区分 question_match vs keyword_match', () => {
  it('question_match scope 的 <primary_scope> 文案不出现"未在上下文中提到"', () => {
    const pkg = buildPkg({ transcriptCues: CUES_FOR_RETRIEVAL });
    const selected = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    const { user } = buildFollowupChatPrompt({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
      selectedContext: selected,
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    expect(scopeBlock).toContain('普通事实问题');
    expect(scopeBlock).not.toContain('未在上下文中提到');
  });

  it('keyword_match scope 的 <primary_scope> 文案明确"精确未命中不等于否"', () => {
    const pkg = buildPkg({ transcriptCues: CUES_NO_HIT });
    const selected = selectFollowupContext({
      question: '有没有提到向量召回？',
      contextPackage: pkg,
    });
    expect(selected.primaryScope).toBe('keyword_match');
    const { user } = buildFollowupChatPrompt({
      question: '有没有提到向量召回？',
      contextPackage: pkg,
      selectedContext: selected,
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    expect(scopeBlock).toContain('完整字幕里没有完全一致的字面词');
    expect(scopeBlock).toContain('不要');
    expect(scopeBlock).toContain('直接等同于"否"');
    expect(scopeBlock).not.toContain('未在上下文中提到');
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 1：单条后半段字幕完整包含主题 → question_match
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 1: 单条后半段字幕完整包含主题 → question_match', () => {
  it('单条 cue 含完整主题词命中', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: '这一段介绍维琳娜的一命效果' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(100);
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 2：主题被切到相邻两条 → 窗口命中（§1 真实用户 bug 修复）
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 2: 主题被切到相邻两条 → 窗口命中 question_match', () => {
  it('"维琳娜的" + "一命效果和触发逻辑" 分属相邻两条 → question_match', () => {
    // §1 真实用户 bug 场景：1049s cue 含 "我们先看维琳娜的"，1054s cue 含 "一命效果和触发逻辑"
    // → 单条 cue 找不到完整主题词 → 1-3 条 cue 窗口匹配命中
    const cues: readonly SubtitleCue[] = [
      { start: 1049, end: 1054, text: '我们先看维琳娜的' },
      { start: 1054, end: 1059, text: '一命效果和触发逻辑' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    // 两条原始 cue 都必须进入上下文（FR-01 §3A 第 6 条：组成可靠命中的原始 cues 都属于 core）
    expect(starts).toContain(1049);
    expect(starts).toContain(1054);
    // 真实时间点：1049s 在结果中
    expect(starts.some((s) => s >= 1040 && s <= 1100)).toBe(true);
    // 命中时间戳基于真实命中窗口时间（FR-01 §3A 第 7 条）
    expect(result.matchInfo?.hitTimestamps).toContain(1049);
  });

  it('"鲁迅" + "是谁" 类比场景：相邻两条合成完整主题 → question_match', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '接下来我们要介绍' },
      { start: 55, end: 60, text: '鲁迅这位伟大的作家' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '鲁迅是谁',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(55);
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 3：主题跨 3 条连续字幕 → 3 条 core cue
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 3: 主题跨 3 条连续字幕 → 3 条 core cue', () => {
  it('"维琳娜" / "一命效果" / "和触发逻辑" 三条 → 全部 core 保留', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 1049, end: 1054, text: '我们先看维琳娜' },
      { start: 1054, end: 1059, text: '的一命效果' },
      { start: 1059, end: 1064, text: '和触发逻辑' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(1049);
    expect(starts).toContain(1054);
    expect(starts).toContain(1059);
    expect(starts.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 4：时间间隔 > 3s → 不合并窗口；若时间线命中则走 timeline_match
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 4: 时间间隔 > 3s → 不合并窗口；时间线可兜底定位', () => {
  it('相邻 cue 间隔 10s → 单条命中缺失，但时间线命中则用时间线定位', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 1049, end: 1054, text: '我们先看维琳娜的' },
      { start: 1064, end: 1069, text: '一命效果和触发逻辑' }, // 间隔 10s > 3s
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('timeline_match');
    expect(result.selectedTimelineItems[0]?.timestamp).toBe(1050);
    expect(result.matchInfo?.hitTimestamps).toContain(1050);
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 5："系统方法" 分散出现不得误命中
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 5: "系统方法" 分散出现不得误命中', () => {
  it('系统 / 方法 远距离分散 + 单 cue 字符不连续 → 仍回落 global', () => {
    // 关键不变量（QA3 §2 + FR-01 §4 验收 5 + FR-02 §3 不回归）：
    // "系统方法" 在远距离分散 + 单 cue 字符不连续时仍必须回落 global。
    // FR-02 §3 三层容错匹配引入了 ordered_coverage，允许单 cue 内字符顺序匹配
    // （"系统设计方法论" 4 字主题，insertedChars=3 ≤ budget=8 → 命中），
    // 但**远距离分散**仍然不被命中 —— 跨 cue 间隔 > 3s 不合并窗口，
    // 且单 cue 中字符序列不连续时 ordered_coverage 也不命中。
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '今天讲系统的应用价值' }, // 只有"系统"，无"方法"
      { start: 200, end: 205, text: '方法论的演进过程' }, // 只有"方法"，无"系统"
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '系统方法是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
  });

  it('系统方法 单 cue 字符连续 → 仍回落 global（QA2 §C 恢复保守短主题边界）', () => {
    // QA2 §C 收口：TOLERANT_MIN_TOPIC_LENGTH 恢复为 5，4 字主题不再启用容错匹配。
    // cue '系统设计方法论' 单 cue 即使字符按顺序包含 "系统方法"，question_match
    // 也不再命中 → 路由回落 global。
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: '系统设计方法论介绍' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '系统方法是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
  });

  it('系统方法 单 cue 字符串含完整主题 → 命中 question_match + matchKind=exact（QA3 验收 3b 不回归）', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: '本节重点讲系统方法' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '系统方法是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    expect(result.matchInfo?.matchKind).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 6：自然问句修饰词（到底 / 具体）端到端命中
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 6: "维琳娜一命到底/具体有什么效果" 端到端命中', () => {
  it('"维琳娜一命到底有什么效果" → topic="维琳娜一命" → question_match 命中', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: '我们讲解维琳娜一命效果触发逻辑' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '维琳娜一命到底有什么效果',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(100);
  });

  it('"维琳娜一命具体有什么效果" → topic="维琳娜一命" → question_match 命中', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 100, end: 110, text: '我们讲解维琳娜一命效果触发逻辑' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '维琳娜一命具体有什么效果',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(100);
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 7：修饰词 "究竟" + "具体方法" 头部不被剥
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 7: 修饰词 "究竟" + "具体方法" 头部不被剥', () => {
  it('"鲁迅究竟是谁" → topic="鲁迅" → question_match 命中', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '这一段介绍鲁迅的生平与作品' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '鲁迅究竟是谁',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(50);
  });

  it('"具体方法是什么" → topic="具体方法"（头部 "具体" 不被剥）→ question_match', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '本节重点讲具体方法' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '具体方法是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(50);
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 8-9：全局意图闸门 + 零命中走 global（既有回归）
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 8: "这个视频主要讲什么" 仍走 global（既有闸门）', () => {
  it('§4 验收 8: isGlobalIntentQuestion 闸门仍拦截', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '这个机制需要先说明' },
      { start: 200, end: 205, text: '向量召回原理' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
  });
});

describe('FR-01 §4 验收 9: 无命中普通事实问题仍走 global', () => {
  it('字幕无目标主题 → global，不返回 keyword_match 否认信号', () => {
    const pkg = buildPkg({ transcriptCues: CUES_NO_HIT });
    const result = selectFollowupContext({
      question: '请简述星舰建造',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('global');
    if (result.matchInfo) {
      expect(result.matchInfo.hitCount).not.toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-01 §4 验收 10：多窗口远距离命中 + 字符预算 + 时间升序
// ---------------------------------------------------------------------------

describe('FR-01 §4 验收 10: 多窗口远距离命中 + 字符预算 + 时间升序', () => {
  it('两处远距离窗口命中 + 字符预算优先保留各 core + 时间升序', () => {
    // §1 真实 bug 修复：cue 50s 和 cue 1500s 都命中"维琳娜一命效果"，
    // 中间 1000s 无关 cue 不进入上下文。
    const cues: readonly SubtitleCue[] = [
      { start: 50, end: 55, text: '维琳娜一命效果 cue 1' },
      { start: 100, end: 105, text: '中间 cue' },
      { start: 500, end: 505, text: '中间 cue 2' },
      { start: 1000, end: 1005, text: '中间 cue 3' },
      { start: 1500, end: 1505, text: '维琳娜一命效果 cue 2' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });
    const result = selectFollowupContext({
      question: '维琳娜一命效果是什么',
      contextPackage: pkg,
    });
    expect(result.primaryScope).toBe('question_match');
    const starts = result.selectedTranscriptCues.map((c) => c.start);
    expect(starts).toContain(50);
    expect(starts).toContain(1500);
    expect(starts).not.toContain(500);
    expect(starts).not.toContain(1000);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe('真实追问回归: 术语作用类问题能定位到术语出现处', () => {
  it('"那电脑插件的作用有说吗" 命中字幕里的"电脑插件"，而不是回落 global', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 1818, end: 1822, text: '这里先打开工具设置' },
      { start: 1832, end: 1837, text: '我们手动的把电脑插件选上' },
      { start: 1840, end: 1848, text: '接下来继续演示怎么调用浏览器' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });

    const result = selectFollowupContext({
      question: '那电脑插件的作用有说吗',
      contextPackage: pkg,
    });

    expect(result.primaryScope).toBe('question_match');
    expect(result.matchInfo?.keyword).toBe('电脑插件');
    expect(result.selectedTranscriptCues.map((cue) => cue.start)).toContain(1832);
  });

  it('"computer use" 只按英文原词查找，不硬映射到字幕里的"电脑插件"', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 1832, end: 1837, text: '我们手动的把电脑插件选上' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });

    const result = selectFollowupContext({
      question: '有没有提到 computer use？',
      contextPackage: pkg,
    });

    expect(result.primaryScope).toBe('keyword_match');
    expect(result.matchInfo?.keyword).toBe('computer use');
    expect(result.matchInfo?.hitCount).toBe(0);
    expect(result.matchInfo?.hitTimestamps).toEqual([]);
    // 零精确命中后可以带候选上下文，但不能把中文候选误算成命中。
    expect(result.selectedTranscriptCues.some((cue) => cue.text.includes('computer use'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QA3 §1 端到端竞争测试：selectFollowupContext() → buildFollowupChatPrompt()
// ---------------------------------------------------------------------------

describe('QA3 §1 端到端竞争测试: exact 短路 → 远处 one_edit 不被引入 + prompt 按 matchKind 选话术', () => {
  it('10s 维琳娜 + 100s 维林娜 + 问"维林娜一命好吗" → 只命中 100s exact, prompt 用"视频里提到"', () => {
    const cues: readonly SubtitleCue[] = [
      { start: 10, end: 12, text: '维琳娜一命' },
      { start: 100, end: 102, text: '维林娜一命' },
    ];
    const pkg = buildPkg({ transcriptCues: cues });

    // 链路 1：selectFollowupContext
    const selected = selectFollowupContext({
      question: '维林娜一命好吗',
      contextPackage: pkg,
    });
    expect(selected.primaryScope).toBe('question_match');
    expect(selected.matchInfo?.matchKind).toBe('exact');
    expect(selected.matchInfo?.hitTimestamps).toContain(100);
    expect(selected.matchInfo?.hitTimestamps).not.toContain(10);

    // selectedTranscriptCues 不包含 10s 容错候选
    const selectedStarts = selected.selectedTranscriptCues.map((c) => c.start);
    expect(selectedStarts).toContain(100);
    expect(selectedStarts).not.toContain(10);

    // 链路 2：buildFollowupChatPrompt
    const { user } = buildFollowupChatPrompt({
      question: '维林娜一命好吗',
      contextPackage: pkg,
      selectedContext: selected,
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    // exact 命中：使用"视频里提到"确定命中话术
    expect(scopeBlock).toContain('视频里提到');
    // 不使用容错话术（"可能对应"）
    expect(scopeBlock).not.toContain('可能对应');
  });
});
