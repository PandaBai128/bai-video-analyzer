import { describe, expect, it } from 'vitest';
import { buildContextualRetrievalQuestion } from '@core/followup/contextual-retrieval-question';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import {
  buildVideoContextPackage,
  type VideoContextPackage,
} from '@core/followup/video-context-package';
import type {
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';

/**
 * 真实检索链路集成测试（AGENT_HANDOFF QA1 必修 5）。
 *
 * 验证核心防御场景：
 * - 字幕同时包含两个相邻 / 竞争主题（ChatGPT + GLM）。
 * - 用户首问 ChatGPT，模型按 ChatGPT 主题回答。
 * - 第二问发送纠正型短追问"我问的是优点"。
 * - buildContextualRetrievalQuestion → selectFollowupContext 整条链路必须
 *   保留 ChatGPT 相关上下文，**不**切到 GLM。
 *
 * 不引入 controller fixture；只测 core 层两个纯函数组合 + 最小
 * VideoContextPackage。
 *
 * 这是上一轮只测"字符串拼接"的关键防线：拼接对了，但检索路由把"优点"
 * 当作弱关键词重新匹配 GLM 字幕 → 模型答非所问。本测试在 select 层做防御。
 */

const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV-llm',
  url: 'https://www.bilibili.com/video/BV-llm',
  title: '大模型对比',
  author: '作者',
  duration: 600,
};

// 字幕：开头 ChatGPT 段，中间 GLM 段（竞争主题）
const CUES: readonly SubtitleCue[] = [
  { start: 0, end: 5, text: '今天对比 ChatGPT 和 GLM' },
  { start: 5, end: 10, text: 'ChatGPT 的优点：效率高，泛化能力强' },
  { start: 10, end: 15, text: 'ChatGPT 缺点：依赖算力，推理成本高' },
  { start: 300, end: 305, text: '接下来讲 GLM' },
  { start: 305, end: 310, text: 'GLM 的优点：中文能力强，开源可控' },
  { start: 310, end: 315, text: 'GLM 缺点：英文能力弱' },
];

const ANALYSIS: VideoAnalysis = {
  overview: '对比主流大模型',
  watchStrategy: [],
  coreTakeaways: ['ChatGPT 强在泛化', 'GLM 强在中文'],
  reviewSummary: '',
  chapters: [],
  timeline: [],
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

const PKG: VideoContextPackage = buildVideoContextPackage({
  metadata: METADATA,
  analysis: ANALYSIS,
  transcriptCues: CUES,
  annotations: [],
});

describe('buildContextualRetrievalQuestion → selectFollowupContext 真实检索链路 (QA1 必修 5)', () => {
  it('"ChatGPT 的优势是什么？" → "我问的是优点" → 必须保留 ChatGPT 上下文，不能切到 GLM', () => {
    // helper：把 selectedTranscriptCues 的 start 时间戳提出来，判断是否进了 GLM 段
    // （CUES 中 GLM 段 start ≥ 300，ChatGPT 段 start ≤ 15）
    const gl段StartMin = (cues: readonly SubtitleCue[]): number => {
      if (cues.length === 0) return Number.POSITIVE_INFINITY;
      return Math.min(...cues.map((c) => c.start));
    };

    // 1) 首问（无 history）：直接用 selectFollowupContext，应匹配 ChatGPT 段（start ≤ 15）
    const firstRetrieval = 'ChatGPT 的优势是什么？';
    const firstResult = selectFollowupContext({
      question: firstRetrieval,
      contextPackage: PKG,
    });
    // sanity：首问命中 ChatGPT 段（不是 GLM）—— selectedCues 最远不应进入 start ≥ 300 的 GLM 段
    const firstText = firstResult.selectedTranscriptCues.map((c) => c.text).join('\n');
    expect(firstText).toContain('ChatGPT');
    // 关键防线：selectedTranscriptCues 不应包含 GLM 专属段（"GLM 的优点：中文能力强，开源可控"）
    expect(firstText).not.toContain('GLM 的优点');

    // 2) 模拟历史快照：第一轮已完成 user + assistant
    const history = [
      { role: 'user' as const, content: firstRetrieval },
      { role: 'assistant' as const, content: 'ChatGPT 优点是效率高、泛化能力强。' },
    ];

    // 3) 第二问（纠正型短追问）：buildContextualRetrievalQuestion 拼接后，
    //    走 selectFollowupContext 整条检索链路
    const secondRetrieval = buildContextualRetrievalQuestion({
      question: '我问的是优点',
      conversationHistory: history,
    });
    // sanity：拼接正确（保留 ChatGPT 主题）
    expect(secondRetrieval).toContain('ChatGPT');
    expect(secondRetrieval).not.toContain('GLM');

    const secondResult = selectFollowupContext({
      question: secondRetrieval,
      contextPackage: PKG,
    });
    const secondText = secondResult.selectedTranscriptCues.map((c) => c.text).join('\n');

    // 关键防线：必须保留 ChatGPT 段，**不能**切到 GLM 段
    expect(secondText).toContain('ChatGPT');
    expect(secondText).not.toContain('GLM 的优点');
    // selectedCues 的最早 start 必须 ≤ 50（落在 ChatGPT 段附近），不能进入 GLM 段
    expect(gl段StartMin(secondResult.selectedTranscriptCues)).toBeLessThan(50);
  });
});
