import { describe, expect, it } from 'vitest';
import { parseVideoAnalysisJson } from '@core/analysis/video-analysis-schema';

describe('parseVideoAnalysisJson', () => {
  it('parses a minimal video analysis response', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['复盘总结'],
        timeline: [
          {
            timestamp: 0,
            title: '开场',
            summary: '介绍主题',
            importance: 'must-watch',
          },
        ],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    });

    expect(analysis.modelUsed).toBe('MiniMax-M3');
    expect(analysis.sourceMode).toBe('subtitle');
    expect(analysis.timeline[0]?.title).toBe('开场');
    expect(analysis.chapters.length).toBe(1);
    expect(analysis.overview).toBe('复盘总结');
  });

  it('normalizes non-standard importance values from the model', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['复盘总结'],
        timeline: [
          {
            timestamp: 0,
            title: '开场',
            summary: '介绍主题',
            importance: 'normal',
          },
        ],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'multimodal',
    });

    expect(analysis.timeline[0]?.importance).toBe('recommended');
  });

  it('defaults omitted importance fields in chapters and segments', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['复盘总结'],
        chapters: [
          {
            timestamp: 0,
            title: '第一章',
            summary: '章节摘要',
            segments: [
              {
                timestamp: 0,
                title: '开场',
                summary: '介绍主题',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'multimodal',
    });

    expect(analysis.chapters[0]?.importance).toBe('recommended');
    expect(analysis.chapters[0]?.segments[0]?.importance).toBe('recommended');
    expect(analysis.timeline[0]?.importance).toBe('recommended');
  });

  it('保留独立内容类型标签，不把它混进观看优先级', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['复盘总结'],
        chapters: [
          {
            timestamp: 0,
            title: '方法章节',
            summary: '讲整体方法。',
            importance: 'recommended',
            contentTag: 'method',
            segments: [
              {
                timestamp: 0,
                title: '实操演示',
                summary: '展示操作过程。',
                importance: 'recommended',
                contentTag: '演示',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'multimodal',
    });

    expect(analysis.chapters[0]?.importance).toBe('recommended');
    expect(analysis.chapters[0]?.contentTag).toBe('method');
    expect(analysis.chapters[0]?.segments[0]?.contentTag).toBe('demo');
    expect(analysis.timeline[0]?.contentTag).toBe('demo');
  });

  it('规范化攻略类中文内容标签，不把游戏配置当作外部工具', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: [],
        chapters: [
          {
            timestamp: 0,
            title: '专武与影画提升',
            summary: '配置建议',
            contentTag: '专武配置工具',
            segments: [
              {
                timestamp: 1,
                title: '后台输出循环',
                summary: '操作要点',
                contentTag: '操作要点',
              },
              {
                timestamp: 2,
                title: '实战效果',
                summary: '测试过程',
                contentTag: '实战演示',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'multimodal',
    });

    expect(analysis.chapters[0]?.contentTag).toBe('setup');
    expect(analysis.chapters[0]?.segments[0]?.contentTag).toBe('method');
    expect(analysis.chapters[0]?.segments[1]?.contentTag).toBe('demo');
  });

  it('creates fallback timeline nodes when chapters omit segments', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['复盘总结'],
        chapters: [
          {
            timestamp: 0,
            endTimestamp: 60,
            title: '第一章',
            summary: '章节摘要',
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'multimodal',
    });

    expect(analysis.chapters[0]?.segments.length).toBe(1);
    expect(analysis.timeline[0]?.title).toBe('第一章');
    expect(analysis.timeline[0]?.endTimestamp).toBe(60);
  });

  it('parses overview and nested chapters', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        watchStrategy: ['先看框架'],
        coreTakeaways: ['复盘总结'],
        reviewSummary: '整体总结段落',
        chapters: [
          {
            timestamp: 0,
            title: '时间线章节',
            summary: '章节摘要',
            importance: 'must-watch',
            watchGuide: '重点看这一章',
            reflectionPrompt: '这章和你有什么关系？',
            segments: [
              {
                timestamp: 10,
                title: '细分节点',
                summary: '小段摘要',
                importance: 'recommended',
                watchPrompt: '注意判断标准',
              },
            ],
          },
        ],
        quotes: [],
        keyConcepts: [],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'multimodal',
    });

    expect(analysis.overview).toBe('视频核心');
    expect(analysis.watchStrategy[0]).toBe('先看框架');
    expect(analysis.reviewSummary).toBe('整体总结段落');
    expect(analysis.chapters[0]?.segments[0]?.watchPrompt).toBe('注意判断标准');
    expect(analysis.timeline[0]?.title).toBe('细分节点');
  });

  it('repairs common model json syntax mistakes', () => {
    const analysis = parseVideoAnalysisJson({
      content:
        '{"overview":"视频核心","coreTakeaways":["要点"] "reviewSummary":"整体总结","timeline":[{"timestamp":0,"title":"开场","summary":"介绍主题","importance":"normal"}]}',
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    });

    expect(analysis.reviewSummary).toBe('整体总结');
    expect(analysis.timeline[0]?.importance).toBe('recommended');
  });

  it('repairs unescaped quotes inside Chinese string values', () => {
    const analysis = parseVideoAnalysisJson({
      content:
        '{"overview":"视频核心","chapters":[{"timestamp":0,"endTimestamp":45,"title":"复盘涨粉难的经历","summary":"分享早期做vlog半年没起色、收入为零的经历，给出"先刷一遍同赛道优秀账号"的建议。","segments":[]}],"coreTakeaways":["要点"],"reviewSummary":"整体总结","inspirations":[]}',
      modelUsed: 'MiniMax-M3',
      sourceMode: 'multimodal',
    });

    expect(analysis.chapters[0]?.summary).toContain('"先刷一遍同赛道优秀账号"');
    expect(analysis.reviewSummary).toBe('整体总结');
  });

  it('普通 JSON 解析失败错误不写死 MiniMax', () => {
    let errorMessage = '';
    try {
      parseVideoAnalysisJson({
        content: 'not json at all',
        modelUsed: 'custom-openai-compatible',
        sourceMode: 'subtitle',
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toMatch(/模型返回的 JSON 无法解析/);
    expect(errorMessage).not.toContain('MiniMax 返回的 JSON');
  });
});

// ---------------------------------------------------------------------------
// Round 22 必修 B1+B2：单一 timeline 来源 + 排序 + 范围校验
// ---------------------------------------------------------------------------

describe('parseVideoAnalysisJson (Round 22 必修 B1: 单一 timeline 来源)', () => {
  it('模型同时输出 chapters 和顶层 timeline → timeline 来自 chapters，顶层 timeline 不参与高亮/追问', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        chapters: [
          {
            timestamp: 0,
            endTimestamp: 60,
            title: '章 A',
            summary: 'A',
            importance: 'must-watch',
            watchGuide: 'wg',
            segments: [
              { timestamp: 0, endTimestamp: 30, title: 's1', summary: 's1' },
              { timestamp: 35, endTimestamp: 55, title: 's2', summary: 's2' },
            ],
          },
        ],
        // 模型"意外"输出顶层 timeline —— prompt 已禁止，解析层防御
        timeline: [
          { timestamp: 999, title: '幽灵节点', summary: '不应参与', importance: 'skip' },
        ],
        coreTakeaways: ['要点'],
        reviewSummary: '整体',
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    });

    // 顶层 timeline 不应影响 chapters.segments
    expect(analysis.chapters.length).toBe(1);
    expect(analysis.chapters[0]?.segments.map((s) => s.title)).toEqual(['s1', 's2']);
    // timeline 来自 chapters.segments
    expect(analysis.timeline.map((n) => n.title)).toEqual(['s1', 's2']);
  });

  it('没有 chapters 仍使用顶层 timeline 兜底（拆 4 段）', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['要点'],
        timeline: [
          { timestamp: 0, title: 'a', summary: 'a' },
          { timestamp: 30, title: 'b', summary: 'b' },
          { timestamp: 60, title: 'c', summary: 'c' },
          { timestamp: 90, title: 'd', summary: 'd' },
          { timestamp: 120, title: 'e', summary: 'e' },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    });

    expect(analysis.chapters.length).toBeGreaterThan(0);
    // 兜底 chapters 后 timeline == chapters.flatMap(segments)
    expect(analysis.timeline).toEqual(analysis.chapters.flatMap((c) => c.segments));
  });
});

describe('parseVideoAnalysisJson (Round 22 必修 B2: 范围校验 + 排序)', () => {
  it('chapter 2 含 chapter 1 范围 segment → segment 被移回 chapter 1（端到端）', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['要点'],
        chapters: [
          {
            timestamp: 0,
            endTimestamp: 60,
            title: '章 1',
            summary: 'A',
            importance: 'must-watch',
            watchGuide: 'wg',
            segments: [{ timestamp: 0, endTimestamp: 30, title: 's1', summary: 's1' }],
          },
          {
            timestamp: 60,
            endTimestamp: 120,
            title: '章 2',
            summary: 'B',
            importance: 'recommended',
            watchGuide: 'wg',
            segments: [
              { timestamp: 30, endTimestamp: 45, title: 's2-越界', summary: 's2-越界' }, // 越界
              { timestamp: 70, endTimestamp: 90, title: 's2-正常', summary: 's2-正常' },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    });

    expect(analysis.chapters[0]?.segments.map((s) => s.title)).toEqual(['s1', 's2-越界']);
    expect(analysis.chapters[1]?.segments.map((s) => s.title)).toEqual(['s2-正常']);
  });

  it('chapter endTimestamp < 最后 segment endTimestamp → endTimestamp 被扩展', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['要点'],
        chapters: [
          {
            timestamp: 0,
            endTimestamp: 30, // 故意小
            title: '章 1',
            summary: 'A',
            importance: 'must-watch',
            watchGuide: 'wg',
            segments: [
              { timestamp: 0, endTimestamp: 20, title: 'a', summary: 'a' },
              { timestamp: 25, endTimestamp: 80, title: 'b', summary: 'b' },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    });

    expect(analysis.chapters[0]?.endTimestamp).toBe(80);
  });

  it('修完后 timeline == chapters.flatMap(segments)（不变量）', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        coreTakeaways: ['要点'],
        chapters: [
          {
            timestamp: 0,
            endTimestamp: 60,
            title: '章 1',
            summary: 'A',
            importance: 'must-watch',
            watchGuide: 'wg',
            segments: [
              { timestamp: 40, title: 'c', summary: 'c' },
              { timestamp: 10, title: 'a', summary: 'a' },
              { timestamp: 25, title: 'b', summary: 'b' },
            ],
          },
          {
            timestamp: 60,
            endTimestamp: 120,
            title: '章 2',
            summary: 'B',
            importance: 'recommended',
            watchGuide: 'wg',
            segments: [{ timestamp: 80, title: 'd', summary: 'd' }],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
    });

    expect(analysis.timeline).toEqual(analysis.chapters.flatMap((c) => c.segments));
    // segments 排序
    expect(analysis.chapters[0]?.segments.map((s) => s.title)).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Round 23 QA 必修 A：cue-only JSON 可解析
// ---------------------------------------------------------------------------

describe('parseVideoAnalysisJson (Round 23 QA 必修 A: cue-only 可解析)', () => {
  const SUBTITLES = [
    { start: 0, end: 6, text: 'cue 0' },
    { start: 6, end: 12, text: 'cue 1' },
    { start: 39, end: 45, text: 'cue 2 (铺垫)' },
    { start: 50, end: 58, text: 'cue 3 (主题)' },
    { start: 100, end: 110, text: 'cue 4' },
  ];

  it('纯 cue-only JSON 可解析（无任何 timestamp / endTimestamp）', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        chapters: [
          {
            // 完全没有 timestamp / endTimestamp
            startCueId: 0,
            endCueId: 3,
            title: '章 A',
            summary: 'A',
            importance: 'must-watch',
            watchGuide: 'wg',
            segments: [
              {
                // 完全没有 timestamp / endTimestamp
                startCueId: 0,
                endCueId: 1,
                title: 's1',
                summary: 's1',
                importance: 'recommended',
              },
              {
                startCueId: 2,
                endCueId: 3,
                title: 's2',
                summary: 's2',
                importance: 'recommended',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
      subtitles: SUBTITLES,
    });

    // chapter.timestamp 来自 cue 0.start=0
    expect(analysis.chapters[0]?.timestamp).toBe(0);
    // chapter.endTimestamp 来自 cue 3.end=58
    expect(analysis.chapters[0]?.endTimestamp).toBe(58);
    // segment[0] timestamp 来自 cue 0.start=0, endCueId=1 → cue 1.end=12
    expect(analysis.chapters[0]?.segments[0]?.timestamp).toBe(0);
    expect(analysis.chapters[0]?.segments[0]?.endTimestamp).toBe(12);
    // segment[1] timestamp 来自 cue 2.start=39, endCueId=3 → cue 3.end=58
    expect(analysis.chapters[0]?.segments[1]?.timestamp).toBe(39);
    expect(analysis.chapters[0]?.segments[1]?.endTimestamp).toBe(58);
  });

  it('cue id 优先于 timestamp（同时存在时以 cue id 为准）', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        chapters: [
          {
            timestamp: 999, // 模型自报错的 timestamp
            endTimestamp: 9999,
            startCueId: 3, // cue 3.start = 50
            endCueId: 4, // cue 4.end = 110
            title: '章 A',
            summary: 'A',
            importance: 'must-watch',
            watchGuide: 'wg',
            segments: [
              {
                timestamp: 999,
                endTimestamp: 9999,
                startCueId: 3,
                endCueId: 3,
                title: 's1',
                summary: 's1',
                importance: 'recommended',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
      subtitles: SUBTITLES,
    });

    // cue 优先于 timestamp
    expect(analysis.chapters[0]?.timestamp).toBe(50);
    expect(analysis.chapters[0]?.endTimestamp).toBe(110);
    expect(analysis.chapters[0]?.segments[0]?.timestamp).toBe(50);
    expect(analysis.chapters[0]?.segments[0]?.endTimestamp).toBe(58);
  });

  it('缺 cue id 且缺 timestamp 时清晰失败（不静默生成 0，且不写死 MiniMax）', () => {
    const parse = () =>
      parseVideoAnalysisJson({
        content: JSON.stringify({
          overview: '视频核心',
          chapters: [
            {
              // 既无 startCueId 也无 timestamp
              title: '章 A',
              summary: 'A',
              importance: 'must-watch',
              watchGuide: 'wg',
              segments: [
                {
                  title: 's1',
                  summary: 's1',
                  importance: 'recommended',
                },
              ],
            },
          ],
          inspirations: [],
        }),
        modelUsed: 'MiniMax-M3',
        sourceMode: 'subtitle',
        subtitles: SUBTITLES,
      });

    expect(parse).toThrow(/模型返回的 JSON 时间依据不完整|MissingTimeAnchor/);
    let errorMessage = '';
    try {
      parse();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).not.toContain('MiniMax 返回的 JSON');
  });

  it('不传 subtitles 时（旧 schema 仅 timestamp 输出）仍兼容', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        chapters: [
          {
            timestamp: 20,
            endTimestamp: 30,
            title: '章 A',
            summary: 'A',
            importance: 'recommended',
            watchGuide: 'wg',
            segments: [
              {
                timestamp: 22,
                endTimestamp: 28,
                title: 's1',
                summary: 's',
                importance: 'recommended',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
      // 不传 subtitles
    });

    expect(analysis.chapters[0]?.timestamp).toBe(20);
    expect(analysis.chapters[0]?.endTimestamp).toBe(30);
    expect(analysis.chapters[0]?.segments[0]?.timestamp).toBe(22);
  });

  it('不传 subtitles 且仅给 cue id → 清晰失败（cue id 无字幕无法映射）', () => {
    expect(() =>
      parseVideoAnalysisJson({
        content: JSON.stringify({
          overview: '视频核心',
          chapters: [
            {
              startCueId: 3, // 没字幕时 cue id 无法映射
              title: '章 A',
              summary: 'A',
              importance: 'must-watch',
              watchGuide: 'wg',
              segments: [],
            },
          ],
          inspirations: [],
        }),
        modelUsed: 'MiniMax-M3',
        sourceMode: 'multimodal',
        // 不传 subtitles（精准分析路径没字幕）
      }),
    ).toThrow(/时间依据不完整|MissingTimeAnchor/);
  });
});

// ---------------------------------------------------------------------------
// Round 23 必修 B2：startCueId / endCueId 端到端映射
// ---------------------------------------------------------------------------

describe('parseVideoAnalysisJson (Round 23 必修 B2: cue id 端到端)', () => {
  const SUBTITLES = [
    { start: 0, end: 6, text: 'cue 0' },
    { start: 6, end: 12, text: 'cue 1' },
    { start: 39, end: 45, text: 'cue 2 (铺垫)' },
    { start: 50, end: 58, text: 'cue 3 (主题)' },
    { start: 100, end: 110, text: 'cue 4' },
  ];

  it('模型 startCueId=3（对应 0:50）→ 最终 timestamp=50，不用模型自报 39', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        chapters: [
          {
            timestamp: 39, // 模型自报错的"提前归纳"时间
            endTimestamp: 52,
            startCueId: 3, // 实际指向 50s
            endCueId: 3,
            title: '总结市场失望的原因',
            summary: '主题段',
            importance: 'must-watch',
            watchGuide: 'wg',
            segments: [
              {
                timestamp: 39,
                endTimestamp: 52,
                startCueId: 3,
                endCueId: 3,
                title: '主题段',
                summary: 's',
                importance: 'recommended',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
      subtitles: SUBTITLES,
    });

    expect(analysis.chapters[0]?.timestamp).toBe(50);
    expect(analysis.chapters[0]?.endTimestamp).toBe(58);
    expect(analysis.chapters[0]?.segments[0]?.timestamp).toBe(50);
  });

  it('不传 subtitles 时 cue id 字段被忽略，fallback 到 timestamp（旧缓存兼容）', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        chapters: [
          {
            timestamp: 20,
            endTimestamp: 30,
            startCueId: 3, // 不传 subtitles → 忽略
            endCueId: 4,
            title: '章 A',
            summary: 'A',
            importance: 'recommended',
            watchGuide: 'wg',
            segments: [
              {
                timestamp: 22,
                endTimestamp: 28,
                title: 's1',
                summary: 's',
                importance: 'recommended',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
      // 不传 subtitles
    });

    expect(analysis.chapters[0]?.timestamp).toBe(20);
    expect(analysis.chapters[0]?.endTimestamp).toBe(30);
  });

  it('旧 chapter 缺 cue id 字段（无 startCueId）→ 不破坏现有链路，timestamp 仍生效', () => {
    const analysis = parseVideoAnalysisJson({
      content: JSON.stringify({
        overview: '视频核心',
        chapters: [
          {
            timestamp: 20,
            endTimestamp: 30,
            title: '章 A',
            summary: 'A',
            importance: 'recommended',
            watchGuide: 'wg',
            segments: [
              {
                timestamp: 22,
                endTimestamp: 28,
                title: 's1',
                summary: 's',
                importance: 'recommended',
              },
            ],
          },
        ],
        inspirations: [],
      }),
      modelUsed: 'MiniMax-M3',
      sourceMode: 'subtitle',
      subtitles: SUBTITLES,
    });

    expect(analysis.chapters[0]?.timestamp).toBe(20);
    expect(analysis.chapters[0]?.endTimestamp).toBe(30);
  });
});
