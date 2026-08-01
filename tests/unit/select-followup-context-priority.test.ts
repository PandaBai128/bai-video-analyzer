import { describe, expect, it } from 'vitest';
import { buildVideoContextPackage } from '@core/followup/video-context-package';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import {
  ANALYSIS,
  ANNOTATIONS,
  METADATA,
  buildPackage,
} from './_fixtures/select-followup-context-fixtures';
import type { SubtitleCue } from '@core/types';

/**
 * selectFollowupContext 路由层优先级测例（explicit_time / forceCurrentSegment /
 * selected intent / explicit current / ambiguous current / selectedTimestamp 兜底 /
 * global 兜底）。
 *
 * 拆自 `select-followup-context.test.ts`（原 943 行 → 按职责拆到多文件 < 800 行）。
 */

describe('selectFollowupContext 优先级', () => {
  it('用户问题里的明确时间点优先于 selectedTimestamp 和 currentTime', () => {
    const result = selectFollowupContext({
      question: '12:30 这段在讲什么？',
      contextPackage: buildPackage(),
      currentTime: 0,
      selectedTimestamp: 0,
    });
    expect(result.primaryScope).toBe('explicit_time');
    expect(result.anchorTimestamp).toBe(12 * 60 + 30);
    expect(result.anchorLabel).toBe('explicit_time');
  });

  it('Round 19 必修 3：current intent 命中时优先于 selectedTimestamp（不被旧节点抢走）', () => {
    const result = selectFollowupContext({
      question: '这段在讲什么',
      contextPackage: buildPackage(),
      currentTime: 0,
      selectedTimestamp: 120,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(0);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('Round 19 必修 3：selected-segment intent（不含 current intent 的词）+ selectedTimestamp → selected_segment', () => {
    const result = selectFollowupContext({
      question: '我选的这个节点为什么重要？',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 120,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.selectedTimelineItems[0]?.timestamp).toBe(120);
    expect(result.anchorTimestamp).toBe(120);
    expect(result.anchorLabel).toBe('selected_timestamp');
  });

  it('currentTime 走 current_segment 路径', () => {
    const result = selectFollowupContext({
      question: '这段在讲什么',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.selectedTimelineItems[0]?.timestamp).toBe(120);
    expect(result.anchorTimestamp).toBe(125);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('Round 15 必修 2 C：current_segment 必须把 currentTime 写入 anchorTimestamp', () => {
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: buildPackage(),
      currentTime: 271,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(271);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('Round 15 必修 2 C：global / keyword_match 不设 anchor', () => {
    const global = selectFollowupContext({
      question: '整体讲什么',
      contextPackage: buildPackage(),
    });
    expect(global.primaryScope).toBe('global');
    expect(global.anchorTimestamp).toBeUndefined();
    expect(global.anchorLabel).toBeUndefined();

    const kw = selectFollowupContext({
      question: '有没有提到 BM25？',
      contextPackage: buildPackage(),
    });
    expect(kw.primaryScope).toBe('keyword_match');
    expect(kw.anchorTimestamp).toBeUndefined();
    expect(kw.anchorLabel).toBeUndefined();
  });

  it('关键词提问先信任字幕命中，再用时间线兜底，避免错误时间线抢走定位', () => {
    const contextPackage = buildVideoContextPackage({
      metadata: METADATA,
      analysis: {
        ...ANALYSIS,
        timeline: [
          {
            timestamp: 300,
            endTimestamp: 360,
            title: 'NotebookLM MCP 接入演示',
            summary: '时间线里也提到了 NotebookLM。',
            importance: 'recommended',
          },
        ],
        chapters: [
          {
            timestamp: 300,
            endTimestamp: 360,
            title: 'NotebookLM MCP 接入演示',
            summary: '时间线里也提到了 NotebookLM。',
            importance: 'recommended',
            watchGuide: '可看',
            segments: [
              {
                timestamp: 300,
                endTimestamp: 360,
                title: 'NotebookLM MCP 接入演示',
                summary: '时间线里也提到了 NotebookLM。',
                importance: 'recommended',
              },
            ],
          },
        ],
      },
      transcriptCues: [
        { start: 90, end: 96, text: '这里提到 NotebookLM 的知识库连接。' },
        { start: 300, end: 306, text: '后面是普通插件配置演示。' },
      ],
      annotations: ANNOTATIONS,
    });

    const result = selectFollowupContext({
      question: '有没有提到 Notebook LM？',
      contextPackage,
    });

    expect(result.primaryScope).toBe('keyword_match');
    expect(result.selectedTranscriptCues.map((cue) => cue.start)).toContain(90);
    expect(result.matchInfo?.hitTimestamps).toContain(90);
  });

  it('否定式提问也用完整字幕检索，目标词只出现在 36 条采样之外时仍能命中', () => {
    const cues: SubtitleCue[] = Array.from({ length: 469 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
      text: index === 420 ? '这里提到了徐州老味菜和买单活动。' : `普通字幕 ${index}`,
    }));
    const result = selectFollowupContext({
      question: '没有徐州老味菜？',
      contextPackage: buildPackage({ transcriptCues: cues }),
    });

    expect(result.primaryScope).toBe('keyword_match');
    expect(result.matchInfo).toMatchObject({
      keyword: '徐州老味菜',
      hitCount: 1,
    });
    expect(result.matchInfo?.hitTimestamps).toEqual([840]);
    expect(result.selectedTranscriptCues.some((cue) => cue.text.includes('徐州老味菜'))).toBe(true);
  });

  it('Round 17 必修 A：includeCurrentSegment=false 且无 intent 时不取 current_segment', () => {
    const result = selectFollowupContext({
      question: '播放速度怎么样',
      contextPackage: buildPackage(),
      currentTime: 125,
      includeCurrentSegment: false,
    });
    expect(result.primaryScope).toBe('global');
  });

  it('Round 17 必修 A：includeCurrentSegment=false 但 intent 命中仍取 current_segment', () => {
    const result = selectFollowupContext({
      question: '这段在讲什么',
      contextPackage: buildPackage(),
      currentTime: 125,
      includeCurrentSegment: false,
    });
    expect(result.primaryScope).toBe('current_segment');
  });

  it('没有时间点 / 选中 / 播放位置时回落 global', () => {
    const result = selectFollowupContext({
      question: '这个视频主要表达什么',
      contextPackage: buildPackage(),
    });
    expect(result.primaryScope).toBe('global');
    expect(result.selectedTimelineItems.length).toBeGreaterThan(0);
  });

  it('Round 17 必修 A：泛问"这个视频主要讲什么？"在有 currentTime 时也不走 current_segment', () => {
    const result = selectFollowupContext({
      question: '这个视频主要讲什么？',
      contextPackage: buildPackage(),
      currentTime: 125,
      includeCurrentSegment: true,
    });
    expect(result.primaryScope).toBe('global');
  });

  it('Round 17 必修 A："现在讲的是什么？" intent 命中 → current_segment', () => {
    const result = selectFollowupContext({
      question: '现在讲的是什么？',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(125);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('Round 17 必修 A：forceCurrentSegment=true 固定问题 → current_segment（不靠问题文本碰巧命中）', () => {
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: buildPackage(),
      currentTime: 271,
      forceCurrentSegment: true,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(271);
  });

  it('Round 17 必修 A："3:20 这里是什么意思？" → 显式时间点优先于 intent', () => {
    const result = selectFollowupContext({
      question: '3:20 这里是什么意思？',
      contextPackage: buildPackage(),
      currentTime: 999,
    });
    expect(result.primaryScope).toBe('explicit_time');
    expect(result.anchorTimestamp).toBe(3 * 60 + 20);
    expect(result.anchorLabel).toBe('explicit_time');
  });

  it('Round 17 必修 A / Round 19 必修 3：用户选中时间线节点后用"这段"提问 → current_segment（current intent 优先）', () => {
    const result = selectFollowupContext({
      question: '这段在讲什么',
      contextPackage: buildPackage(),
      currentTime: 0,
      selectedTimestamp: 120,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(0);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('Round 18 必修 1：forceCurrentSegment=true 压住旧的 selectedTimestamp → current_segment', () => {
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 120,
      forceCurrentSegment: true,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(30);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('Round 18 必修 1：forceCurrentSegment=true 但 currentTime 缺失 → 不走 current_segment，回落 selected_segment', () => {
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: buildPackage(),
      selectedTimestamp: 120,
      forceCurrentSegment: true,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(120);
  });
});
