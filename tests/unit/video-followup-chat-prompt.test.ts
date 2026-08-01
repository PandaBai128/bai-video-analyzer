import { describe, expect, it } from 'vitest';
import { buildFollowupChatPrompt } from '@core/prompts/video-followup-chat';
import { buildVideoContextPackage, type VideoContextPackage } from '@core/followup/video-context-package';
import { selectFollowupContext, type FollowupContext } from '@core/followup/select-followup-context';
import type {
  SubtitleCue,
  TimelineNode,
  UserAnnotation,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
} from '@core/types';

const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  author: '作者',
  duration: 600,
};

const TIMELINE: readonly TimelineNode[] = [
  { timestamp: 0, title: '开场', summary: '引入主题', importance: 'must-watch' },
  { timestamp: 120, title: '第一段', summary: '展开 A 点', importance: 'recommended' },
];

const CHAPTERS: readonly VideoChapter[] = [
  {
    timestamp: 0,
    endTimestamp: 200,
    title: '章节一',
    summary: 'A 段',
    importance: 'must-watch',
    watchGuide: '重点',
    segments: [TIMELINE[0]!, TIMELINE[1]!],
  },
];

const CUES: readonly SubtitleCue[] = [
  { start: 0, end: 5, text: '今天聊搜索算法' },
  { start: 120, end: 130, text: 'BM25 的核心思想' },
  { start: 300, end: 310, text: '深度学习排序的进展' },
  { start: 310, end: 320, text: '向量召回' },
];

const ANALYSIS: VideoAnalysis = {
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

const ANNOTATIONS: readonly UserAnnotation[] = [
  { id: 'a-1', platform: 'bilibili', videoId: 'BV1xx', timestamp: 30, content: '记一下', createdAt: 1 },
];

function buildPackage(): VideoContextPackage {
  return buildVideoContextPackage({
    metadata: METADATA,
    analysis: ANALYSIS,
    transcriptCues: CUES,
    annotations: ANNOTATIONS,
  });
}

function selectFor(pkg: VideoContextPackage, question: string): FollowupContext {
  return selectFollowupContext({ question, contextPackage: pkg });
}

describe('buildFollowupChatPrompt (追问 prompt 必含项)', () => {
  // QA1 必修 1 后：原硬性约束里的"只基于上下文 / 禁止训练数据补充 / 禁止跨视频"
  // 移出共同约束，仅由 video_only basis 块承担。下面这组断言改用新的共同约束措辞。
  it('system prompt 共同约束：视频事实必须来自 <video_context>', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/视频事实必须来自 <video_context>/);
    // 视频里没有的事实不要编造（公共底线）
    expect(system).toMatch(/视频里没有的事实不要编造/);
  });

  it('system prompt 明确说"不知道就说不知道"', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/不知道.*说不知道|不确定.*说不知道/);
  });

  it('system prompt 要求"给时间点依据"', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/时间点依据|mm:ss|hh:mm:ss/);
    expect(system).toMatch(/字幕 cue 的\*\*开始时间\*\*|取对应字幕 cue 的.*开始时间/);
    expect(system).toMatch(/最多只允许比开始时间提前 1 秒|不能提前更多/);
  });

  it('system prompt 默认中文回答语言', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/回答语言：中文/);
    expect(system).toMatch(/用户用中文提问/);
  });

  it('system prompt 共同约束：围绕当前视频 + 礼貌拒绝通用聊天', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/围绕当前视频/);
    expect(system).toMatch(/请围绕当前视频内容提问/);
  });

  it('system prompt 共同约束：提问服务学习理解，证据不足时不能硬下结论', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频有哪些观点值得参考？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频有哪些观点值得参考？'),
    });
    expect(system).toMatch(/bAI 视频分析助手/);
    expect(system).toMatch(/学习追问助手/);
    expect(system).toMatch(/视频整体讲了什么|当前片段怎么理解|从这里往后重点怎么看|核心观点和保留意见/);
    expect(system).toMatch(/仅凭当前视频证据无法判断/);
    expect(system).toMatch(/不要用通识替用户下视频结论/);
  });

  it('system prompt 约束提问页不要搬分析页或导航页模板', () => {
    const { system } = buildFollowupChatPrompt({
      question: '整体讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '整体讲什么？'),
    });
    expect(system).toContain('提问页不要搬分析页或导航页模板');
    expect(system).toMatch(/完整细看.*选择性看.*快速浏览/);
    expect(system).toMatch(/观看路线|适合不适合|最值得看|可轻放/);
  });

  it('system prompt 共同约束：不要假装看过其他视频', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/不要假装看过其他视频/);
  });
});

describe('buildFollowupChatPrompt (user prompt 内容)', () => {
  it('把视频 metadata 写入 user prompt', () => {
    const { user } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(user).toContain('测试视频');
    expect(user).toContain('作者');
    expect(user).toContain('bilibili');
    expect(user).toContain('BV1xx');
  });

  it('把字幕 cue 写入 transcript_cues 块', () => {
    const { user } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(user).toContain('<transcript_cues>');
    expect(user).toContain('BM25');
  });

  it('把时间线节点写入 timeline_nodes 块', () => {
    const { user } = buildFollowupChatPrompt({
      question: '5:05 这段在讲什么',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '5:05 这段在讲什么'),
    });
    expect(user).toContain('<timeline_nodes>');
  });

  it('把用户问题原文追加到末尾', () => {
    const { user } = buildFollowupChatPrompt({
      question: '这段在讲 BM25 吗？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这段在讲 BM25 吗？'),
    });
    expect(user).toContain('用户问题：');
    expect(user).toContain('这段在讲 BM25 吗？');
  });

  it('user prompt 标记本轮上下文为内部证据窗口，不暴露本轮候选条数', () => {
    const pkg = buildPackage();
    const selectedContext = selectFor(pkg, '这个视频主要讲什么？');
    const { user } = buildFollowupChatPrompt({
      question: '字幕一共有多少条？',
      contextPackage: pkg,
      selectedContext,
    });

    expect(user).toContain('<content_inventory>');
    expect(user).toContain('本轮上下文：已按问题、时间点和视频结构选取相关字幕');
    expect(user).toContain('当前上下文窗口不是全片字幕总量');
    expect(user).toContain('不要在用户可见回答中提到字幕条数、采样、候选字幕或上下文窗口');
    expect(user).not.toContain(`完整字幕条数：${pkg.transcriptCues.length}`);
    expect(user).not.toContain(`本轮提供字幕条数：${selectedContext.selectedTranscriptCues.length}`);
    expect(user).not.toContain('不能把本轮条数当作视频总字幕条数');
  });

  it('关键词未命中时只标记精确未命中，不强迫模型直接回答否', () => {
    const { user } = buildFollowupChatPrompt({
      question: '有没有提到 transformer？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '有没有提到 transformer？'),
    });
    expect(user).toContain('<keyword_search>');
    expect(user).toContain('命中片段数：0');
    expect(user).toContain('完整字幕精确检索没有找到完全一致的字面词');
    expect(user).toContain('不要直接回答"否"');
    // 显式移除旧工程话术
    expect(user).not.toMatch(/未在字幕上下文中提到|未在上下文中提到/);
    expect(user).not.toContain('请直接回答"否');
  });

  it('关键词命中时给命中时间点列表', () => {
    const { user } = buildFollowupChatPrompt({
      question: '有没有提到 BM25？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '有没有提到 BM25？'),
    });
    expect(user).toContain('BM25');
    expect(user).toMatch(/命中时间点/);
  });

  it('时间线标题命中时，即使字幕没有逐字命中也用时间线回答位置问题', () => {
    const timeline: readonly TimelineNode[] = [
      {
        timestamp: 1836,
        endTimestamp: 2089,
        title: 'NotebookLM MCP 接入演示',
        summary: '演示 MCP 配置过程。',
        importance: 'recommended',
      },
    ];
    const chapters: readonly VideoChapter[] = [
      {
        timestamp: 1836,
        endTimestamp: 2089,
        title: 'NotebookLM MCP 接入演示',
        summary: '演示 MCP 配置过程。',
        importance: 'recommended',
        watchGuide: '看配置过程即可。',
        segments: timeline,
      },
    ];
    const pkg = buildVideoContextPackage({
      metadata: { ...METADATA, duration: 2451 },
      analysis: { ...ANALYSIS, timeline, chapters },
      transcriptCues: [
        { start: 1836, end: 1842, text: '这里开始配置一个外部工具。' },
      ],
    });

    const selected = selectFollowupContext({
      question: 'Notebook LM 在第几分钟？',
      contextPackage: pkg,
    });

    expect(selected.primaryScope).toBe('timeline_match');
    expect(selected.selectedTimelineItems[0]?.timestamp).toBe(1836);

    const { user } = buildFollowupChatPrompt({
      question: 'Notebook LM 在第几分钟？',
      contextPackage: pkg,
      selectedContext: selected,
    });

    expect(user).toContain('字幕检索没有直接命中，但时间线/章节标题或摘要已经命中');
    expect(user).toContain('必须优先原样使用这些标题和时间范围');
    expect(user).toContain('不要改写成另一个能力编号');
    expect(user).toContain('[30:36-34:49] NotebookLM MCP 接入演示');
    expect(user).not.toContain('视频字幕里没有完全一致的');
  });

  it('位置类问法会用提取后的主题命中时间线节点，避免退回全局上下文', () => {
    const timeline: readonly TimelineNode[] = [
      {
        timestamp: 20 * 60 + 14,
        endTimestamp: 23 * 60 + 26,
        title: '计划模式与需求确认',
        summary: '演示用计划模式让 Codex 输出建站计划并补充 image2 配图要求。',
        importance: 'must-watch',
      },
    ];
    const pkg = buildVideoContextPackage({
      metadata: { ...METADATA, duration: 2451 },
      analysis: {
        ...ANALYSIS,
        timeline,
        chapters: [
          {
            timestamp: 20 * 60 + 14,
            endTimestamp: 26 * 60 + 38,
            title: '能力四：生图与个人主页开发',
            summary: '用 Codex 计划模式开发个人主页网站。',
            importance: 'must-watch',
            watchGuide: '看计划模式即可。',
            segments: timeline,
          },
        ],
      },
      transcriptCues: [
        { start: 21 * 60 + 30, end: 21 * 60 + 36, text: '我们确认之后它再开始行动。' },
      ],
    });

    const selected = selectFollowupContext({
      question: '计划模式的讲解在哪里',
      contextPackage: pkg,
    });

    expect(selected.primaryScope).toBe('timeline_match');
    expect(selected.selectedTimelineItems[0]?.title).toBe('计划模式与需求确认');

    const { user } = buildFollowupChatPrompt({
      question: '计划模式的讲解在哪里',
      contextPackage: pkg,
      selectedContext: selected,
    });

    expect(user).toContain('[20:14-23:26] 计划模式与需求确认');
    expect(user).toContain('不要改写成另一个能力编号');
  });
});

describe('buildFollowupChatPrompt (Round 15 必修 1 排版策略)', () => {
  it('system prompt 包含"排版策略"段，且提到 Markdown 表格 / 加粗 / emoji 视觉锚点', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/排版策略/);
    // Markdown 表格策略
    expect(system).toMatch(/Markdown 表格/);
    // 加粗
    expect(system).toMatch(/\*\*加粗\*\*/);
    // 3+ 并列项触发表格
    expect(system).toMatch(/3 个及以上.*表格|3 个以上.*表格|并列项.*表格/);
    // emoji 视觉锚点（不强制每个回答都加）
    expect(system).toMatch(/🎯|📌|🧭/);
    // 不要禁用 Markdown
    expect(system).not.toMatch(/禁用 Markdown|不要使用 Markdown/);
    // 不要强制每次都表格
    expect(system).not.toMatch(/必须每次都表格|每次.*表格/);
  });

  it('提问 prompt 不再夹带正式学习笔记模板或用户记录', () => {
    const { system, user } = buildFollowupChatPrompt({
      question: '整理成学习笔记',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '整理成学习笔记'),
    });
    expect(system).toContain('正式学习笔记请到"笔记"页生成');
    expect(system).not.toContain('我的记录');
    expect(system).not.toContain('<如果上下文包含用户记录');
    expect(user).not.toContain('<user_annotations>');
    expect(user).not.toContain('记一下');
  });

  it('system prompt 保留硬性约束：视频事实必须来自上下文 / 不知道 / 围绕当前视频', () => {
    const { system } = buildFollowupChatPrompt({
      question: '这个视频讲什么？',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '这个视频讲什么？'),
    });
    expect(system).toMatch(/视频事实必须来自 <video_context>/);
    expect(system).toMatch(/不确定就说不知道/);
    expect(system).toMatch(/围绕当前视频/);
  });
});

describe('buildFollowupChatPrompt (Round 15 必修 2 D focus_anchor)', () => {
  it('current_segment 路径：user prompt 包含 <focus_anchor> 块 + "当前播放位置" + 格式化后的时间', () => {
    const pkg = buildPackage();
    const selected = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: pkg,
      currentTime: 271, // 4:31
    });
    expect(selected.anchorLabel).toBe('current_time');
    const { user } = buildFollowupChatPrompt({
      question: '解释当前片段',
      contextPackage: pkg,
      selectedContext: selected,
    });
    expect(user).toContain('<focus_anchor>');
    expect(user).toContain('</focus_anchor>');
    expect(user).toContain('当前播放位置');
    // 4:31 格式
    expect(user).toMatch(/时间：4:31|时间：4:31/);
  });

  it('explicit_time 路径：focus_anchor 标注"用户在问题里写出的时间点"', () => {
    const pkg = buildPackage();
    const selected = selectFollowupContext({
      question: '5:05 这段在讲什么',
      contextPackage: pkg,
    });
    expect(selected.anchorLabel).toBe('explicit_time');
    const { user } = buildFollowupChatPrompt({
      question: '5:05 这段在讲什么',
      contextPackage: pkg,
      selectedContext: selected,
    });
    expect(user).toContain('<focus_anchor>');
    expect(user).toMatch(/用户在问题里写出的时间点/);
    expect(user).toContain('时间：5:05');
  });

  it('selected_segment 路径：focus_anchor 标注"用户点选的时间线节点"', () => {
    const pkg = buildPackage();
    const selected = selectFollowupContext({
      question: '这段在讲什么',
      contextPackage: pkg,
      selectedTimestamp: 120,
    });
    expect(selected.anchorLabel).toBe('selected_timestamp');
    const { user } = buildFollowupChatPrompt({
      question: '这段在讲什么',
      contextPackage: pkg,
      selectedContext: selected,
    });
    expect(user).toContain('<focus_anchor>');
    expect(user).toMatch(/用户点选的时间线节点/);
    expect(user).toContain('时间：2:00');
  });

  it('global / keyword_match 路径：user prompt 不带 <focus_anchor> 块', () => {
    const pkg = buildPackage();
    const global = selectFollowupContext({
      question: '整体讲什么',
      contextPackage: pkg,
    });
    const { user: globalUser } = buildFollowupChatPrompt({
      question: '整体讲什么',
      contextPackage: pkg,
      selectedContext: global,
    });
    expect(globalUser).not.toContain('<focus_anchor>');

    const kw = selectFollowupContext({
      question: '有没有提到 BM25？',
      contextPackage: pkg,
    });
    const { user: kwUser } = buildFollowupChatPrompt({
      question: '有没有提到 BM25？',
      contextPackage: pkg,
      selectedContext: kw,
    });
    expect(kwUser).not.toContain('<focus_anchor>');
  });
});

describe('buildFollowupChatPrompt (Round 15 必修 2 E 解释当前片段)', () => {
  it('system prompt 解释当前片段段：必须引用 <focus_anchor> 时间；不要回答"未指明时间点"当 anchor 存在', () => {
    const { system } = buildFollowupChatPrompt({
      question: '解释当前片段',
      contextPackage: buildPackage(),
      selectedContext: selectFor(buildPackage(), '解释当前片段'),
    });
    expect(system).toMatch(/解释当前片段/);
    expect(system).toMatch(/<focus_anchor>/);
    expect(system).toMatch(/未指明是哪个时间点|未指明时间点/);
    // 必须先引用 anchor 时间
    expect(system).toMatch(/引用.*时间|必须先引用|开头引用/);
  });
});

describe('buildFollowupChatPrompt (Round 16 必修 1 + Round 17 必修 B transcript_cues 兜底)', () => {
  it('transcriptFallback=true 时用结构化 <context_quality> 块代替"附近字幕兜底"', () => {
    const pkg = buildPackage();
    const selected = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: pkg,
      currentTime: 500,
      forceCurrentSegment: true,
    });
    // pkg.transcriptCues 没覆盖 500s，主窗口无 cue；不过 selectFollowupContext
    // 内部 pickCuesInRange + applyTranscriptFallback 会取最近的 N 条 cue
    expect(selected.transcriptFallback).toBe(true);
    const { user } = buildFollowupChatPrompt({
      question: '解释当前片段',
      contextPackage: pkg,
      selectedContext: selected,
    });
    // Round 17 必修 B：fallback 改用 <context_quality transcript="nearest_fallback" />
    // 结构化元信息，不再写"附近字幕兜底"给模型照搬
    expect(user).toContain('<context_quality transcript="nearest_fallback" />');
    // <transcript_cues> 块本身不再含"附近字幕兜底"
    expect(user).not.toContain('附近字幕兜底');
  });

  it('transcriptFallback 未设时 <transcript_cues> 块不出现 <context_quality>', () => {
    const pkg = buildPackage();
    const selected = selectFollowupContext({
      question: '5:05 这段',
      contextPackage: pkg,
    });
    // 5:05 = 305s，cue start 300-320 命中，transcriptFallback 不应被设
    expect(selected.transcriptFallback).toBeFalsy();
    const { user } = buildFollowupChatPrompt({
      question: '5:05 这段',
      contextPackage: pkg,
      selectedContext: selected,
    });
    expect(user).not.toContain('<context_quality');
  });

  it('全视频 0 cue 时 <transcript_cues> 标"anchor 附近没有逐字稿"（不是"无相关字幕"）', () => {
    const pkg: VideoContextPackage = {
      ...buildPackage(),
      transcriptCues: [],
    };
    const selected = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: pkg,
      currentTime: 50,
      forceCurrentSegment: true,
    });
    const { user } = buildFollowupChatPrompt({
      question: '解释当前片段',
      contextPackage: pkg,
      selectedContext: selected,
    });
    expect(user).toContain('anchor 附近没有逐字稿');
    // 显式确认旧文案被替换
    expect(user).not.toContain('（无相关字幕）');
  });

  it('Round 17 必修 B + Round 18 必修 2：system prompt 含"不要输出字幕/章节/时间线等内部标签"约束 + 自然表达', () => {
    const pkg = buildPackage();
    const { system } = buildFollowupChatPrompt({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
      selectedContext: selectFollowupContext({
        question: '这个视频主要讲什么',
        contextPackage: pkg,
      }),
    });
    // Round 17 必修 B：仍然告诉模型**不要**输出这些内部标签
    expect(system).toContain('字幕：');
    expect(system).toContain('章节：');
    expect(system).toContain('时间线：');
    expect(system).toContain('附近字幕兜底');
    expect(system).toContain('附近字幕不足');
    expect(system).toContain('采样字幕');
    expect(system).toContain('候选片段');
    expect(system).toContain('上下文窗口');
    // Round 18 必修 2：给 LLM 一个"自然表达"模板，而不是让模型照搬"附近字幕不足"字面
    expect(system).toContain('附近逐字稿较少');
    // 硬约束：不要写"回答：/依据：/可以继续问："三段式
    expect(system).toContain('不要');
    expect(system).toMatch(/回答：\/依据：\/可以继续问：/);
    // "可以继续问" 小节明确是"可选"小节
    expect(system).toMatch(/可选.*末尾小节/);
  });

  it('Round 17 必修 D：system prompt 含"可以继续问"输出规范（2 个短问题 / 每行 - 开头 / ？结尾）', () => {
    const pkg = buildPackage();
    const { system } = buildFollowupChatPrompt({
      question: '播放速度怎么样',
      contextPackage: pkg,
      selectedContext: selectFollowupContext({
        question: '播放速度怎么样',
        contextPackage: pkg,
      }),
    });
    expect(system).toContain('小节内');
    expect(system).toContain('只放 2 个短问题');
    expect(system).toMatch(/每行必须以.*开头/);
    expect(system).toContain('？');
  });

  it('英文提问时，继续追问小节必须使用英文 heading', () => {
    const pkg = buildPackage();
    const { system } = buildFollowupChatPrompt({
      question: 'What is this video about?',
      contextPackage: pkg,
      selectedContext: selectFollowupContext({
        question: 'What is this video about?',
        contextPackage: pkg,
      }),
    });

    expect(system).toContain('You can ask next:');
    expect(system).toContain('Never output the Chinese heading "可以继续问"');
    expect(system).toContain('英文回答中禁止输出"可以继续问"');
  });
});

// ---------------------------------------------------------------------------
// Round 29B 必修 B：transcript-only global 的 primary_scope 描述要诚实
// ---------------------------------------------------------------------------

describe('buildFollowupChatPrompt (Round 29B 必修 B transcript-only prompt 描述)', () => {
  it('必修 B-1: transcript-only global 的 <primary_scope> 不能再说"少量代表性字幕"', () => {
    // 构造 transcript-only global：ctx.selectedTranscriptCues 数量 ≥ 24
    // （isTranscriptOnlyGlobal 启发式阈值）。
    const cues: readonly SubtitleCue[] = Array.from({ length: 30 }, (_, i) => ({
      start: i * 20,
      end: i * 20 + 5,
      text: `cue-${i}`,
    }));
    const basePkg: VideoContextPackage = {
      ...buildPackage(),
      timeline: [],
      chapters: [],
      review: { keyPoints: [], summary: '' },
      duration: 600,
    };
    const pkg: VideoContextPackage = {
      ...basePkg,
      transcriptCues: cues,
    };
    const selected = selectFollowupContext({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
    });
    expect(selected.primaryScope).toBe('global');
    expect(selected.selectedTranscriptCues.length).toBeGreaterThanOrEqual(24);
    const { user } = buildFollowupChatPrompt({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
      selectedContext: selected,
    });
    // transcript-only 模式下，<primary_scope> 必须强调"按全片时间分布提供证据"
    expect(user).toContain('按全片时间分布提供字幕证据');
    // 不应该误导模型"只有少量代表性字幕"
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    expect(scopeBlock).not.toContain('少量代表性字幕');
    // 不应该出现内部话术
    expect(scopeBlock).not.toMatch(/transcript-only|global strategy/);
  });

  it('必修 B-2: 有派生分析时 <primary_scope> 仍写"按全片时间分布提供字幕证据"（SG-05B §4：删除"少量代表性字幕"分支）', () => {
    // SG-05B §4：删除"有派生分析就只取前 8 条字幕"行为 — 那是 §1 提到的真实用户 bug。
    // 现在无论 timeline / chapters / review 是否存在，global 都从全片均匀采样，
    // prompt 描述统一写"按全片时间分布提供字幕证据，覆盖开头 / 中段 / 结尾"。
    const pkg = buildPackage();
    const selected = selectFollowupContext({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
    });
    expect(selected.primaryScope).toBe('global');
    // SG-05B 后 globalContextMode 总是 'transcript_only'（不再按派生分析分流）
    expect(selected.globalContextMode).toBe('transcript_only');
    const { user } = buildFollowupChatPrompt({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
      selectedContext: selected,
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    expect(scopeBlock).toContain('按全片时间分布提供字幕证据');
    // 不再误触发"少量代表性字幕"文案
    expect(scopeBlock).not.toContain('少量代表性字幕');
  });

  it('必修 B-3: transcript-only 但 cues < 24（旧启发式阈值）时 prompt 仍写"按全片时间分布提供字幕证据"', () => {
    // 验收：Round 29B QA 必修 B 关键防线 —— 稀疏字幕（4 条 < 24 阈值）下
    // 旧启发式会漏判 transcript-only；显式字段必须正确。
    const cues: readonly SubtitleCue[] = [
      { start: 0, end: 5, text: 'cue-0' },
      { start: 200, end: 205, text: 'cue-200' },
      { start: 400, end: 405, text: 'cue-400' },
      { start: 590, end: 595, text: 'cue-590' },
    ];
    const basePkg: VideoContextPackage = {
      ...buildPackage(),
      timeline: [],
      chapters: [],
      review: { keyPoints: [], summary: '' },
      duration: 600,
      transcriptCues: cues,
    };
    const pkg: VideoContextPackage = { ...basePkg };
    const selected = selectFollowupContext({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
    });
    expect(selected.primaryScope).toBe('global');
    expect(selected.globalContextMode).toBe('transcript_only');
    // cues 只有 4 条 —— 旧启发式（≥ 24）会漏判
    expect(selected.selectedTranscriptCues.length).toBeLessThan(24);
    const { user } = buildFollowupChatPrompt({
      question: '这个视频主要讲什么',
      contextPackage: pkg,
      selectedContext: selected,
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    // 显式字段判断正确 → 仍写"按全片时间分布提供字幕证据"
    expect(scopeBlock).toContain('按全片时间分布提供字幕证据');
    // 不写"少量代表性字幕"（旧启发式 bug 漏判时会写）
    expect(scopeBlock).not.toContain('少量代表性字幕');
    // 不出现内部话术
    expect(scopeBlock).not.toMatch(/transcript-only|global strategy/);
  });
});

describe('buildFollowupChatPrompt (回答依据 answerBasis 行为)', () => {
  // QA1 必修 1 关键防线：检查**完整 system prompt**，不只是 basis 块。
  // 共同约束必须两种 mode 都成立；mode-specific 行为由 basis 块单独承担。
  // 之前硬性约束里的"不要用训练数据补 / 不要引用课程体系外的知识 / 只能引用
  // <video_context>"在 video_plus_general 模式下会直接抵消 basis 块 → 必须移出。

  const pkg = buildPackage();
  const selected = selectFor(pkg, 'BM25 的核心思想');

  // 合并：默认（undefined）和显式 video_only 走同一严格路径，用 it.each 一次性覆盖。
  it.each([
    ['默认值（不传 answerBasis）', undefined],
    ['显式 video_only', 'video_only' as const],
  ])('video_only 严格模式（%s）→ basis 块要求不使用模型通识，不允许视频事实外的补充', (_label, answerBasis) => {
    const { system } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
      ...(answerBasis !== undefined ? { answerBasis } : {}),
    });
    // basis 块：仅视频上下文 / 不使用模型通识 / 不主动补充背景
    expect(system).toMatch(/回答依据.*仅视频上下文|回答依据.*video_only/);
    expect(system).toMatch(/不使用模型通识|不.*主动补充背景/);
    // basis 块不能是 video_plus_general
    expect(system).not.toMatch(/回答依据.*video_plus_general/);
    expect(system).not.toMatch(/补充理解（通识）/);
    expect(system).not.toMatch(/不得.*声称已联网/);
    // 公共约束仍存在
    expect(system).toMatch(/视频事实必须来自 <video_context>/);
    expect(system).toMatch(/围绕当前视频/);
    expect(system).toMatch(/视频事实给时间点依据/);
  });

  it('video_plus_general → basis 块允许通识补充，但要求区分视频内容 / 补充理解（通识）/ 不得冒充联网', () => {
    const { system } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
      answerBasis: 'video_plus_general',
    });
    expect(system).toMatch(/回答依据.*video_plus_general/);
    // 视频优先 / 来源分隔
    expect(system).toMatch(/\*\*视频内容\*\*/);
    expect(system).toMatch(/\*\*补充理解（通识）\*\*/);
    // 通识补充不能伪装成视频原话
    expect(system).toMatch(/不能.*伪装成视频原话|不能.*伪装成视频/);
    // 不得冒充联网 / 不得伪造引用
    expect(system).toMatch(/不得.*声称已联网/);
    expect(system).toMatch(/不提供伪造.*实时信息|不提供.*引用/);
    // 不能退化成通用聊天
    expect(system).toMatch(/不能退化成通用聊天/);
  });

  it('video_plus_general → 完整 system prompt 不再含与通识模式冲突的硬性约束（QA1 必修 1 核心）', () => {
    const { system } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
      answerBasis: 'video_plus_general',
    });
    // 原来硬性约束里的三句直接抵消通识模式，必须在 video_plus_general 的 prompt 里消失：
    expect(system).not.toMatch(/不要用训练数据补/);
    expect(system).not.toMatch(/不要引用课程体系外的知识/);
    expect(system).not.toMatch(/只能引用 <video_context>/);
    // basis 块也不能错认为"仅视频上下文"
    expect(system).not.toMatch(/回答依据.*仅视频上下文/);
  });

  it('video_only → 完整 system prompt 仍含公共约束（视频事实 / 视频依据 / 不编造）', () => {
    const { system } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
      answerBasis: 'video_only',
    });
    // 公共约束保留
    expect(system).toMatch(/视频事实必须来自 <video_context>/);
    expect(system).toMatch(/围绕当前视频/);
    expect(system).toMatch(/视频事实给时间点依据/);
    expect(system).toMatch(/不确定就说不知道/);
    // basis 块额外要求：不用训练数据补齐视频没讲的内容
    expect(system).toMatch(/不使用模型训练数据|不使用模型通识|不.*主动补充背景/);
  });

  it('两种 mode 的 system prompt 都不引入 web 协议块（联网是产品预留位，不在 prompt 伪造协议）', () => {
    const vo = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
      answerBasis: 'video_only',
    });
    const vpg = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
      answerBasis: 'video_plus_general',
    });
    expect(vo.system).not.toMatch(/web.*basis|联网.*回答依据|web.*回答依据/);
    expect(vpg.system).not.toMatch(/web.*basis|联网.*回答依据|web.*回答依据/);
  });
});

// ---------------------------------------------------------------------------
// QA2 必修：global user prompt 的 scope 块必须按 answerBasis 分模式。
// 之前固定文案"请基于字幕内容回答 / 最多说『我在当前字幕里没有找到足够明确的
// 对应内容』"在 user prompt 里会压制 video_plus_general → 现在按 mode 分流。
// 不新增文件，只在本文件追加；保留 QA1 已有的完整 system prompt 冲突测试。
// ---------------------------------------------------------------------------

describe('buildFollowupChatPrompt (QA2 必修: global user prompt 按 answerBasis 分模式)', () => {
  const pkg = buildPackage();
  // 显式构造 global scope 的最小 FollowupContext，避免 selectFollowupContext
  // 路由层把"BM25 的核心思想"分到 question_match / keyword_match 等其它 scope。
  // 本组测例只关心 renderScopeDescription('global') 在不同 answerBasis 下的输出。
  const globalSelected: FollowupContext = {
    primaryScope: 'global',
    selectedTimelineItems: [],
    selectedTranscriptCues: [],
    selectedChapters: [],
    reviewSummary: '',
    overviewLine: '',
    globalContextMode: 'transcript_only',
  };

  it('video_only + global → user prompt scope 块保持原严格措辞（不压制通识，因为本来就不允许）', () => {
    const { user } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: globalSelected,
      answerBasis: 'video_only',
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    // video_only 保持原严格措辞：必须包含"请基于字幕内容回答"+"最多说『没有找到』"
    expect(scopeBlock).toMatch(/请基于字幕内容回答/);
    expect(scopeBlock).toMatch(/最多说.*没有找到足够明确的对应内容/);
    // 不能在 scope 块里出现"按上方 basis 规则输出"这种通识引导
    expect(scopeBlock).not.toMatch(/按上方 basis 规则.*补充理解/);
  });

  it('video_plus_general + global → user prompt scope 块明确允许按 basis 规则补通识，不再固定压制（QA2 核心）', () => {
    const { user } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: globalSelected,
      answerBasis: 'video_plus_general',
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    // 不能写"最多说『没有找到足够明确的对应内容』"作为唯一路径
    expect(scopeBlock).not.toMatch(/最多说.*没有找到足够明确的对应内容/);
    // 不能固定要求"请基于字幕内容回答"后就结束（这是 QA1 修复前压制通识的措辞）
    expect(scopeBlock).not.toMatch(/请基于字幕内容回答/);
    // 必须明确允许按 basis 规则补通识
    expect(scopeBlock).toMatch(/按上方 basis 规则.*补充理解（通识）|按上方 basis 规则.*补充理解/);
    // 视频事实仍只能来自 <video_context>（QA2 明确：通识不能伪装视频原话）
    expect(scopeBlock).toMatch(/视频事实只能基于上方 <video_context>/);
    // 不能为通识内容编造视频时间点
    expect(scopeBlock).toMatch(/不要.*为通识内容编造视频时间点/);
  });

  it('video_plus_general + global → 仍然保留"按全片时间分布提供字幕证据"说明（继承原 global 文案前半段）', () => {
    const { user } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: globalSelected,
      answerBasis: 'video_plus_general',
    });
    const scopeBlock = user.match(/<primary_scope>([\s\S]*?)<\/primary_scope>/)?.[1] ?? '';
    // QA2 只改了后段（命中后行为），前段"按全片时间分布提供字幕证据"必须保留
    expect(scopeBlock).toMatch(/按全片时间分布提供字幕证据/);
  });
});

// ---------------------------------------------------------------------------
// 同一视频内有限多轮追问：conversationHistory 透传到 user prompt。
// QA1 测试压缩：保留空历史 + 模型可见证据边界两类关键行为。
// ---------------------------------------------------------------------------

describe('buildFollowupChatPrompt (conversationHistory 透传 + QA1 必修 2 证据边界)', () => {
  const pkg = buildPackage();
  const selected = selectFor(pkg, 'BM25 的核心思想');

  it('空 / 缺失 conversationHistory → user prompt 不渲染 <conversation_history> 块和 instruction（首问 prompt 精简）', () => {
    const { user: userDefault } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
    });
    expect(userDefault).not.toMatch(/<conversation_history>/);
    expect(userDefault).not.toMatch(/历史证据边界/);

    const { user: userEmpty } = buildFollowupChatPrompt({
      question: 'BM25 的核心思想',
      contextPackage: pkg,
      selectedContext: selected,
      conversationHistory: [],
    });
    expect(userEmpty).not.toMatch(/<conversation_history>/);
    expect(userEmpty).not.toMatch(/历史证据边界/);
  });

  it('QA1 必修 2：携带历史时 user prompt 在 <conversation_history> 块前渲染模型可见的"历史证据边界" instruction（5 条规则）', () => {
    const { user } = buildFollowupChatPrompt({
      question: '我问的是优点',
      contextPackage: pkg,
      selectedContext: selected,
      conversationHistory: [
        { role: 'user', content: 'ChatGPT 的优势是什么？' },
        { role: 'assistant', content: '优点：效率高，缺点：依赖数据量' },
      ],
    });
    // instruction 必须包含 5 条模型可见规则（不能用"块里没有视频字样"代替）
    expect(user).toMatch(/历史证据边界/);
    // 1. 历史仅用于理解当前问题的指代 / 纠正 / 延续关系
    expect(user).toMatch(/指代.*纠正.*延续|延续关系/);
    // 2. 历史中的助手回答可能错误，不是视频证据
    expect(user).toMatch(/可能错误|可能.*误述|不是视频证据/);
    // 3. 视频事实只能来自 <video_context>
    expect(user).toMatch(/视频事实只能来自.*<video_context>/);
    // 4. 当前 video_only / video_plus_general 规则优先于历史回答
    expect(user).toMatch(/video_only.*video_plus_general.*优先|优先于历史/);
    // 5. video_only 不得复用历史通识补充作为答案依据
    expect(user).toMatch(/video_only.*通识|通识.*当前.*依据/);

    // <conversation_history> 块本身仍存在
    expect(user).toMatch(/<conversation_history>/);
    expect(user).toMatch(/用户：ChatGPT 的优势是什么？/);
    expect(user).toMatch(/助手：优点：效率高，缺点：依赖数据量/);

    // 顺序：instruction < conversation_history < video_context（真正的块）
    // 注意：user prompt 字符串里有两处 "<video_context>" 字样——instruction 里
    // 提到"下方 <video_context>"，以及真正的 user 上下文块开头。
    // 这里锚定真正的 user 块：`<video_context>\n标题：` 才算真正的块。
    const instructionIdx = user.indexOf('历史证据边界');
    const historyIdx = user.indexOf('<conversation_history>');
    const videoCtxBlockIdx = user.indexOf('<video_context>\n标题：');
    expect(instructionIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThan(instructionIdx);
    expect(videoCtxBlockIdx).toBeGreaterThan(historyIdx);
  });
});
