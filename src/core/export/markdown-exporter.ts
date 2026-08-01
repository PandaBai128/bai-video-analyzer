import type {
  LearningExchange,
  LearningMoment,
  LearningSession,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';

// Markdown 导出主要用标题层级表达结构：H1=视频，H2=主区块，H3=小节，H4=单条记录。
// 第二章首段按产品约定加粗，用来突出“我真正得到的理解”。
export interface VideoMarkdownExport {
  readonly fileName: string;
  readonly content: string;
}

interface MarkdownCopy {
  readonly sections: {
    readonly basicInfo: string;
    readonly whatVideoSays: string;
    readonly whatIGot: string;
    readonly referenceIdeas: string;
    readonly reservations: string;
    readonly myRecords: string;
  };
  readonly subsections: {
    readonly whatIGot: string;
    readonly transfer: string;
    readonly nextSteps: string;
    readonly watchRecords: string;
    readonly includedExchanges: string;
    readonly exchange: string;
  };
  readonly table: {
    readonly field: string;
    readonly content: string;
    readonly video: string;
    readonly author: string;
    readonly url: string;
    readonly platform: string;
    readonly watchTime: string;
    readonly contentType: string;
    readonly noteAngle: string;
    readonly focus: string;
  };
  readonly labels: {
    readonly separator: string;
    readonly question: string;
    readonly answer: string;
    readonly addedToNotes: string;
    readonly manual: string;
    readonly coach: string;
    readonly nextAction: string;
  };
  readonly momentKinds: Record<LearningMoment['kind'], string>;
  readonly empty: {
    readonly noGuide: string;
    readonly notSpecified: string;
    readonly notProvided: string;
    readonly noInsights: string;
    readonly noTransfer: string;
    readonly noActions: string;
    readonly noKeyIdeas: string;
    readonly noReservations: string;
    readonly noTrace: string;
  };
  readonly errors: {
    readonly reviewRequired: string;
  };
}

function getMarkdownCopy(locale: UiLocale): MarkdownCopy {
  if (locale === 'en-US') {
    return {
      sections: {
        basicInfo: 'Basic Info',
        whatVideoSays: 'What the Video Says',
        whatIGot: 'What I Got',
        referenceIdeas: 'Ideas Worth Referencing',
        reservations: 'What I Need to Reserve Judgment On',
        myRecords: 'My Records',
      },
      subsections: {
        whatIGot: 'What I Got',
        transfer: 'How I Can Use This',
        nextSteps: 'Next Steps',
        watchRecords: 'Watch Records',
        includedExchanges: 'Q&A Added to Notes',
        exchange: 'Q&A',
      },
      table: {
        field: 'Field',
        content: 'Content',
        video: 'Video',
        author: 'Author',
        url: 'URL',
        platform: 'Platform',
        watchTime: 'Watch Time',
        contentType: 'Content Type',
        noteAngle: 'Note Angle',
        focus: 'Extra Focus',
      },
      labels: {
        separator: ': ',
        question: 'Question',
        answer: 'Answer',
        addedToNotes: 'Added to notes',
        manual: 'Manual record',
        coach: 'Extra note',
        nextAction: 'Suggested next step',
      },
      momentKinds: {
        note: 'Note',
        insight: 'Insight',
        question: 'Question',
        action: 'Action',
      },
      empty: {
        noGuide: 'Video analysis not generated',
        notSpecified: 'Not specified',
        notProvided: 'Not provided',
        noInsights: 'No clear takeaways yet. Add records and regenerate notes.',
        noTransfer: 'No clear transfer path yet. Add records and regenerate notes.',
        noActions: 'No required next steps.',
        noKeyIdeas: 'No specific ideas worth referencing.',
        noReservations: 'No major reservations yet.',
        noTrace: 'No manual records or Q&A added to notes yet.',
      },
      errors: {
        reviewRequired: 'Generate study notes before exporting.',
      },
    };
  }
  return {
    sections: {
      basicInfo: '基本信息',
      whatVideoSays: '视频讲了什么',
      whatIGot: '我得到了什么',
      referenceIdeas: '哪些观点值得参考',
      reservations: '哪些我需要保留判断',
      myRecords: '我的记录',
    },
    subsections: {
      whatIGot: '我得到了什么',
      transfer: '我可以根据这个做什么',
      nextSteps: '下一步怎么做',
      watchRecords: '观看记录',
      includedExchanges: '加入笔记的问答',
      exchange: '问答',
    },
    table: {
      field: '字段',
      content: '内容',
      video: '视频',
      author: '作者',
      url: '地址',
      platform: '平台',
      watchTime: '观看时间',
      contentType: '内容类型',
      noteAngle: '笔记角度',
      focus: '补充关注点',
    },
    labels: {
      separator: '：',
      question: '我问',
      answer: '回答',
      addedToNotes: '加入笔记',
      manual: '手动记录',
      coach: '补充说明',
      nextAction: '建议下一步',
    },
    momentKinds: {
      note: '记录',
      insight: '发现',
      question: '疑问',
      action: '行动',
    },
    empty: {
      noGuide: '未生成视频分析',
      notSpecified: '未指定',
      notProvided: '未提供',
      noInsights: '暂无明确收获；可以补充记录后重新生成。',
      noTransfer: '暂无明确迁移方式；可以补充记录后重新生成。',
      noActions: '暂无必须执行的下一步。',
      noKeyIdeas: '暂无值得单独参考的观点。',
      noReservations: '暂无需要特别保留判断的地方。',
      noTrace: '暂无手动记录或加入笔记的问答。',
    },
    errors: {
      reviewRequired: '请先生成学习笔记，再导出。',
    },
  };
}

export function createVideoMarkdownExport(input: {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis | null;
  readonly learningSession: LearningSession;
  readonly exportedAt: number;
  readonly outputLocale?: UiLocale;
}): VideoMarkdownExport {
  const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
  const baseFileName = sanitizeFileName(
    `${formatPlatformFilePrefix(input.metadata.platform)}-${formatHeadingText(input.metadata.title)}`,
  );
  return {
    fileName: `${baseFileName || 'bai-note'}.md`,
    content: createStandardNoteMarkdown({ ...input, outputLocale }),
  };
}

export function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[\s\S]/g, (character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 140);
}

function createStandardNoteMarkdown(input: {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis | null;
  readonly learningSession: LearningSession;
  readonly exportedAt: number;
  readonly outputLocale: UiLocale;
}): string {
  const review = input.learningSession.review;
  const copy = getMarkdownCopy(input.outputLocale);
  if (!review) {
    throw new Error(copy.errors.reviewRequired);
  }
  const selectedExchanges = pickIncludedReviewExchanges(input.learningSession);
  return `# ${formatHeadingText(input.metadata.title)}

## ${copy.sections.basicInfo}

| ${copy.table.field} | ${copy.table.content} |
| --- | --- |
| ${copy.table.video} | ${formatTableCell(input.metadata.title, copy.empty.notProvided)} |
| ${copy.table.author} | ${formatTableCell(input.metadata.author, copy.empty.notProvided)} |
| ${copy.table.url} | ${formatTableCell(input.metadata.url, copy.empty.notProvided)} |
| ${copy.table.platform} | ${formatTableCell(input.metadata.platform, copy.empty.notProvided)} |
| ${copy.table.watchTime} | ${formatDateTime(input.learningSession.createdAt, input.outputLocale)} |
| ${copy.table.contentType} | ${formatTableCell(input.learningSession.guide?.contentType ?? copy.empty.noGuide, copy.empty.notProvided)} |
| ${copy.table.noteAngle} | ${formatTableCell(formatLearningGoal(input.learningSession, input.outputLocale), copy.empty.notProvided)} |
| ${copy.table.focus} | ${formatTableCell(input.learningSession.goal.focus || copy.empty.notSpecified, copy.empty.notProvided)} |

## 1. ${copy.sections.whatVideoSays}

${review.coreSummary}

## 2. ${copy.sections.whatIGot}

${formatTakeaways(review, input.learningSession.moments, selectedExchanges, copy)}

## 3. ${copy.sections.referenceIdeas}

${formatKeyIdeas(review.keyIdeas, input.analysis, copy)}

## 4. ${copy.sections.reservations}

${formatReservations(review, copy)}

## 5. ${copy.sections.myRecords}

${formatLearningTraceSection(input.learningSession.moments, selectedExchanges, copy)}`;
}

function formatTakeaways(
  review: NonNullable<LearningSession['review']>,
  moments: readonly LearningMoment[],
  exchanges: readonly LearningExchange[],
  copy: MarkdownCopy,
): string {
  const sourceTexts = [
    ...moments.map((moment) => moment.content),
    ...exchanges.flatMap((exchange) => [exchange.question, exchange.answer]),
  ];
  const distinct = review.personalInsights.filter(
    (insight) => !isDuplicateLearningTrace(insight, sourceTexts),
  );
  return [
    `### ${copy.subsections.whatIGot}\n\n**${review.finalReflection}**\n\n${formatNumberedList(distinct, copy.empty.noInsights)}`,
    `### ${copy.subsections.transfer}\n\n${formatTransferReflection(review, copy)}`,
    `### ${copy.subsections.nextSteps}\n\n${formatNumberedList(review.actionItems, copy.empty.noActions)}`,
  ].join('\n\n');
}

function formatTransferReflection(
  review: NonNullable<LearningSession['review']>,
  copy: MarkdownCopy,
): string {
  return review.transferReflection?.trim() || copy.empty.noTransfer;
}

function formatKeyIdeas(
  ideas: NonNullable<LearningSession['review']>['keyIdeas'],
  analysis: VideoAnalysis | null,
  copy: MarkdownCopy,
): string {
  if (ideas.length === 0) {
    return copy.empty.noKeyIdeas;
  }
  return ideas
    .map(
      (idea) =>
        `### ${idea.evidenceTimestamp !== undefined ? `[${formatEvidenceRange(idea.evidenceTimestamp, analysis)}] ` : ''}${idea.title}\n\n${idea.explanation}`,
    )
    .join('\n\n');
}

function formatReservations(
  review: NonNullable<LearningSession['review']>,
  copy: MarkdownCopy,
): string {
  return formatList(review.openQuestions, `- ${copy.empty.noReservations}`);
}

function formatLearningTraceSection(
  moments: readonly LearningMoment[],
  exchanges: readonly LearningExchange[],
  copy: MarkdownCopy,
): string {
  const sections: string[] = [];
  if (moments.length > 0) {
    sections.push(`### ${copy.subsections.watchRecords}\n\n${moments.map((moment) => formatMoment(moment, copy)).join('\n')}`);
  }
  if (exchanges.length > 0) {
    sections.push(`### ${copy.subsections.includedExchanges}\n\n${formatSelectedExchanges(exchanges, copy)}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : copy.empty.noTrace;
}

function formatSelectedExchanges(
  exchanges: readonly LearningExchange[],
  copy: MarkdownCopy,
): string {
  return exchanges
    .map(
      (exchange, index) =>
        `#### ${copy.subsections.exchange} ${index + 1}\n\n${formatLabelValue(copy, copy.labels.question, exchange.question)}\n\n${formatLabelValue(copy, copy.labels.answer, exchange.answer)}`,
    )
    .join('\n\n');
}

function formatList(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function formatNumberedList(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((item, index) => `${index + 1}. ${item}`).join('\n') : empty;
}

function pickIncludedReviewExchanges(session: LearningSession): readonly LearningExchange[] {
  return session.exchanges.filter((exchange) => exchange.includedInReview === true).slice(-8);
}

function formatMoment(moment: LearningMoment, copy: MarkdownCopy): string {
  const label = {
    note: copy.momentKinds.note,
    insight: copy.momentKinds.insight,
    question: copy.momentKinds.question,
    action: copy.momentKinds.action,
  }[moment.kind];
  const timestamp = moment.timestamp !== undefined ? `[${formatSeconds(moment.timestamp)}] ` : '';
  const source = moment.source
    ? ` · ${moment.source === 'mentor_card' ? copy.labels.addedToNotes : copy.labels.manual}`
    : '';
  const coach = moment.coach
    ? `\n\n${formatLabelValue(copy, copy.labels.coach, moment.coach.response)}${moment.coach.nextAction ? `\n\n${formatLabelValue(copy, copy.labels.nextAction, moment.coach.nextAction)}` : ''}`
    : '';
  return `#### ${timestamp}${label}${source}\n\n${moment.content}${coach}`;
}

function formatLabelValue(copy: MarkdownCopy, label: string, value: string): string {
  return `${label}${copy.labels.separator}${value}`;
}

function formatLearningGoal(session: LearningSession, locale: UiLocale): string {
  return session.goal.label ?? formatGoalMode(session.goal.mode, locale);
}

function formatPlatformFilePrefix(platform: VideoMetadata['platform']): string {
  return {
    bilibili: 'B站',
    youtube: 'YouTube',
  }[platform];
}

function formatGoalMode(mode: LearningSession['goal']['mode'], locale: UiLocale): string {
  const labels =
    locale === 'en-US'
      ? {
          adaptive: 'Adaptive',
          understand: 'Understand',
          apply: 'Apply',
          challenge: 'Challenge',
        }
      : {
          adaptive: '自适应',
          understand: '理解',
          apply: '应用',
          challenge: '质疑',
        };
  return labels[mode];
}

function formatDateTime(timestamp: number, locale: UiLocale): string {
  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function formatEvidenceRange(timestamp: number, analysis: VideoAnalysis | null): string {
  const node = pickEvidenceNode(timestamp, analysis);
  if (!node) return formatSeconds(timestamp);
  const endTimestamp = node.endTimestamp ?? pickNextTimestamp(node.timestamp, analysis);
  return endTimestamp !== undefined && endTimestamp > node.timestamp
    ? `${formatSeconds(node.timestamp)}-${formatSeconds(endTimestamp)}`
    : formatSeconds(node.timestamp);
}

function pickEvidenceNode(
  timestamp: number,
  analysis: VideoAnalysis | null,
): { readonly timestamp: number; readonly endTimestamp?: number } | null {
  const nodes = [...(analysis?.timeline ?? []), ...(analysis?.chapters ?? [])]
    .filter((node) => node.timestamp <= timestamp)
    .sort((left, right) => right.timestamp - left.timestamp);
  return nodes[0] ?? null;
}

function pickNextTimestamp(timestamp: number, analysis: VideoAnalysis | null): number | undefined {
  const nextNode = [...(analysis?.timeline ?? []), ...(analysis?.chapters ?? [])]
    .filter((node) => node.timestamp > timestamp)
    .sort((left, right) => left.timestamp - right.timestamp)[0];
  return nextNode?.timestamp;
}

function isDuplicateLearningTrace(insight: string, sourceTexts: readonly string[]): boolean {
  const normalizedInsight = normalizeTraceText(insight);
  return sourceTexts.some((source) => {
    const normalizedSource = normalizeTraceText(source);
    if (!normalizedSource) return false;
    return (
      normalizedInsight === normalizedSource ||
      (normalizedSource.length >= 12 && normalizedInsight.includes(normalizedSource))
    );
  });
}

function normalizeTraceText(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。！？、；：:“”"'‘’（）()[\]【】《》·.?!,;:-]/g, '');
}

function formatHeadingText(value: string): string {
  return collapseInlineText(value) || '未命名视频';
}

function formatTableCell(value: string, fallback = '未提供'): string {
  const text = collapseInlineText(value).replace(/\|/g, '\\|');
  return text || fallback;
}

function collapseInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
