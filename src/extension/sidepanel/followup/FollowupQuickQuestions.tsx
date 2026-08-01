import type { ReactElement } from 'react';
import type { SubmitQuestionOptions } from './use-followup-session';
import { useUiText } from '@extension/ui/locale-context';

/**
 * FollowupTab 的快捷问题配置。
 *
 * - 需要当前播放时间的问题（requiresCurrentTime）会在本地拦截，避免让模型猜测"当前片段"。
 * - 强制使用当前片段上下文（forceCurrentSegment）让 background 走 current_segment 兜底。
 * - 只有显式追问选中节点时（useSelectedTimestamp）才携带 selectedTimestamp，
 *   避免全局问题被旧焦点劫持。
 */
interface QuickQuestion {
  readonly id: string;
  readonly label: string;
  readonly question: string;
  readonly requiresCurrentTime?: boolean;
  readonly forceCurrentSegment?: boolean;
  readonly useSelectedTimestamp?: boolean;
}

export interface FollowupQuickQuestionsProps {
  readonly disabled: boolean;
  readonly onSubmit: (question: string, options?: SubmitQuestionOptions) => void;
}

function buildSubmitOptions(question: QuickQuestion): SubmitQuestionOptions | undefined {
  if (
    !question.requiresCurrentTime &&
    !question.forceCurrentSegment &&
    !question.useSelectedTimestamp
  ) {
    return undefined;
  }
  return {
    ...(question.requiresCurrentTime ? { requiresCurrentTime: true } : {}),
    ...(question.forceCurrentSegment ? { forceCurrentSegment: true } : {}),
    ...(question.useSelectedTimestamp ? { useSelectedTimestamp: true } : {}),
  };
}

/**
 * 快捷问题 chip 行。loading / streaming 时禁用，避免重复发包。
 */
export function FollowupQuickQuestions(props: FollowupQuickQuestionsProps): ReactElement {
  const t = useUiText();
  const { disabled, onSubmit } = props;
  const quickQuestions: readonly QuickQuestion[] = [
    {
      id: 'video-summary',
      label: t('整体讲什么？', 'What is it about?'),
      question: t(
        '这个视频整体讲了什么内容？请用学习视角概括内容主线、关键概念和核心观点，不要照搬分析页模板，也不要输出观看路线。',
        'What is this video about overall? From a learning perspective, summarize the main thread, key concepts, and core ideas. Do not judge whether it is worth watching or output a watch route.',
      ),
    },
    {
      id: 'current-segment',
      label: t('这段怎么理解？', 'Explain this part'),
      question: t(
        '请解释当前片段在讲什么、它和前后内容的关系，以及这里需要抓住的关键细节。',
        'Explain what the current segment is saying, how it relates to the surrounding content, and the key details to catch here.',
      ),
      requiresCurrentTime: true,
      forceCurrentSegment: true,
    },
    {
      id: 'next-focus',
      label: t('后面重点看哪？', 'What next?'),
      question: t(
        '从当前播放位置往后，接下来内容会怎么展开？请按时间顺序说明后续主线、关键转折和需要留意的概念或观点。',
        'From the current playback position, how will the following content unfold? Explain the upcoming thread, key turns, and concepts or ideas to watch for in chronological order.',
      ),
      requiresCurrentTime: true,
    },
    {
      id: 'key-ideas',
      label: t('观点和保留？', 'Ideas & caveats?'),
      question: t(
        '这个视频有哪些核心观点值得参考？哪些地方证据不足、需要保留意见或自己验证？',
        'What core ideas in this video are worth referencing? Where is the evidence insufficient or worth reserving judgment and verifying myself?',
      ),
    },
  ];
  return (
    <div
      className="bai-quick-question-panel space-y-2 border border-border bg-card/70 p-2"
      data-testid="followup-quick-questions"
    >
      <p className="text-xs font-semibold text-foreground">{t('快捷问题', 'Quick Questions')}</p>
      <div className="flex flex-wrap gap-1.5">
        {quickQuestions.map((question) => {
          const submitOptions = buildSubmitOptions(question);
          return (
            <button
              key={question.id}
              className="rounded-full border border-border bg-background px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
              type="button"
              disabled={disabled}
              data-quick-question-id={question.id}
              onClick={() => onSubmit(question.question, submitOptions)}
            >
              {question.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
