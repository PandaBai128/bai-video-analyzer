import { applyCharBudget, pickRepresentativeCues } from '@core/followup/transcript-sampling';
import type { LearningSession, SubtitleCue, VideoAnalysis, VideoMetadata } from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';

export function buildLearningGuidePrompt(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
  readonly session: LearningSession;
  readonly outputLocale?: UiLocale;
}): string {
  const analysisText = formatAnalysisSummary(input.analysis);
  const transcriptText =
    pickGuideTranscriptCues(input)
      .map((cue) => `[${formatSeconds(cue.start)}] ${cue.text}`)
      .join('\n') || '没有可用字幕。';
  const timelineText = formatTimelineEvidence(input.analysis);
  const momentsText = input.session.moments.length
    ? input.session.moments
        .slice(-8)
        .map(
          (moment) =>
            `${moment.timestamp !== undefined ? `[${formatSeconds(moment.timestamp)}] ` : ''}${moment.content}`,
        )
        .join('\n')
    : '用户还没有记录。';
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const outputLanguage = createOutputLanguageInstruction(outputLocale);
  const outputExamples = createOutputExamples(outputLocale);
  const criteriaGuidance = createCriteriaGuidance(outputLocale);
  const ratingGuidance = createRatingGuidance(outputLocale);

  return `你是 bAI 视频分析助手的“视频快速分析”生成器。请基于视频证据生成便于快速预览的辅助分析：先说明视频讲什么、有哪些结论和观点，再提炼内容精华、适合人群、观看建议和信息边界。

${outputLanguage}
不要寒暄，不要 Markdown，只输出合法 JSON。

## 关键原则

- 优先回答“视频主要讲什么、有哪些结论和观点、重点是什么”。不要对作者或视频下“好 / 坏 / 值得 / 不值得”的绝对结论。
- rating、score 和 valueProfile 是为兼容现有数据结构保留的内部参考元数据，不是用户可见的主结论，也不是作者能力或内容质量的绝对评分。
- 必须先判断内容类型，再按该类型常见观看需求生成分析。不同类型不能共用同一把教程尺。
- 分析页聚焦快速预览、观看建议、内容精华、核心观点、适合人群和信息边界。不要写成小作文。
- 所有时间判断必须服从 <metadata> 里的真实时长。不要说“5-6 分钟看完”一个 3 分钟视频；不要生成超过视频总时长的时间点。
- 不要把所有视频都当课程。娱乐、吐槽、reaction、游戏实况、生活 vlog、新闻、播客、教程、论文解读、攻略、带货、争议讨论，都应按各自用途分析。
- 不要输出旧 cards、旧 mentor、旧 goalOptions、旧 watchStrategy 或旧 noteStrategy。当前只保留 decision 主结构。
- 独立分析页不展示观看路线，不要输出 timePlans / mustWatch / canWatch / canSkim / canSkip；具体片段定位交给“导航”生成。

## 内容类型与参考维度

- 先选择 valueProfile.kind：
  - learning_tutorial：教程、课程、论文/知识解读、可跟做攻略。
  - interview_qa：访谈、Q&A、播客问答、人物对谈。
  - opinion_commentary：观点评论、杂谈、锐评、争议讨论。
  - product_review：产品评测、消费建议、工具/设备体验。
  - news_context：新闻解读、事件背景、政策/行业动态。
  - entertainment_reaction：娱乐整活、reaction、vlog、放松观看。
  - gameplay_walkthrough：游戏实况、攻略流程、剧情体验。
  - mixed：多种类型混合，无法归入单一类型。
- 再按该类型理解观看目的：教程看方法和可迁移性，访谈/Q&A 看信息和真实细节，观点评论看论点/证据/视角，产品评测看决策帮助和实测证据，娱乐/vlog 看情绪价值和节目节奏。
- criteria 的 label 必须按 valueProfile.kind 选择以下固定清单；每项只填 label 和 score，不要输出 reason：
${criteriaGuidance}
- criteria 每项只填 label 和 score，不要输出 reason；前端会用固定 tooltip 展示评分标准，避免分析变慢和格式失败。
- 风险/成本类维度按正向理解：高分表示边界较清晰或成本较低，不表示风险本身高。
- criteria 数量按该类型清单输出：product_review 输出 4 项，其它类型输出 5 项；不要混用其它类型的维度。

## 内容概括口径

- contentType 要和 valueProfile.label 一致，使用用户能理解的短标签。
- overallMeaning 必须直接概括视频主线、主要结论或观点，并说明这条视频主要满足什么观看目的；不要把访谈、娱乐、观点评论写成教程口径。
- 教程/学习类：说明它解决什么问题、方法是否完整、适合跟做到什么程度。
- 访谈/Q&A：说明谁在回答什么、内容是具体信息、互动还是闲聊为主，以及适合完整了解还是按问题挑看。
- 观点评论/杂谈：说明核心论点、视角来源、证据支撑强弱和是否只是主观表达。
- 产品/消费评测：说明产品/场景/决策问题，以及实测、对比和利益相关是否足够。
- 娱乐/reaction/vlog：说明情绪价值、节目效果、人物/品牌粉丝向程度，不要强行写“学到什么”。

<metadata>
标题：${input.metadata.title}
作者：${input.metadata.author}
平台：${input.metadata.platform}
时长：${input.metadata.duration ?? '未知'} 秒
URL：${input.metadata.url}
</metadata>

<optional_timeline>
${timelineText}
</optional_timeline>

<video_analysis>
${analysisText}
</video_analysis>

<transcript_sample>
${transcriptText}
</transcript_sample>

<user_trace_so_far>
${momentsText}
</user_trace_so_far>

<user_focus_optional>
用户额外关注：${input.session.coach.customInstruction || input.session.goal.focus || '用户没有额外关注。'}
</user_focus_optional>

只输出以下 JSON：

{
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
    "learningValue": ["${outputExamples.learningValue}"],
    "reservations": ["${outputExamples.reservation}"]
  },
  "contentType": "${outputExamples.contentType}",
  "contentTypeReason": "${outputExamples.contentTypeReason}",
  "suggestedStance": "${outputExamples.suggestedStance}"
}

约束：
- decision 必须存在。overallMeaning 是快速预览主文案；verdict 是兼容字段中的凝练内容结论；reason 和 suggestedStance 提供中性、可执行的观看建议。不要用“完整细看 / 选择性看 / 快速浏览 / 可以跳过”或“值得 / 不值得”作为 verdict 开头。
- rating 只能四选一：
${ratingGuidance}
- score 必须是 0-100 整数：80-100 通常 worth_watching；60-79 通常 selective；40-59 通常 quick_browse；0-39 通常 skip。
- score 只表示内容呈现与当前类型常见观看需求的匹配参考，必须按 valueProfile.kind 的类型标准综合生成；不要把它解释为绝对质量或对作者的评价。
- valueProfile 必须存在；criteria 必须使用 valueProfile.kind 对应的固定清单，每项只输出 label 和 score，不要输出 reason。
- criteria 不要求数学平均等于 score，但每项分数应与 score 的参考含义一致。
- worthReasons、notFor、learningValue、reservations 每组最多 3 条；如果不足 3 条就少写，不要硬凑。分析页空间很紧，禁止输出 4-5 条列表。
- worthReasons 是兼容字段名，内容应回答“视频有哪些内容精华”；learningValue 回答“有哪些核心观点、结论或可迁移信息”；reservations 回答“信息边界、证据缺口或适用前提”。三者不能互相重复。
- <optional_timeline> 是导航缓存提供的位置证据。独立分析可以参考它判断内容结构和证据强弱，但不要输出片段路线。
- 如果一个工具、产品名或主题只在标题里出现、在 <optional_timeline> 和 <transcript_sample> 都没有明确证据，不要把它写成确定结论；不确定时写入 reservations。
- bestFor 描述适合深入了解的人群或需求；notFor 是兼容字段名，内容应描述“哪些人或场景只需按需参考”，不要写成对人群的否定。
- 不要输出 timePlans / mustWatch / canWatch / canSkim / canSkip；这些路线信息由导航链路生成，独立分析只给快速预览和观看建议。
- reservations 0-3 条；只写真正的信息边界、适用前提或证据缺口。
- 如果视频更适合放松观看，要明确允许“只记录喜欢/不喜欢，不做严肃学习笔记”。`;
}

function createOutputLanguageInstruction(locale: UiLocale): string {
  if (locale === 'en-US') {
    return [
      'Output language: English.',
      'Hard rule: every user-visible JSON string value must be English even when metadata, subtitles, examples, and this prompt contain Chinese.',
      'Translate contentType, valueProfile.label, criteria labels, verdict, reasons, list items, and stance into English.',
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

function createOutputExamples(locale: UiLocale): {
  readonly valueProfileLabel: string;
  readonly criterionLabel: string;
  readonly verdict: string;
  readonly overallMeaning: string;
  readonly reason: string;
  readonly worthReason: string;
  readonly bestFor: string;
  readonly notFor: string;
  readonly learningValue: string;
  readonly reservation: string;
  readonly contentType: string;
  readonly contentTypeReason: string;
  readonly suggestedStance: string;
} {
  if (locale === 'en-US') {
    return {
      valueProfileLabel:
        'User-visible English type, e.g. Interview Q&A / Opinion Commentary / Gameplay Guide / Entertainment Reaction',
      criterionLabel: 'Fixed English criterion label for the selected kind',
      verdict:
        'One neutral English sentence summarizing the central conclusion or viewpoint; do not judge the creator or declare the video worth/not worth watching',
      overallMeaning:
        '1-2 English sentences explaining the main thread, conclusions, and intended viewing purpose',
      reason: 'One concrete English viewing suggestion grounded in the video content; avoid generic wording',
      worthReason: 'English content highlight or useful section, 0-3 items',
      bestFor: 'English audience or need suited to deeper viewing, 0-3 items; may be empty',
      notFor: 'English audience or scenario that can reference only what is needed, 0-3 items; may be empty',
      learningValue: 'Concrete English conclusion, viewpoint, or transferable information, 0-3 items',
      reservation: 'English information boundary, evidence gap, or condition, 0-3 items',
      contentType:
        'English short label, e.g. Entertainment Clip / Gameplay Guide / Long Podcast Interview / Opinion Commentary / Product Review / Tutorial / Mixed Content',
      contentTypeReason: '1-2 English sentences explaining why this content type fits',
      suggestedStance: 'One neutral English sentence suggesting how to approach the video',
    };
  }
  return {
    valueProfileLabel: '用户可见中文类型，例如：访谈 Q&A / 观点评论 / 攻略教程 / 娱乐反应',
    criterionLabel: '按 kind 选择对应固定维度',
    verdict:
      '一句中性的内容结论或核心观点，不评价作者，也不直接宣布视频值得或不值得看',
    overallMeaning: '1-2 句说明视频主线、主要结论或观点，以及它适合满足什么观看需求',
    reason: '一句具体观看建议及原因，必须基于视频内容，不要空泛',
    worthReason: '内容精华或值得关注的信息，0-3 条',
    bestFor: '适合深入了解的人群或需求，0-3 条，允许为空，不要硬凑',
    notFor: '只需按需参考的人群或场景，0-3 条，允许为空，不要写成否定评价',
    learningValue: '核心观点、结论或可迁移信息，0-3 条',
    reservation: '信息边界、证据缺口或适用前提，0-3 条',
    contentType:
      '用用户能理解的中文短标签，例如：娱乐整活 / 攻略教程 / 长播客访谈 / 观点争辩 / 产品评测 / 课程讲解 / 混合内容',
    contentTypeReason: '1-2 句话说明你为什么这样判断',
    suggestedStance: '一句中性的观看建议，说明适合如何查看这条视频',
  };
}

function formatTimelineEvidence(analysis: VideoAnalysis | null): string {
  if (!analysis?.chapters.length) {
    return '用户还没有生成导航。';
  }
  return analysis.chapters
    .slice(0, 12)
    .map((chapter) => {
      const chapterLine = `[${formatTimeRange(chapter.timestamp, chapter.endTimestamp)}] 章节：${chapter.title}：${chapter.summary}`;
      const segmentLines = chapter.segments
        .slice(0, 4)
        .map(
          (segment) =>
            `  - [${formatTimeRange(segment.timestamp, segment.endTimestamp)}] 小节：${segment.title}：${segment.summary}`,
        );
      return [chapterLine, ...segmentLines].join('\n');
    })
    .join('\n');
}

function formatAnalysisSummary(analysis: VideoAnalysis | null): string {
  if (!analysis) {
    return '没有分析缓存。';
  }

  const takeaways = analysis.coreTakeaways.length
    ? analysis.coreTakeaways.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '无';

  return [
    `来源：${formatSourceMode(analysis.sourceMode)}`,
    `视频核心：${analysis.overview || '无'}`,
    `核心要点：\n${takeaways}`,
    `整体理解：${analysis.reviewSummary || '无'}`,
  ].join('\n');
}

function formatSourceMode(sourceMode: VideoAnalysis['sourceMode']): string {
  if (sourceMode === 'subtitle') {
    return '字幕分析';
  }
  return '旧分析缓存（公开版不再生成）';
}

function pickGuideTranscriptCues(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
}): readonly SubtitleCue[] {
  return applyCharBudget(
    pickRepresentativeCues(input.transcriptCues, input.metadata.duration),
    12_000,
  );
}

function formatTimeRange(start: number, end: number | undefined): string {
  if (typeof end === 'number' && end > start) {
    return `${formatSeconds(start)}-${formatSeconds(end)}`;
  }
  return formatSeconds(start);
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
