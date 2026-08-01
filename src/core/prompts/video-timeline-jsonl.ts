import type { SubtitleCue, VideoMetadata } from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import {
  createChapterDensityGuidance,
  createCueBoundaryGuidance,
  createPlatformChapterAnchorBlock,
  createPlatformChapterAnchorGuidance,
  createSubtitleCoverageGuidance,
  createTimelineClassificationGuidance,
  formatSubtitleTimeRange,
} from './video-timeline-prompt-utils';

const MAX_SUBTITLE_CUES = 5000;

/**
 * Round 24 QA2 必修 B：JSONL 流式 prompt。
 *
 * 历史：旧 `buildVideoTimelinePrompt` 让 LLM 输出一个完整的 JSON object
 *   `{ overview, chapters: [...] }`。流式收 chunk 阶段会拿到半截 JSON
 *   文本，UI 没法稳定地从中解析半截结构（按 handoff §4 不接受方案）。
 *
 * 新版：要求 LLM **逐行**输出 JSON Lines，每行一个完整 JSON object，类型
 *   必为 `overview` / `chapter` / `segment` / `done` 之一。controller 行
 *   buffer 解析后推结构化 partial 事件给 side panel，UI 渲染可读进度 +
 *   overview 草稿 + chapter 卡片。
 *
 * 要求（与 handoff §4 JSONL 格式对应）：
 * - 每行必须是完整 JSON object（以 { 开头、} 结尾）
 * - 不输出 Markdown
 * - 不输出包裹数组
 * - 不输出外层 `{ chapters: [...] }`
 * - `chapter` / `segment` 必须带 `startCueId/endCueId`，沿用 cue id 锚点
 * - `done` 事件单独一行
 *
 * 输出协议示例：
 * ```jsonl
 * {"type":"overview","text":"这个视频主要讲..."}
 * {"type":"chapter","id":"c1","startCueId":0,"endCueId":12,"title":"开场与问题提出","summary":"..."}
 * {"type":"segment","chapterId":"c1","startCueId":0,"endCueId":4,"title":"提出问题","summary":"..."}
 * {"type":"chapter","id":"c2","startCueId":13,"endCueId":30,"title":"核心论证","summary":"..."}
 * {"type":"done"}
 * ```
 */
export function buildVideoTimelineJsonlPrompt(input: {
  readonly metadata: VideoMetadata;
  readonly subtitles?: readonly SubtitleCue[];
  readonly outputLocale?: UiLocale;
}): string {
  // 与 buildVideoTimelinePrompt 完全一致的字幕行编号（#N 索引 0-based）
  const cappedSubtitles = input.subtitles?.slice(0, MAX_SUBTITLE_CUES);
  const subtitleText =
    cappedSubtitles
      ?.map((cue, index) => `#${index} [${formatSubtitleTimeRange(cue)}] ${cue.text}`)
      .join('\n') ?? '无字幕文本。';
  const chapterDensityGuidance = createChapterDensityGuidance(input.metadata.duration);
  const subtitleCoverageGuidance = createSubtitleCoverageGuidance(cappedSubtitles);
  const platformChapterBlock = createPlatformChapterAnchorBlock(input.metadata);
  const platformChapterGuidance = createPlatformChapterAnchorGuidance(input.metadata);
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const outputLanguage = createOutputLanguageInstruction(outputLocale);
  const outputExamples = createOutputExamples(outputLocale);

  return `你是 bAI 视频分析助手的时间线导航器。请**只**生成视频的时间线导航（章节 + 细分节点），不要生成复盘总结。

${outputLanguage}
你不是通用聊天助手，不要写寒暄。

<metadata>
标题：${input.metadata.title}
作者：${input.metadata.author}
平台：${input.metadata.platform}
URL：${input.metadata.url}
视频时长：${typeof input.metadata.duration === 'number' ? `${input.metadata.duration} 秒` : '未知'}
</metadata>

${platformChapterBlock}

<subtitles>
${subtitleText}
</subtitles>

## 输出格式：**严格 JSON Lines（每行一个完整 JSON object）**

每行必须以 \`{\` 开头、\`}\` 结尾，**不输出 Markdown、代码块、数组、注释**。每行类型必为以下四种之一：

1. **overview 事件**（只输出 1 次，开头）：
\`\`\`
{"type":"overview","text":"${outputExamples.overview}"}
\`\`\`

2. **chapter 事件**（N 个）：
\`\`\`
{"type":"chapter","id":"c1","startCueId":<起始字幕行 #N>,"endCueId":<结束字幕行 #M>,"importance":"must-watch | recommended | optional | skip","contentTag":"concept | method | demo | case | tool | setup | comparison | experience | summary | troubleshooting | transition | ad","title":"${outputExamples.chapterTitle}","summary":"${outputExamples.chapterSummary}"}
\`\`\`

3. **segment 事件**（每章 1-3 个，**chapterId 必须匹配前面 chapter 事件的 id**）：
\`\`\`
{"type":"segment","chapterId":"c1","startCueId":<起始字幕行 #N>,"endCueId":<结束字幕行 #M>,"importance":"must-watch | recommended | optional | skip","contentTag":"concept | method | demo | case | tool | setup | comparison | experience | summary | troubleshooting | transition | ad","title":"${outputExamples.segmentTitle}","summary":"${outputExamples.segmentSummary}"}
\`\`\`

4. **done 事件**（流结束标记，单独一行）：
\`\`\`
{"type":"done"}
\`\`\`

**关键规则**：
- 时间线是视频导航，不是文章大纲。
${platformChapterGuidance}
${subtitleCoverageGuidance}
- **每个 chapter / segment 必须用 startCueId + endCueId 指向 <subtitles> 里的具体字幕行编号（#N）**。
- 程序会用 \`subtitles[startCueId].start\` 算出真实时间戳，**完全不会**用模型自报的 timestamp / endTimestamp。
- title / summary **只能**描述该 cue range 内字幕已经在讲的内容；不能用后文主题提前命名前文铺垫。
- 如果一个观点在 50s 才开始讲（对应 #N 字幕行），segment 的 startCueId 必须 ≥ N，**不能**用 39s（对应更早的 #M）来命名"50s 才出现的主题"。
- 遇到"过渡 / 引出问题 /铺垫背景"等没有明确主题的段落，title 要老实写"过渡 / 引出问题 / 铺垫背景"，不要用后面章节的主题提前命名。
- 如果字幕里出现"接下来 / 下一步 / 然后再 / 再来看"这类转场词，它们只能提示下一章可能快开始；**不能**把后文要做的事提前当作当前整章标题。
- 章节标题里的核心名词必须是该 cue range 的主要内容；如果只在末尾 1-2 句出现，应该拆成下一章，或者把当前段写成"过渡到..."。
- chapter 起止必须跟随字幕里的真实主题边界，不能按固定时长、平均窗口或整分钟切分；同一主题可以长一些，主题切换早就应该提前切。
- 如果某个主题在章节中途才真正开始，章节标题不要提前使用该主题；把前半段单独写成铺垫/过渡，或从主题真实出现的 cue 开始新 chapter。
${createCueBoundaryGuidance()}
- segment 的 \`chapterId\` 必须能在之前的事件中找到对应 \`chapter.id\`，否则视为 orphan 不纳入正式章节。
- importance 是轻量观看优先级，只服务时间线标签：
  - must-watch：这一章/小节是理解视频价值的关键，错过会影响判断或学习。
  - recommended：正常可看，但不是最高优先级；不要把所有段落都标成 recommended 后再让 UI 显示标签。
  - optional：次要补充、重复、低信息密度或只适合部分用户，用户可按需选看。
  - skip：广告、赞助、明显跑题、重复闲聊或基本无信息量。
- 至少尝试给 1-3 个真正高价值节点标 must-watch；如果全片都只是普通内容，可以全部 recommended，但这类默认值不会在 UI 里显示成标签。
- must-watch 是稀缺标签，不是“有用”的同义词：
  - chapter 级 must-watch 最多占全部章节的 20%-30%，40 分钟左右视频通常最多 2-3 章。
  - 每个 chapter 内最多 1 个 segment 标 must-watch。
  - 只有“错过会影响理解或判断是否观看”的段落才能标 must-watch；只是工具配置、普通演示或补充信息请用 recommended + contentTag。
${createTimelineClassificationGuidance()}

约束：
- 不输出 timestamp / endTimestamp / reasoning / quotes / keyConcepts / timeline / coreTakeaways / reviewSummary / inspirations / watchStrategy 等字段。
- **不要**再生成复盘总结（要点、整体反思、行动建议等）。
- **不要**为美观而把章节凑成整分钟（247s 就是 247s，不要改 240s）。
- ${chapterDensityGuidance}
- 每章 1-3 个 segment。
- endCueId 必须 ≥ startCueId，不能反向。
- segment 的 cue range 必须完全落在父 chapter 的 cue range 范围内。
- ${createQuoteGuidance(outputLocale)}
- 只能基于 <subtitles> 中真实存在的内容生成，不要靠标题 / 作者 / URL 编造。
- 如果字幕和标题看起来不一致，overview 写"字幕可能不匹配当前视频"，不要编造总结。
- overview 必须短，1-2 句，只给视频核心。

> 时间线是用户点击跳转定位的依据，不是文章大纲。章节时间点对应字幕里实际出现的内容，不是为结构好看而设的"虚拟"段落。`;
}

function createOutputLanguageInstruction(locale: UiLocale): string {
  if (locale === 'en-US') {
    return [
      'Output language: English.',
      'Hard rule: every user-visible JSONL string value such as overview text, title, and summary must be English even when subtitles and this prompt contain Chinese.',
      'Translate Chinese subtitle meaning into concise English navigation labels; do not copy Chinese sentences as generated titles or summaries.',
      'Do not output Chinese generated prose. Only preserve proper names or very short quoted source phrases when necessary.',
      'Keep schema field names and enum values exactly as specified.',
      'If quoting original non-English subtitle terms, quote them briefly and explain in English.',
    ].join('\n');
  }
  return '默认用中文输出。所有用户可见 JSONL 字符串使用中文，schema 字段名和枚举值保持英文。';
}

function createOutputExamples(locale: UiLocale): {
  readonly overview: string;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
  readonly segmentTitle: string;
  readonly segmentSummary: string;
} {
  if (locale === 'en-US') {
    return {
      overview: '1-2 English sentences about the video core and why the viewer would use this navigation',
      chapterTitle: 'Short English chapter title',
      chapterSummary: '1-2 English sentences explaining what this section covers',
      segmentTitle: 'Short English segment title',
      segmentSummary: 'One English sentence explaining this smaller segment',
    };
  }
  return {
    overview: '1-2 句视频核心：用户看这个视频主要解决什么问题',
    chapterTitle: '5-14 字章节标题',
    chapterSummary: '1-2 句话说明这一段讲什么',
    segmentTitle: '5-15 字细分节点标题',
    segmentSummary: '1 句话说明这一小段讲什么',
  };
}

function createQuoteGuidance(locale: UiLocale): string {
  return locale === 'en-US'
    ? 'Do not use unescaped double quotes inside JSON string values; use single quotes or brief paraphrase when quoting source terms.'
    : '字符串内容里不要使用英文双引号 "；如需引用短语，使用中文书名号《》或中文引号""。';
}
