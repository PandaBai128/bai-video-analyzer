import type { LearningSession, SubtitleCue, VideoMetadata } from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import {
  createTimelineClassificationGuidance,
  formatSubtitleTimeRange,
} from './video-timeline-prompt-utils';

const MAX_SUBTITLE_CUES = 6000;

export function buildWatchDecisionPackagePrompt(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly session: LearningSession;
  readonly outputLocale?: UiLocale;
}): string {
  const subtitles = input.transcriptCues.slice(0, MAX_SUBTITLE_CUES);
  const subtitleText =
    subtitles
      .map((cue, index) => `#${index} [${formatSubtitleTimeRange(cue)}] ${cue.text}`)
      .join('\n') || '没有可用字幕。';
  const userTraceText = input.session.moments.length
    ? input.session.moments
        .slice(-8)
        .map(
          (moment) =>
            `${moment.timestamp !== undefined ? `[${formatSeconds(moment.timestamp)}] ` : ''}${moment.content}`,
        )
        .join('\n')
    : '用户还没有记录。';
  const userFocus =
    input.session.coach.customInstruction || input.session.goal.focus || '用户没有额外关注。';
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const outputLanguage = createOutputLanguageInstruction(outputLocale);
  const outputExamples = createOutputExamples(outputLocale);
  const criteriaGuidance = createCriteriaGuidance(outputLocale);
  const ratingGuidance = createRatingGuidance(outputLocale);
  const lengthGuidance = createLengthGuidance(outputLocale);

  return `你是 bAI 视频分析助手的同源“分析与导航包”生成器。你的任务是用同一份字幕证据，同时生成：
1. 时间线导航（chapters + segments）
2. 视频分析与观看建议（decision）

${outputLanguage}
不要寒暄，不要 Markdown，只输出合法 JSON。

## 核心目标

- 用户先看到快速预览：这个长视频主要讲什么、有哪些结论和观点、适合如何查看、重点在哪里。
- 时间线用于快速浏览和跳转，必须和分析来自同一套内容理解。
- 不要把分析和时间线写成两套东西；decision 里的可点击片段必须引用本次输出的 timeline nodeId。
- 你是语义锚点的主要判断者：根据字幕内容选择主题真正开始和结束的 cue 范围。不要按平均时长、整分钟、关键词第一次出现来机械切分。
- 如果某个主题只是标题里出现，字幕里没有证据，不要把它写成片段。

<metadata>
标题：${input.metadata.title}
作者：${input.metadata.author}
平台：${input.metadata.platform}
URL：${input.metadata.url}
视频时长：${typeof input.metadata.duration === 'number' ? `${input.metadata.duration} 秒` : '未知'}
</metadata>

<platform_chapters_optional>
${formatPlatformChapters(input.metadata)}
</platform_chapters_optional>

<subtitles>
${subtitleText}
</subtitles>

<user_trace_so_far>
${userTraceText}
</user_trace_so_far>

<user_focus_optional>
${userFocus}
</user_focus_optional>

只输出以下 JSON，顶层必须直接包含 contentType / overview / chapters / decision，不要再包一层 analysis、guide、result 或 data。
顶层字段顺序必须按 contentType → contentTypeReason → suggestedStance → overview → coreTakeaways → reviewSummary → chapters → decision 输出。先完成 chapters/segments，再在 decision 中引用已经输出的 nodeId：

{
  "contentType": "${outputExamples.contentType}",
  "contentTypeReason": "${outputExamples.contentTypeReason}",
  "suggestedStance": "${outputExamples.suggestedStance}",
  "overview": "${outputExamples.overview}",
  "coreTakeaways": ["${outputExamples.coreTakeaway}"],
  "reviewSummary": "${outputExamples.reviewSummary}",
  "chapters": [
    {
      "id": "c1",
      "startCueId": 0,
      "endCueId": 10,
      "importance": "must-watch | recommended | optional | skip",
      "contentTag": "concept | method | demo | case | tool | setup | comparison | experience | summary | troubleshooting | transition | ad",
      "title": "${outputExamples.chapterTitle}",
      "summary": "${outputExamples.chapterSummary}",
      "watchGuide": "${outputExamples.watchGuide}",
      "segments": [
        {
          "id": "s1",
          "startCueId": 0,
          "endCueId": 3,
          "importance": "must-watch | recommended | optional | skip",
          "contentTag": "concept | method | demo | case | tool | setup | comparison | experience | summary | troubleshooting | transition | ad",
          "title": "${outputExamples.segmentTitle}",
          "summary": "${outputExamples.segmentSummary}",
          "watchPrompt": "${outputExamples.watchPrompt}"
        }
      ]
    }
  ],
  "decision": {
    "rating": "worth_watching | selective | quick_browse | skip",
    "score": 0,
    "valueProfile": {
      "kind": "learning_tutorial | interview_qa | opinion_commentary | product_review | news_context | entertainment_reaction | gameplay_walkthrough | mixed",
      "label": "${outputExamples.valueProfileLabel}",
      "criteria": [
        { "label": "${outputExamples.criterionLabel}", "score": 0 }
      ]
    },
    "verdict": "${outputExamples.verdict}",
    "overallMeaning": "${outputExamples.overallMeaning}",
    "reason": "${outputExamples.reason}",
    "worthReasons": ["${outputExamples.worthReason}"],
    "bestFor": ["${outputExamples.bestFor}"],
    "notFor": ["${outputExamples.notFor}"],
    "mustWatch": [
      {
        "nodeId": "s1",
        "title": "${outputExamples.decisionSegmentTitle}",
        "tag": "must_watch | method | case | uncertain",
        "reason": "${outputExamples.decisionSegmentReason}"
      }
    ],
    "canWatch": [],
    "canSkim": [],
    "canSkip": [],
    "reservations": ["${outputExamples.reservation}"]
  }
}

## 时间线约束

- chapters 和 segments 必须用 startCueId / endCueId 指向 <subtitles> 里的 #N。
- cue 范围必须对应这段字幕真实讲的内容：不要用后文主题提前命名前文铺垫。
- chapter 起止跟随主题边界，不要按固定窗口、整分钟或平均切分。
- segment 必须落在父 chapter 的 cue 范围内。
- 每章 1-3 个 segment；40 分钟左右视频通常 6-10 章，按真实主题多少调整。
- 不管视频多长，chapters 总数最多 12 个，segments 总数最多 24 个；两小时以上视频也只做导航级压缩，不做完整目录。
- 全片 segment 总数优先控制在 12-20 个；只拆能帮助用户跳转决策的节点，不要为完整而拆碎。
- ${lengthGuidance}
- 如果平台章节超过 12 个，合并相邻低价值章节，优先保留主题变化、结论转折、演示、方法和争议片段。
- importance 只表达观看优先级；must-watch 是稀缺标签，通常最多 20%-30%。
- contentTag 只表达内容类型，不表达优先级。
${createTimelineClassificationGuidance()}
- 如果平台章节存在，可参考但不要盲从；字幕语义边界优先。

## 分析约束

- decision 必须概括视频主线、结论或观点，并给出中性的观看建议；不要对作者或视频下绝对价值结论。rating 和 score 为兼容字段，仍须填写。
- score 必须是 0-100 整数：80-100 通常 worth_watching；60-79 通常 selective；40-59 通常 quick_browse；0-39 通常 skip。score 只表示内容呈现与当前类型常见观看需求的匹配参考，不是内容质量或作者能力的绝对评分。
- rating 只能四选一：
${ratingGuidance}
- valueProfile 必须存在；先判断内容类型，再按该类型的常见观看目的生成参考值。教程、访谈、观点评论、产品评测和娱乐内容不能共用同一套“学习价值”口径。
- criteria 的 label 必须按 valueProfile.kind 选择以下固定清单；每项只输出 label 和 score，不要输出 reason，避免输出过长和格式失败：
${criteriaGuidance}
- 风险/成本类维度按正向理解：高分表示风险可控、边界清晰或成本低，不表示风险本身高。
- criteria 数量按该类型清单输出：product_review 输出 4 项，其它类型输出 5 项；不要混用其它类型的维度。
- contentType、overview 和 decision.overallMeaning 必须跟 valueProfile.kind 对齐：Q&A 写谁在回答什么和信息/闲聊比例；观点评论写核心论点和证据强弱；娱乐/vlog 写情绪价值和粉丝向程度；教程才写方法和跟做收益。
- decision 的可点击片段必须通过 nodeId 引用本次输出的 chapter.id 或 segment.id。
- decision 片段的 title 必须逐字复制 nodeId 对应 chapter / segment 的 title；reason 只能解释这个 nodeId 对应片段与用户需求的关系，不要把相邻或后文片段的内容写到当前 nodeId 上。
- decision 片段不要输出 startTimestamp / endTimestamp；程序会按 nodeId 映射到同源时间线。
- 如果不确定某个片段是否真实存在，写 reservations，不要伪造 nodeId。
- 分析页展示：快速预览、视频主要讲什么、内容精华、适合深入了解 / 可按需参考的人群、信息边界和观看建议。不要输出 learningValue 或 timePlans，避免和 worthReasons / 片段路线重复。
- worthReasons、bestFor、notFor、reservations 每组最多 3 条，不要硬凑。
- mustWatch 1-4 条；rating=skip 时也至少给一个可按需参考的低优先片段。
- canWatch/canSkim/canSkip 各 0-4 条；广告、重复、铺垫、低信息密度要明确标出。
- ${createQuoteGuidance(outputLocale)}`;
}

function createOutputLanguageInstruction(locale: UiLocale): string {
  if (locale === 'en-US') {
    return [
      'Output language: English.',
      'Hard rule: every user-visible JSON string value must be English even when metadata, subtitles, examples, and this prompt contain Chinese.',
      'Translate contentType, overview, title, summary, watchGuide, watchPrompt, valueProfile.label, criteria labels, verdict, reasons, and all list items into English.',
      'Do not output Chinese generated prose or Chinese category labels. Only preserve proper names or very short quoted source phrases when necessary.',
      'Keep schema field names and enum values exactly as specified.',
      'If quoting original non-English subtitle terms, quote them briefly and explain in English.',
    ].join('\n');
  }
  return '默认中文。所有用户可见 JSON 字符串使用中文，schema 字段名和枚举值保持英文。';
}

function createCriteriaGuidance(locale: UiLocale): string {
  if (locale === 'en-US') {
    return [
      '  - learning_tutorial: Structure clarity, Transferable methods, Complete steps, Time relevance, Practice cost.',
      '  - interview_qa: Person/event rarity, Answer density, Concrete details, Insight value, Small-talk control.',
      '  - opinion_commentary: Argument clarity, Example support, Fresh perspective, Evidence boundaries, Expression efficiency.',
      '  - product_review: Test evidence, Comparison depth, Purchase decision help, Conflict-of-interest control.',
      '  - news_context: Background completeness, Timeliness, Source reliability, Impact explanation, Position boundaries.',
      '  - entertainment_reaction: Emotional value, Show effect, Persona appeal, Editing rhythm, Relaxed viewing fit.',
      '  - gameplay_walkthrough: Route completeness, Follow-along practicality, Key node coverage, Experience/story value, Repetition cost control.',
      '  - mixed: Type clarity, Focus, Information/entertainment balance, Evidence support, Time tradeoff.',
    ].join('\n');
  }
  return [
    '  - learning_tutorial：结构清晰、可迁移方法、步骤完整、时效可控、实践成本。',
    '  - interview_qa：人物/事件稀缺性、回答信息量、真实细节、观点启发、闲聊控制。',
    '  - opinion_commentary：论点清晰度、例子支撑、视角新鲜度、证据边界清晰、表达效率。',
    '  - product_review：实测证据、对比充分性、购买决策帮助、利益相关可控。',
    '  - news_context：背景完整度、信息时效性、来源可靠性、影响解释、立场边界。',
    '  - entertainment_reaction：情绪价值、节目效果、人物魅力、剪辑节奏、放松观看适配。',
    '  - gameplay_walkthrough：路线完整度、实操可跟随、关键节点覆盖、体验/剧情价值、重复成本控制。',
    '  - mixed：类型识别清晰、重点集中度、信息/娱乐平衡、证据支撑、时间取舍。',
  ].join('\n');
}

function createRatingGuidance(locale: UiLocale): string {
  if (locale === 'en-US') {
    return [
      '  - worth_watching: The content supports systematic or full viewing for its intended use.',
      '  - selective: The viewer can focus on the parts relevant to their current need.',
      '  - quick_browse: A quick preview is usually enough to understand the main point.',
      '  - skip: Use as a lookup reference; full viewing is usually unnecessary.',
    ].join('\n');
  }
  return [
    '  - worth_watching：适合按顺序或系统了解。',
    '  - selective：适合围绕当前需求查看相关部分。',
    '  - quick_browse：通过快速预览即可掌握主要内容。',
    '  - skip：更适合作为资料按需查阅，通常不必完整观看。',
  ].join('\n');
}

function createLengthGuidance(locale: UiLocale): string {
  return locale === 'en-US'
    ? 'title should be concise, usually 3-8 English words; keep summary / watchGuide / watchPrompt / reason under about 25 English words each.'
    : 'title 控制在 5-15 字；summary / watchGuide / watchPrompt / reason 每条控制在 45 个中文字符以内。';
}

function createQuoteGuidance(locale: UiLocale): string {
  return locale === 'en-US'
    ? 'Do not use unescaped double quotes inside JSON string values; use single quotes or brief paraphrase when quoting source terms.'
    : '字符串里不要使用英文双引号 "；需要引用时用中文引号。';
}

function createOutputExamples(locale: UiLocale): {
  readonly contentType: string;
  readonly contentTypeReason: string;
  readonly suggestedStance: string;
  readonly valueProfileLabel: string;
  readonly criterionLabel: string;
  readonly verdict: string;
  readonly overview: string;
  readonly coreTakeaway: string;
  readonly reviewSummary: string;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
  readonly watchGuide: string;
  readonly segmentTitle: string;
  readonly segmentSummary: string;
  readonly watchPrompt: string;
  readonly overallMeaning: string;
  readonly reason: string;
  readonly worthReason: string;
  readonly bestFor: string;
  readonly notFor: string;
  readonly decisionSegmentTitle: string;
  readonly decisionSegmentReason: string;
  readonly reservation: string;
} {
  if (locale === 'en-US') {
    return {
      contentType:
        'English short label, e.g. Entertainment Clip / Gameplay Guide / Long Podcast Interview / Product Review / Tutorial / Mixed Content',
      contentTypeReason: '1-2 English sentences explaining why this content type fits',
      suggestedStance: 'One neutral English sentence suggesting how to approach the video',
      valueProfileLabel:
        'User-visible English type, e.g. Interview Q&A / Opinion Commentary / Gameplay Guide / Entertainment Reaction',
      criterionLabel: 'Fixed English criterion label for the selected kind',
      verdict: 'One neutral English sentence summarizing the central conclusion or viewpoint',
      overview: '1-2 English sentences about what this video helps the viewer decide or understand',
      coreTakeaway: 'Most transferable English takeaway, 0-5 items',
      reviewSummary: 'Reusable English summary for later learning notes, 1-3 sentences',
      chapterTitle: 'Short English chapter title',
      chapterSummary: '1-2 English sentences explaining what this chapter covers',
      watchGuide: 'One English sentence telling whether and how to watch this chapter',
      segmentTitle: 'Short English segment title',
      segmentSummary: 'One English sentence explaining this smaller segment',
      watchPrompt: 'Optional English question to keep in mind before watching this segment',
      overallMeaning: '1-2 English sentences explaining the main thread, conclusions, and intended viewing purpose',
      reason: 'One concrete English viewing suggestion grounded in the video content',
      worthReason: 'English content highlight or useful section, 0-3 items',
      bestFor: 'English audience or need suited to deeper viewing, 0-3 items',
      notFor: 'English audience or scenario that can reference only what is needed, 0-3 items',
      decisionSegmentTitle: 'Title copied from the referenced English chapter or segment',
      decisionSegmentReason: 'English reason why this referenced node is relevant to the viewer',
      reservation: 'English reservation, evidence gap, or condition, 0-3 items',
    };
  }
  return {
    contentType:
      '用户能理解的中文短标签，例如：娱乐整活 / 攻略教程 / 长播客访谈 / 产品评测 / 课程讲解 / 混合内容',
    contentTypeReason: '1-2 句话说明为什么这样判断',
    suggestedStance: '一句中性的观看建议，说明适合如何查看这条视频',
    valueProfileLabel: '用户可见中文类型，例如：访谈 Q&A / 观点评论 / 攻略教程',
    criterionLabel: '按 kind 选择对应固定维度',
    verdict: '一句中性的内容结论或核心观点，不评价作者，也不直接宣布视频值得或不值得看',
    overview: '1-2 句视频核心：这条视频主要帮助用户理解什么',
    coreTakeaway: '最可迁移的收获，0-5 条',
    reviewSummary: '后续学习笔记可复用的整体总结，1-3 句',
    chapterTitle: '5-14 字章节标题',
    chapterSummary: '1-2 句话说明这一章讲什么',
    watchGuide: '一句话告诉用户这一章要不要看、怎么看',
    segmentTitle: '5-15 字细分节点标题',
    segmentSummary: '1 句话说明这一小段讲什么',
    watchPrompt: '可选：用户点进来前应该带着什么问题看',
    overallMeaning: '1-2 句说明视频主线、主要结论或观点，以及它适合满足什么观看需求',
    reason: '一句具体观看建议及原因，必须基于视频内容',
    worthReason: '内容精华或值得关注的信息，0-3 条',
    bestFor: '适合深入了解的人群或需求，0-3 条',
    notFor: '只需按需参考的人群或场景，0-3 条，不要写成否定评价',
    decisionSegmentTitle: '优先查看的片段',
    decisionSegmentReason: '这个片段与当前观看需求的关系',
    reservation: '信息边界、证据缺口或适用前提，0-3 条',
  };
}

function formatPlatformChapters(metadata: VideoMetadata): string {
  const chapters = metadata.platformChapters ?? [];
  if (!chapters.length) return '无平台章节。';
  return chapters
    .slice(0, 30)
    .map((chapter, index) => {
      const end = chapter.end !== undefined ? `-${formatSeconds(chapter.end)}` : '';
      return `${index + 1}. [${formatSeconds(chapter.start)}${end}] ${chapter.title}`;
    })
    .join('\n');
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}
