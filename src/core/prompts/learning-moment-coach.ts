import {
  applyCharBudget,
  pickCuesNearest,
  pickRepresentativeCues,
} from '@core/followup/transcript-sampling';
import type {
  LearningGuide,
  LearningMoment,
  LearningSession,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';

export function buildLearningMomentCoachPrompt(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
  readonly session: LearningSession;
  readonly moment: LearningMoment;
}): string {
  const guide = getReadableGuide(input.session);
  const analysisText = formatAnalysisSummary(input.analysis);
  const transcriptText =
    pickMomentTranscriptCues(input)
      .map((cue) => `[${formatSeconds(cue.start)}] ${cue.text}`)
      .join('\n') || '没有可用字幕。';
  const timelineText = input.analysis?.chapters.length
    ? input.analysis.chapters
        .slice(0, 8)
        .map(
          (chapter) => `[${formatSeconds(chapter.timestamp)}] ${chapter.title}：${chapter.summary}`,
        )
        .join('\n')
    : '用户没有生成导航。';

  return `你是 bAI 视频分析助手的记录补充说明器。用户刚刚加入了一条记录。请回应这条记录，判断它应该如何处理，而不是强行把它变成严肃问题。

默认中文。不要寒暄，不要 Markdown，只输出合法 JSON。

## 处理原则

- 你可以选择 keep / ask / verify / apply / release：
  - keep：这条记录适合作为观察或灵感留下，不需要立刻追问。
  - ask：适合继续问模型或回到视频找答案。
  - verify：需要检查证据、前提或信息来源。
  - apply：适合转成下一步行动。
  - release：娱乐、情绪、审美偏好或轻松观看内容，不必过度分析。
- 不要把所有记录都判成 keep。疑问类记录优先 ask/verify；行动类记录优先 apply；证据不足、真假判断、宣传话术类记录优先 verify；娱乐审美类轻记录可以 release。
- 回应必须基于当前视频和用户这条记录；不要编造用户经历。
- response 里不要写“这条记录值得保留/值得留下/可以保留”这类空判断；直接解释这条记录对应的视频含义、用户可以怎么理解，以及是否需要继续处理。
- 如果是娱乐/整活/审美类记录，可以明确说“保留感受就够了”，并给一个轻量处理方式。
- suggestedQuestions 是给用户后续可选的追问，不是必须完成的作业。

<metadata>
标题：${input.metadata.title}
作者：${input.metadata.author}
平台：${input.metadata.platform}
</metadata>

<watching_strategy>
内容类型：${guide?.contentType ?? '尚未生成视频分析'}
内容概括：${guide?.decision.overallMeaning ?? guide?.decision.verdict ?? '尚未生成视频分析'}
观看建议：${guide?.suggestedStance ?? '按用户当前记录判断'}
信息边界：${guide?.decision.reservations.join('；') || '无'}
</watching_strategy>

<current_goal>
目标：${input.session.goal.label ?? input.session.goal.mode}
关注：${input.session.goal.focus || '未指定'}
整理指令：${input.session.goal.instruction ?? '按视频内容和用户记录自然整理'}
</current_goal>

<moment>
类型：${formatMomentKind(input.moment.kind)}
来源：${formatMomentSource(input.moment)}
时间：${input.moment.timestamp !== undefined ? formatSeconds(input.moment.timestamp) : '无时间点'}
内容：${input.moment.content}
</moment>

<optional_timeline>
${timelineText}
</optional_timeline>

<video_analysis>
${analysisText}
</video_analysis>

<nearby_transcript>
${transcriptText}
</nearby_transcript>

只输出以下 JSON：

{
  "response": "用 2-4 句话回应用户这条记录：它意味着什么、该不该继续处理、怎么处理",
  "handling": "keep | ask | verify | apply | release",
  "suggestedQuestions": ["0-3 个后续可以追问的问题"],
  "nextAction": "可选：一个具体下一步；没有就省略",
  "linkedTimestamps": [
    { "timestamp": 120, "reason": "为什么建议回看这里" }
  ]
}

约束：
- response 要像给用户本人补充说明，不能像摘要。
- response 不要复述 handling 标签，不要把“保留/追问/验证/行动/放下”当正文标题。
- suggestedQuestions 最多 3 条，允许为空。
- linkedTimestamps 最多 3 条，只有有明确证据时才填。
- 如果处理方式是 release，不要再给沉重作业。`;
}

function pickMomentTranscriptCues(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly moment: LearningMoment;
}): readonly SubtitleCue[] {
  const nearby =
    input.moment.timestamp !== undefined
      ? pickCuesNearest(input.transcriptCues, input.moment.timestamp, 8, 4)
      : [];
  if (nearby.length > 0) {
    return applyCharBudget(nearby, 6_000);
  }
  return applyCharBudget(
    pickRepresentativeCues(input.transcriptCues, input.metadata.duration),
    6_000,
  );
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

function formatMomentKind(kind: LearningMoment['kind']): string {
  return {
    note: '记录',
    insight: '发现',
    question: '疑问',
    action: '行动',
  }[kind];
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
    Array.isArray(value.reservations)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatMomentSource(moment: LearningMoment): string {
  if (moment.source === 'mentor_card') {
    return moment.originTitle ? `旧提示：${moment.originTitle}` : '旧提示';
  }
  return '用户手动记录';
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
