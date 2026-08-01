import { useMemo, type ReactElement } from 'react';
import { cn } from '@lib/utils';
import { MarkdownMessage } from '../MarkdownMessage';
import { useStreamingDisplay } from '../use-streaming-display';
import {
  splitSuggestedQuestions,
  stripSuggestedQuestionsSection,
} from '@core/followup/followup-suggestions';
import type { FollowupMessage, FollowupPhase } from '../followup-state';
import type { LearningExchange } from '@core/types';
import type { FollowupAnswerBasis } from '@shared/messages';
import { useUiLocale, useUiText } from '@extension/ui/locale-context';
import { localizeUserMessage } from '@extension/ui/localized-error';

const MAX_REVIEW_EXCHANGES = 8;

/**
 * 追问回答的消息列表 + 单条 bubble。
 *
 * 职责：
 * - 渲染 user / assistant message
 * - assistant 流式 / loading / idle 三种 phaseKind 切换 Markdown vs "正在回答..." vs 流光标
 * - 提取 assistant 完成态的"继续追问"建议
 * - assistant Markdown 内的 [mm:ss] 时间点通过 onSeekTimestamp 回调给父组件
 *
 * 不负责：
 * - Phase 状态机、Port、watchdog、payload 构造（use-followup-session 已经包办）
 * - 输入区（FollowupComposer）
 */

type AssistantPhaseKind = 'idle' | 'loading' | 'streaming';

function resolveAssistantPhaseKind(
  message: FollowupMessage,
  phase: FollowupPhase,
): AssistantPhaseKind {
  if (message.role !== 'assistant') {
    return 'idle';
  }
  if (phase.kind === 'streaming' && 'assistantMessageId' in phase) {
    return phase.assistantMessageId === message.id ? 'streaming' : 'idle';
  }
  if (phase.kind === 'loading' && 'assistantMessageId' in phase) {
    return phase.assistantMessageId === message.id ? 'loading' : 'idle';
  }
  return 'idle';
}

export interface FollowupMessagesProps {
  readonly messages: readonly FollowupMessage[];
  readonly phase: FollowupPhase;
  /** 继续追问 / 快捷问题 loading 时禁用，避免重复发包。 */
  readonly suggestionDisabled: boolean;
  /** 点击"继续追问"按钮时调用。 */
  readonly onSubmitSuggestion: (question: string) => void;
  /** assistant Markdown 内的 [mm:ss] 时间点被点击时调用。 */
  readonly onSeekTimestamp?: (seconds: number) => void;
  readonly includedExchangeIds?: readonly string[];
  readonly includedExchangeCount?: number;
  readonly onToggleExchangeInReview?: (
    exchange: LearningExchange,
    includedInReview: boolean,
  ) => void;
}

export function FollowupMessages(props: FollowupMessagesProps): ReactElement {
  const {
    messages,
    phase,
    suggestionDisabled,
    onSubmitSuggestion,
    onSeekTimestamp,
    includedExchangeIds = [],
    includedExchangeCount = 0,
    onToggleExchangeInReview,
  } = props;
  return (
    <div className="space-y-2">
      {messages.map((message, index) => {
        const phaseKind = resolveAssistantPhaseKind(message, phase);
        const exchange = buildCompletedExchange(messages[index - 1], message, phaseKind);
        const isIncluded = exchange !== undefined && includedExchangeIds.includes(exchange.id);
        return (
          <FollowupMessageBubble
            key={message.id}
            message={message}
            phaseKind={phaseKind}
            {...(onSeekTimestamp ? { onSeekTimestamp } : {})}
            onClickSuggestion={onSubmitSuggestion}
            suggestionDisabled={suggestionDisabled}
            {...(exchange ? { exchange } : {})}
            exchangeIncluded={isIncluded}
            exchangeIncludeDisabled={
              Boolean(exchange) && !isIncluded && includedExchangeCount >= MAX_REVIEW_EXCHANGES
            }
            {...(onToggleExchangeInReview ? { onToggleExchangeInReview } : {})}
          />
        );
      })}
    </div>
  );
}

interface FollowupMessageBubbleProps {
  readonly message: FollowupMessage;
  readonly phaseKind: AssistantPhaseKind;
  /** assistant Markdown 里的时间点被点击时调用。 */
  readonly onSeekTimestamp?: (seconds: number) => void;
  /** 点击"继续追问"按钮时调用。 */
  readonly onClickSuggestion?: (suggestion: string) => void;
  /** loading / streaming 时禁用建议按钮，避免重复发包。 */
  readonly suggestionDisabled?: boolean;
  readonly exchange?: LearningExchange;
  readonly exchangeIncluded?: boolean;
  readonly exchangeIncludeDisabled?: boolean;
  readonly onToggleExchangeInReview?: (
    exchange: LearningExchange,
    includedInReview: boolean,
  ) => void;
}

function FollowupMessageBubble(props: FollowupMessageBubbleProps): ReactElement {
  const locale = useUiLocale();
  const t = useUiText();
  const {
    message,
    phaseKind,
    onSeekTimestamp,
    onClickSuggestion,
    suggestionDisabled = false,
    exchange,
    exchangeIncluded = false,
    exchangeIncludeDisabled = false,
    onToggleExchangeInReview,
  } = props;
  const isUser = message.role === 'user';
  // assistant 用 Markdown 渲染；用户消息和错误消息保持纯文本。
  const isAssistantStreaming =
    message.role === 'assistant' && (phaseKind === 'loading' || phaseKind === 'streaming');
  const showAssistantMarkdown = message.role === 'assistant' && Boolean(message.content);
  const { displayed } = useStreamingDisplay({
    content: message.content,
    streaming: isAssistantStreaming,
  });

  // 只在完成态 assistant 消息中提取继续追问，避免半截流式内容触发按钮。
  const splitView = useMemo<{
    readonly body: string;
    readonly suggestions: readonly string[];
  }>(() => {
    if (message.role !== 'assistant') {
      return { body: message.content, suggestions: [] };
    }
    if (phaseKind === 'loading' || phaseKind === 'streaming') {
      return { body: message.content, suggestions: [] };
    }
    if (message.error) {
      return { body: message.content, suggestions: [] };
    }
    const split = splitSuggestedQuestions(message.content);
    return { body: split.bodyMarkdown, suggestions: split.suggestions };
  }, [message.role, message.content, message.error, phaseKind]);
  const suggestions = splitView.suggestions;

  return (
    <div
      className={cn(
        'bai-message-bubble rounded-md border p-3 text-sm text-foreground',
        isUser
          ? 'bai-message-bubble-user border-primary/40 bg-accent'
          : 'bai-message-bubble-assistant border-border bg-card',
      )}
    >
      <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <span>{isUser ? t('你', 'You') : t('bAI 助手', 'bAI Assistant')}</span>
        {!isUser && message.answerBasis ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
            {formatAnswerBasisLabel(message.answerBasis, t)}
          </span>
        ) : null}
      </p>
      {message.error ? (
        <p className="text-destructive">
          {t('出错了', 'Error')}: {localizeUserMessage(message.error, locale)}
          {message.error.code
            ? locale === 'en-US'
              ? ` (${message.error.code})`
              : `（${message.error.code}）`
            : ''}
        </p>
      ) : isUser ? (
        <p className="whitespace-pre-wrap leading-6">{message.content}</p>
      ) : showAssistantMarkdown ? (
        <MarkdownMessage
          content={
            phaseKind === 'streaming' || phaseKind === 'loading' ? displayed : splitView.body
          }
          isStreaming={phaseKind === 'streaming'}
          {...(onSeekTimestamp ? { onSeekTimestamp } : {})}
        />
      ) : phaseKind === 'loading' ? (
        <p className="text-muted-foreground">{t('正在回答...', 'Answering...')}</p>
      ) : phaseKind === 'streaming' ? (
        <p className="text-muted-foreground">▍</p>
      ) : null}
      {exchange && onToggleExchangeInReview ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={exchangeIncludeDisabled}
            className={cn(
              'rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50',
              exchangeIncluded
                ? 'border-primary bg-accent text-primary'
                : 'border-border bg-background hover:bg-accent',
            )}
            onClick={() => onToggleExchangeInReview(exchange, !exchangeIncluded)}
          >
            {exchangeIncluded
              ? t('移出笔记', 'Remove from Notes')
              : exchangeIncludeDisabled
                ? t('最多 8 条', 'Up to 8')
                : t('加入笔记', 'Add to Notes')}
          </button>
        </div>
      ) : null}
      {suggestions.length > 0 ? (
        <div className="mt-3 rounded-md border border-border bg-muted/40 p-2">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('继续追问', 'Follow Up')}</p>
          <div className="space-y-1">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                disabled={suggestionDisabled}
                onClick={() => onClickSuggestion?.(suggestion)}
                className="group flex w-full items-start justify-between rounded-md px-2 py-1.5 text-left text-xs leading-relaxed text-foreground hover:bg-background disabled:opacity-60"
              >
                <span>{suggestion}</span>
                <span
                  aria-hidden="true"
                  className="ml-2 shrink-0 text-muted-foreground group-hover:text-foreground"
                >
                  ↵
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatAnswerBasisLabel(
  basis: FollowupAnswerBasis,
  t: (zh: string, en: string) => string,
): string {
  if (basis === 'video_plus_general') return t('通识', 'General');
  if (basis === 'video_plus_web') return t('联网', 'Web');
  return t('仅视频', 'Video');
}

function buildCompletedExchange(
  previous: FollowupMessage | undefined,
  current: FollowupMessage,
  phaseKind: AssistantPhaseKind,
): LearningExchange | undefined {
  if (!previous || previous.role !== 'user') return undefined;
  if (current.role !== 'assistant') return undefined;
  if (current.error || current.streaming) return undefined;
  if (phaseKind === 'loading' || phaseKind === 'streaming') return undefined;
  if (!previous.content.trim() || !current.content.trim()) return undefined;
  return {
    id: buildExchangeId(previous, current),
    question: previous.content,
    answer: stripSuggestedQuestionsSection(current.content).trim(),
    createdAt: previous.createdAt,
  };
}

function buildExchangeId(previous: FollowupMessage, current: FollowupMessage): string {
  return `v2:${previous.createdAt}:${previous.id}:${current.id}`;
}
