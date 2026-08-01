import {
  applyCharBudget,
  pickCuesNearest,
  pickRepresentativeCues,
} from '@core/followup/transcript-sampling';
import type { LearningGuide, LearningSession, SubtitleCue, VideoAnalysis, VideoMetadata } from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';

const MODE_LABELS: Record<LearningSession['goal']['mode'], string> = {
  adaptive: '自适应：按视频分析、视频内容和用户记录决定笔记角度',
  understand: '理解：梳理概念、论证和关键关系',
  apply: '应用：提炼可执行方法、迁移场景和下一步',
  challenge: '质疑：检查前提、证据、边界和可能反例',
};

export function buildLearningReviewPrompt(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
  readonly session: LearningSession;
  readonly outputLocale?: UiLocale;
}): string {
  const guide = getReadableGuide(input.session);
  const analysisText = formatAnalysisSummary(input.analysis);
  const representativeCues = pickReviewTranscriptCues(input);
  const transcriptText =
    representativeCues.length > 0
      ? representativeCues.map((cue) => `[${formatSeconds(cue.start)}] ${cue.text}`).join('\n')
      : '没有可用字幕。';
  const timelineText = input.analysis?.chapters.length
    ? input.analysis.chapters
        .slice(0, 8)
        .map(
          (chapter) => `[${formatSeconds(chapter.timestamp)}] ${chapter.title}：${chapter.summary}`,
        )
        .join('\n')
    : '用户没有生成导航。';
  const momentsText =
    input.session.moments.length > 0
      ? input.session.moments
          .slice(-20)
          .map(
            (moment) =>
              `${moment.timestamp !== undefined ? `[${formatSeconds(moment.timestamp)}] ` : ''}${formatMomentKind(moment.kind)}${formatMomentSource(moment)}：${moment.content}${moment.coach ? `\n补充说明处理：${moment.coach.handling}｜${moment.coach.response}` : ''}`,
          )
          .join('\n')
      : '用户没有主动记录。';
  const includedExchanges = pickIncludedReviewExchanges(input.session);
  const exchangesText =
    includedExchanges.length > 0
      ? includedExchanges
          .map(
            (exchange, index) =>
              `第 ${index + 1} 轮\n用户：${exchange.question}\nbAI：${exchange.answer}`,
          )
          .join('\n\n')
      : '用户没有选择要加入笔记的提问问答。';
  const guideText = guide
    ? [
        `内容类型：${guide.contentType}`,
        `分析理由：${guide.contentTypeReason}`,
        `观看建议：${guide.suggestedStance}`,
        `笔记角度：${formatGoal(input.session)}`,
        `内容概括：${guide.decision.overallMeaning || guide.decision.verdict}`,
        `内容精华：${guide.decision.worthReasons?.join('；') || '无'}`,
        `核心观点：${guide.decision.learningValue?.join('；') || '无'}`,
        guide.decision.reservations.length
          ? `信息边界：${guide.decision.reservations.join('；')}`
          : '信息边界：无',
      ].join('\n')
    : `尚未生成视频分析。\n笔记角度：${formatGoal(input.session)}`;
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const outputLanguage = createOutputLanguageInstruction(outputLocale);
  const outputExamples = createOutputExamples(outputLocale);

  return `你是 bAI 视频分析助手的学习笔记整理器。请把一次视频学习整理成“五块式学习笔记”：1）视频讲了什么；2）我得到了什么；3）哪些观点值得参考；4）哪些我需要保留判断；5）我的记录。它不是视频时间线复述，也不是用户操作日志，而是帮助用户看完后留下真正值得保留的学习判断。

${outputLanguage}
不要寒暄，不要写 Markdown，只输出合法 JSON。

## 事实边界

- <transcript> 和 <timeline> 是视频内容证据。
- <learning_moments> 是用户的观看记录；<followup_exchanges> 只包含用户手动选择“加入笔记”的问答。它们是用户的学习轨迹，不是视频事实，但可以提高笔记权重。
- finalReflection 字段代表第 2 章里“我得到了什么”的总句：只写 1 个完整自然段，概括我通过这个视频真正获得的理解；不要写成行动清单、风险清单或视频复述。
- personalInsights 字段代表第 2 章里“我得到了什么”的具体 1/2/3：可以基于视频证据主动提炼用户值得带走的理解、方法、提醒或反思；如果有 <learning_moments> / <followup_exchanges>，优先融合这些内容，但不要逐字复制。
- transferReflection 字段代表第 2 章里“我可以根据这个做什么”：写 1 个自然段，说明这些收获可以迁移到用户自己的学习、项目或判断流程里；不要列下一步动作，不要写需要查证的风险。
- 可以用第一人称“我可以……”或“我需要……”，但只能表达由视频证据、用户记录或加入笔记问答支持的学习理解；不要编造用户已经做过、想过或经历过的事情；不要写“用户”。
- keyIdeas 字段代表“哪些观点值得参考”：写视频里值得参考的方法、判断、证据或案例，不要平均覆盖全片。
- openQuestions 字段代表“哪些我需要保留判断”：作者观点的前提、证据缺口、适用边界、可能反例、需要查证之处。
- actionItems 字段代表第 2 章里“下一步怎么做”：只写真正值得继续做的 1-3 个动作；没有行动价值时返回 []，不要硬造作业。查官方文档、确认配额、验证来源这类查证动作优先放到 openQuestions，不要混进第二章。
- 不要按时间顺序流水账，不要把时间线、用户记录、问答机械拼接。

<metadata>
标题：${input.metadata.title}
作者：${input.metadata.author}
平台：${input.metadata.platform}
URL：${input.metadata.url}
</metadata>

<review_goal>
${guideText}
</review_goal>

<video_analysis>
${analysisText}
</video_analysis>

<timeline>
${timelineText}
</timeline>

<transcript>
${transcriptText}
</transcript>

<learning_moments>
${momentsText}
</learning_moments>

<followup_exchanges>
${exchangesText}
</followup_exchanges>

只输出以下 JSON 结构：

{
  "coreSummary": "${outputExamples.coreSummary}",
  "keyIdeas": [
    {
      "title": "${outputExamples.keyIdeaTitle}",
      "explanation": "${outputExamples.keyIdeaExplanation}",
      "evidenceTimestamp": 120
    }
  ],
  "personalInsights": ["${outputExamples.personalInsight}"],
  "transferReflection": "${outputExamples.transferReflection}",
  "openQuestions": ["${outputExamples.openQuestion}"],
  "actionItems": ["${outputExamples.actionItem}"],
  "finalReflection": "${outputExamples.finalReflection}"
}

约束：
- coreSummary 不超过 160 字；不要写成章节流水账。
- keyIdeas 0-5 条；只基于视频证据；优先选择值得参考的方法、判断、证据或案例，不要平均覆盖全片。低信息或娱乐视频没有明确观点时返回 []，不要硬造。
- evidenceTimestamp 只有能从时间线或字幕定位时才填写；只允许使用 <timeline> 或 <transcript> 方括号中出现过的时间，不要估算，不确定就省略。
- finalReflection 不超过 120 字；它是第二章第一段的总句，不负责写下一步，也不写保留判断。
- personalInsights 2-4 条；基于视频证据主动提炼，可融合用户主动记录或问答；按重要性排序，不按时间排序；不能只是复述视频事实。每条用完整句子表达“我具体得到了什么 / 参考什么 / 反思什么”，不要写成短标签。
- 如果视频信息量极低，可以少于 2 条或返回 []；不要为了填满而硬造。
- transferReflection 不超过 180 字；说明“这些收获能迁移到哪里 / 我可以根据它改变什么处理方式”，不要和 personalInsights 重复，不要写成行动清单。
- openQuestions 0-5 条；标题含义是“我需要保留判断的地方”，优先写作者未充分证明的边界、适用条件和需要查证的判断；不要写 UI 问题。
- actionItems 0-3 条；每条必须是下一步动作，不能重复 personalInsights 或 transferReflection。
- 如果视频分析表明这是娱乐、灵感或轻内容，允许 actionItems 很少甚至为空，不要硬造作业。
- 没有用户主动加入内容时，只写基于视频证据的谨慎理解，不写用户实际经历或决定。`;
}

function createOutputLanguageInstruction(locale: UiLocale): string {
  if (locale === 'en-US') {
    return [
      'Output language: English.',
      'Hard rule: every user-visible JSON string value must be English even when metadata, notes, prior Q&A, subtitles, and this prompt contain Chinese.',
      'Translate summaries, idea titles, explanations, insights, reservations, actions, and final reflection into English.',
      'Do not output Chinese generated prose. Only preserve proper names or very short quoted source phrases when necessary.',
      'Keep schema field names exactly as specified.',
      'If quoting original non-English subtitle terms, quote them briefly and explain in English.',
    ].join('\n');
  }
  return '默认使用中文。所有用户可见 JSON 字符串使用中文，schema 字段名保持英文。';
}

function createOutputExamples(locale: UiLocale): {
  readonly coreSummary: string;
  readonly keyIdeaTitle: string;
  readonly keyIdeaExplanation: string;
  readonly personalInsight: string;
  readonly transferReflection: string;
  readonly openQuestion: string;
  readonly actionItem: string;
  readonly finalReflection: string;
} {
  if (locale === 'en-US') {
    return {
      coreSummary:
        '2-4 English sentences explaining what the video mainly conveys, what the creator wants viewers to understand or believe, and the key boundaries',
      keyIdeaTitle: 'English key idea title',
      keyIdeaExplanation: 'Explain the idea, evidence, and why it matters in English',
      personalInsight:
        'One complete English takeaway I can keep from this video, such as an understanding, method, reminder, or reflection',
      transferReflection:
        'One English paragraph explaining where I can transfer these takeaways and what judgment or workflow they may change, without a concrete action checklist',
      openQuestion: 'An English reservation or boundary I should keep in mind',
      actionItem: 'A concrete, low-cost next action in English',
      finalReflection:
        'One English paragraph summarizing what I truly gained from the video; do not list items or repeat personalInsights',
    };
  }
  return {
    coreSummary:
      '用 2-4 句话说明这个视频主要传达了什么：作者想让观众理解/相信/采取什么态度，以及关键边界',
    keyIdeaTitle: '关键观点标题',
    keyIdeaExplanation: '说明观点、依据和为什么重要',
    personalInsight: '我从这个视频里可以带走的一条完整要点：可以是理解、方法、提醒或反思',
    transferReflection:
      '1 个自然段，说明我可以根据这些收获做什么：迁移到什么场景、改变什么判断或工作流，不写具体下一步清单',
    openQuestion: '哪些我需要保留判断',
    actionItem: '下一步怎么做：一个具体、低成本、可以立即执行的动作',
    finalReflection:
      '1 个自然段，用一个总句概括我通过视频真正得到的理解；不要列清单，不要重复 personalInsights',
  };
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

function pickReviewTranscriptCues(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly session: LearningSession;
}): readonly SubtitleCue[] {
  const representative = pickRepresentativeCues(input.transcriptCues, input.metadata.duration);
  const anchored = input.session.moments.flatMap((moment) =>
    moment.timestamp !== undefined
      ? pickCuesNearest(input.transcriptCues, moment.timestamp, 4, 2)
      : [],
  );
  const unique = new Map<string, SubtitleCue>();
  for (const cue of [...representative, ...anchored]) {
    unique.set(`${cue.start}:${cue.end ?? ''}:${cue.text}`, cue);
  }
  return applyCharBudget(
    [...unique.values()].sort((left, right) => left.start - right.start),
    10_000,
  );
}

function pickIncludedReviewExchanges(
  session: LearningSession,
): readonly LearningSession['exchanges'][number][] {
  return session.exchanges.filter((exchange) => exchange.includedInReview === true).slice(-8);
}

function getReadableGuide(session: LearningSession): LearningGuide | null {
  const guide = session.guide;
  if (!guide || !isReadableDecision(guide.decision)) {
    return null;
  }
  return guide;
}

function isReadableDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.verdict === 'string' &&
    isFiniteNumber(value.score) &&
    typeof value.overallMeaning === 'string' &&
    Array.isArray(value.mustWatch) &&
    Array.isArray(value.canWatch) &&
    Array.isArray(value.canSkim) &&
    Array.isArray(value.canSkip) &&
    Array.isArray(value.reservations)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatMomentKind(kind: LearningSession['moments'][number]['kind']): string {
  return {
    note: '记录',
    insight: '发现',
    question: '疑问',
    action: '行动',
  }[kind];
}

function formatMomentSource(moment: LearningSession['moments'][number]): string {
  if (moment.source === 'mentor_card') return '（来自旧提示）';
  return '';
}

function formatGoal(session: LearningSession): string {
  const base = session.goal.label ?? MODE_LABELS[session.goal.mode];
  const focus = session.goal.focus ? `；用户关注：${session.goal.focus}` : '';
  const instruction = session.goal.instruction ? `；整理指令：${session.goal.instruction}` : '';
  return `${base}${focus}${instruction}`;
}
