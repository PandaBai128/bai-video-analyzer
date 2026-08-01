import { describe, expect, it } from 'vitest';
import { buildVideoTimelinePrompt } from '@core/prompts/video-timeline';
import { buildVideoTimelineJsonlPrompt } from '@core/prompts/video-timeline-jsonl';
import type { SubtitleCue, VideoMetadata } from '@core/types';

const METADATA: VideoMetadata = {
  platform: 'youtube',
  videoId: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  author: 'Rick Astley',
  duration: 213,
};

const LONG_METADATA: VideoMetadata = {
  ...METADATA,
  duration: 6265,
};

const MEDIUM_METADATA: VideoMetadata = {
  ...METADATA,
  duration: 2451,
};

const BILIBILI_METADATA_WITH_CHAPTERS: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx411c7mD',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  title: 'Codex 教程',
  author: 'UP 主',
  duration: 2451,
  platformChapters: [
    { title: '项目开发', start: 1262, end: 1611 },
    { title: '插件使用', start: 1611, end: 1913 },
    { title: 'Skills', start: 1913, end: 2204 },
  ],
};

const SAMPLE_SUBTITLES: SubtitleCue[] = [
  { start: 0, end: 6, text: 'We are no strangers to love' },
  { start: 6, end: 12, text: 'You know the rules and so do I' },
  { start: 39, end: 45, text: '铺垫背景: 市场长期不温不火' },
  { start: 50, end: 58, text: '总结市场失望的原因' },
  { start: 247.5, end: 254.1, text: 'Never gonna give you up' },
  { start: 254.2, end: 261.0, text: 'Never gonna let you down' },
];

const LONG_SUBTITLES: SubtitleCue[] = Array.from({ length: 32 }, (_, index) => ({
  start: index * 200,
  end: index * 200 + 12,
  text: `长教程第 ${index + 1} 段字幕`,
}));

const MEDIUM_SUBTITLES: SubtitleCue[] = Array.from({ length: 1030 }, (_, index) => ({
  start: index * 2.38,
  end: index * 2.38 + 1.2,
  text: `40 分钟教程第 ${index + 1} 段字幕`,
}));

const OVER_CAPPED_SUBTITLES: SubtitleCue[] = Array.from({ length: 6001 }, (_, index) => ({
  start: index * 1.2,
  end: index * 1.2 + 0.8,
  text: `超长视频第 ${index + 1} 段字幕`,
}));

describe('buildVideoTimelinePrompt (Round 23 必修 B1: timeline-only)', () => {
  it('output schema 只要求 overview + chapters（不再要求复盘字段）', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).toContain('"overview"');
    expect(prompt).toContain('"chapters"');
    expect(prompt).toContain('"importance": "must-watch | recommended | optional | skip"');
    expect(prompt).toContain('"contentTag": "concept | method | demo | case | tool | setup | comparison | experience | summary | troubleshooting | transition | ad"');
    expect(prompt).toContain('importance 是轻量观看优先级');
    expect(prompt).toContain('must-watch 是稀缺标签');
    expect(prompt).toContain('contentTag 是内容类型');
    // 显式禁出复盘字段
    expect(prompt).toMatch(/不要输出[\s\S]*?coreTakeaways/);
    expect(prompt).toMatch(/不要输出[\s\S]*?reviewSummary/);
    expect(prompt).toMatch(/不要输出[\s\S]*?inspirations/);
    expect(prompt).toMatch(/不要输出[\s\S]*?watchStrategy/);
  });

  it('攻略类内容区分方法、演示、配置、工具、经验和纯过渡', () => {
    for (const prompt of [
      buildVideoTimelinePrompt({ metadata: METADATA, subtitles: SAMPLE_SUBTITLES }),
      buildVideoTimelineJsonlPrompt({ metadata: METADATA, subtitles: SAMPLE_SUBTITLES }),
    ]) {
      expect(prompt).toContain('游戏内武器、装备、配装、影画/命座和配队不属于 tool');
      expect(prompt).toContain('“专武与影画提升”应为 setup');
      expect(prompt).toContain('“后台输出循环与操作要点”应为 method');
      expect(prompt).toContain('“实战演示与结尾”如果主体是实战，应为 demo');
      expect(prompt).toContain('有明确步骤和操作要点时优先用 method');
      expect(prompt).toContain('只有转场、铺垫或引出下文');
      expect(prompt).toContain('用户可按需选看');
    }
  });

  it('不再有"复盘总结"段标题', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).not.toContain('视频核心与时间线');
    expect(prompt).not.toContain('复盘总结段');
    expect(prompt).not.toContain('reviewSummary 属于复盘');
  });

  it('overview 约束为 1-2 句（不再写"有思考深度的整体总结"）', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).toMatch(/overview.*1-2 句/);
    expect(prompt).not.toMatch(/有思考深度的整体总结/);
  });

  it('clarifies the timeline is for click-to-seek, not an article outline', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).toContain('时间线是视频导航');
  });

  it('短视频宁可章节少', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).toMatch(/短视频.*章节少/);
  });

  it('长视频不再压成 3-6 个粗章节', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: LONG_METADATA,
      subtitles: LONG_SUBTITLES,
    });

    expect(prompt).toContain('长视频（>= 60 分钟）建议 8-14 个 chapter');
    expect(prompt).toContain('chapter 起止必须跟随字幕里的真实主题边界');
    expect(prompt).not.toContain('<suggested_chapter_windows>');
    expect(prompt).not.toMatch(/w1: startCueId=0, endCueId=\d+, time=/);
    expect(prompt).not.toContain('长视频章节控制在 3-6 个');
  });

  it('30 分钟以上中长视频不再给机械预切窗口，避免真实主题边界错位', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: MEDIUM_METADATA,
      subtitles: MEDIUM_SUBTITLES,
    });

    expect(prompt).toContain('中长视频（30-60 分钟）建议 6-10 个 chapter');
    expect(prompt).toContain('不要按 5 分钟机械均分');
    expect(prompt).toContain('chapter 起止必须跟随字幕里的真实主题边界');
    expect(prompt).not.toContain('<suggested_chapter_windows>');
    expect(prompt).not.toMatch(/time=0:00-5:06/);
  });

  it('有平台章节时写入播放器章节锚点，约束后半段不再漂移', () => {
    const prompts = [
      buildVideoTimelinePrompt({
        metadata: BILIBILI_METADATA_WITH_CHAPTERS,
        subtitles: MEDIUM_SUBTITLES,
      }),
      buildVideoTimelineJsonlPrompt({
        metadata: BILIBILI_METADATA_WITH_CHAPTERS,
        subtitles: MEDIUM_SUBTITLES,
      }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('<platform_chapters>');
      expect(prompt).toContain('#3 [31:53-36:44] Skills');
      expect(prompt).toContain('优先级高于模型自行分段');
      expect(prompt).toContain('平台章节只约束 chapter 边界');
      expect(prompt).toContain('不能把 Skills / MCP / 自动化任务这类平台章节延后数分钟');
    }
  });

  it('要求小节按第一个具体子话题起点切分，避免把早已出现的动作延后到后半段', () => {
    const prompts = [
      buildVideoTimelinePrompt({
        metadata: BILIBILI_METADATA_WITH_CHAPTERS,
        subtitles: MEDIUM_SUBTITLES,
      }),
      buildVideoTimelineJsonlPrompt({
        metadata: BILIBILI_METADATA_WITH_CHAPTERS,
        subtitles: MEDIUM_SUBTITLES,
      }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('segment 标题只能覆盖一个连续子话题');
      expect(prompt).toContain('segment 的 startCueId 必须指向标题中第一个具体动作/地点/话题第一次真正出现的字幕行');
      expect(prompt).toContain('不能用 #B 作为包含前一个动作的 segment 起点');
    }
  });

  it('超过 5000 条字幕时，prompt 不会引用不可见的 cue id', () => {
    const prompts = [
      buildVideoTimelinePrompt({
        metadata: LONG_METADATA,
        subtitles: OVER_CAPPED_SUBTITLES,
      }),
      buildVideoTimelineJsonlPrompt({
        metadata: LONG_METADATA,
        subtitles: OVER_CAPPED_SUBTITLES,
      }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('#4999');
      expect(prompt).not.toContain('#5000');
      expect(prompt).not.toContain('<suggested_chapter_windows>');
    }
  });
});

describe('buildVideoTimelinePrompt (Round 23 必修 B2: cue id 锚点)', () => {
  it('字幕行带 #N cue id 编号（从 0 开始）', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    // SAMPLE_SUBTITLES 第 0 条 → "#0 [0:00-0:06]"
    expect(prompt).toContain('#0 [0:00-0:06]');
    // 第 2 条 (39-45s) → "#2 [0:39-0:45]"
    expect(prompt).toContain('#2 [0:39-0:45]');
    // 第 3 条 (50-58s) → "#3 [0:50-0:58]"
    expect(prompt).toContain('#3 [0:50-0:58]');
    // 第 4 条 (247.5-254.1) → "#4 [4:07-4:14]"
    expect(prompt).toContain('#4 [4:07-4:14]');
  });

  it('要求模型用 startCueId / endCueId 输出（不是 timestamp）', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).toContain('startCueId');
    expect(prompt).toContain('endCueId');
    // 旧 placeholder <真实字幕起点秒数> 不再出现（已替换为 cue id 模式）
    expect(prompt).not.toContain('<真实字幕起点秒数>');
  });

  it('明确：以 cue id 为准，timestamp 会被忽略', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).toMatch(/以 startCueId 为准|timestamp 会被忽略/);
  });

  it('禁止用后文主题提前命名前文铺垫（关键：0:39 vs 0:50 示例）', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    // 约束文案必须出现 "过渡 / 引出问题 / 铺垫背景" 等明确字样
    expect(prompt).toMatch(/铺垫|过渡/);
    // 明确"不能用后文主题提前命名前文铺垫"
    expect(prompt).toMatch(/不能用后文主题提前命名/);
    expect(prompt).toMatch(/不能.*后文要做的事提前当作当前整章标题/);
  });

  it('要求 startCueId / endCueId 范围合法（endCueId >= startCueId，segment ⊂ chapter）', () => {
    const prompt = buildVideoTimelinePrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
    });

    expect(prompt).toMatch(/endCueId.*≥.*startCueId|endCueId 必须 ≥ startCueId/);
    expect(prompt).toMatch(/segment.*cue range.*父 chapter/);
  });
});

describe('buildVideoTimelineJsonlPrompt', () => {
  it('长视频使用更细章节，并禁止用下一步主题提前命名前文', () => {
    const prompt = buildVideoTimelineJsonlPrompt({
      metadata: LONG_METADATA,
      subtitles: LONG_SUBTITLES,
    });

    expect(prompt).toContain('长视频（>= 60 分钟）建议 8-14 个 chapter');
    expect(prompt).toMatch(/不能.*后文要做的事提前当作当前整章标题/);
    expect(prompt).toContain('chapter 起止必须跟随字幕里的真实主题边界');
    expect(prompt).not.toContain('<suggested_chapter_windows>');
    expect(prompt).not.toContain('chapter.id 使用窗口 id');
    expect(prompt).not.toContain('长视频章节控制在 3-6 个');
  });

  it('30 分钟以上 JSONL prompt 也不再要求按窗口逐个输出 chapter', () => {
    const prompt = buildVideoTimelineJsonlPrompt({
      metadata: MEDIUM_METADATA,
      subtitles: MEDIUM_SUBTITLES,
    });

    expect(prompt).toContain('中长视频（30-60 分钟）建议 6-10 个 chapter');
    expect(prompt).toContain('不要按 5 分钟机械均分');
    expect(prompt).toContain('chapter 起止必须跟随字幕里的真实主题边界');
    expect(prompt).not.toContain('<suggested_chapter_windows>');
    expect(prompt).not.toContain('chapter.id 使用窗口 id');
    expect(prompt).toContain('"importance":"must-watch | recommended | optional | skip"');
    expect(prompt).toContain('"contentTag":"concept | method | demo | case | tool | setup | comparison | experience | summary | troubleshooting | transition | ad"');
    expect(prompt).toContain('importance 是轻量观看优先级');
    expect(prompt).toContain('must-watch 是稀缺标签');
    expect(prompt).toContain('contentTag 是内容类型');
  });

  it('JSONL prompt 明确要求最后章节覆盖到最后字幕，避免只生成 overview 或半截时间线', () => {
    const prompt = buildVideoTimelineJsonlPrompt({
      metadata: MEDIUM_METADATA,
      subtitles: MEDIUM_SUBTITLES,
    });

    expect(prompt).toContain('字幕编号范围：#0-#1029');
    expect(prompt).toContain('最后一个 chapter 的 endCueId 必须覆盖到最后字幕附近');
    expect(prompt).toContain('通常直接使用 #1029');
    expect(prompt).toContain('不能只输出 overview');
    expect(prompt).toContain('不要只覆盖视频前半段');
  });

  it('英文 JSONL prompt 使用英文用户可见字段示例', () => {
    const prompt = buildVideoTimelineJsonlPrompt({
      metadata: METADATA,
      subtitles: SAMPLE_SUBTITLES,
      outputLocale: 'en-US',
    });

    expect(prompt).toContain('Hard rule: every user-visible JSONL string value');
    expect(prompt).toContain('Short English chapter title');
    expect(prompt).toContain('Short English segment title');
    expect(prompt).not.toContain('"title":"5-14 字章节标题"');
    expect(prompt).not.toContain('"summary":"1 句话说明这一小段讲什么"');
  });
});
