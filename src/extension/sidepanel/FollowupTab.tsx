import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react';
import type { PlaybackState } from '@shared/playback-state';
import type { AnalysisMode } from '@shared/settings';
import { useFollowupSession } from './followup/use-followup-session';
import { FollowupQuickQuestions } from './followup/FollowupQuickQuestions';
import { FollowupMessages } from './followup/FollowupMessages';
import { FollowupComposer } from './followup/FollowupComposer';
import type { LearningExchange } from '@core/types';
import { useUiLocale, useUiText } from '@extension/ui/locale-context';
import { localizeUserMessage } from '@extension/ui/localized-error';

/**
 * 追问 tab 页面。
 *
 * 只负责：
 * - 调用 useFollowupSession 拿 state / submitQuestion / changeInputDraft
 * - 无内容底座空态 + "开启提问" 兜底 CTA（**不**触发时间线生成）
 * - 错误 banner（MISSING_CURRENT_TIME 走无背景 banner，其它 code 走 data-testid banner）
 * - 根容器 + 滚动区 + 底部 composer footer 布局
 * - 只在 messages.length 变化时滚到底；流式增长不强制跟随
 * - 组合 QuickQuestions / Messages / Composer
 *
 * 不负责：
 * - Port / watchdog / payload 构造 / intent 路由 → useFollowupSession
 * - 消息列表渲染 / 继续追问 / Markdown → FollowupMessages
 * - 输入区自适应 → FollowupComposer
 * - 快捷问题 chip → FollowupQuickQuestions
 */
export interface FollowupTabProps {
  /** 是否已有当前模式可提问的上下文。公开版使用内容底座。 */
  readonly hasContentContext: boolean;
  readonly analysisMode?: AnalysisMode;
  readonly playbackState: PlaybackState | null;
  /** 准备内容底座，不触发时间线生成。 */
  readonly onPrepareContentContext: () => void;
  /** 准备中禁用 CTA，避免重复发起上下文请求。 */
  readonly isAnalyzing?: boolean;
  /** 视频 / 上下文变更标识；hook 用它切换对应提问快照。 */
  readonly contextKey: string;
  /** 测试可注入：覆盖 watchdog 超时。默认 30s / 60s。 */
  readonly firstByteTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  /** 测试可注入：requestId 生成器。默认走模块级 `generateRequestId`。 */
  readonly requestIdFactory?: () => string;
  /** assistant 回答里的时间点被点击时调用。 */
  readonly onSeekTimestamp?: (seconds: number) => void;
  /** 显式点选的时间线节点。只有明确询问选中片段时才传给后端。 */
  readonly selectedTimestamp?: number | null;
  readonly savedExchanges?: readonly LearningExchange[];
  readonly onToggleExchangeInReview?: (
    exchange: LearningExchange,
    includedInReview: boolean,
  ) => void;
  /** 追问联网搜索是否可选。由设置页实验室开关 + 授权状态共同决定。 */
  readonly webSearchAvailable?: boolean;
  /** 外部入口预填问题，例如判断页的推荐追问。 */
  readonly initialDraft?: {
    readonly id: number;
    readonly text: string;
  };
}

export function FollowupTab(props: FollowupTabProps): ReactElement {
  const locale = useUiLocale();
  const t = useUiText();
  const {
    hasContentContext,
    analysisMode = 'subtitle',
    playbackState,
    onPrepareContentContext,
    isAnalyzing = false,
    contextKey,
    firstByteTimeoutMs,
    streamIdleTimeoutMs,
    requestIdFactory,
    onSeekTimestamp,
    selectedTimestamp,
    savedExchanges = [],
    onToggleExchangeInReview,
    webSearchAvailable = false,
    initialDraft,
  } = props;

  const {
    state,
    phase,
    isBusy,
    answerBasis,
    submitQuestion,
    cancelQuestion,
    changeInputDraft,
    changeAnswerBasis,
  } = useFollowupSession({
    hasContentContext,
    analysisMode,
    playbackState,
    contextKey,
    ...(selectedTimestamp !== undefined ? { selectedTimestamp } : {}),
    ...(firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs } : {}),
    ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
    ...(requestIdFactory !== undefined ? { requestIdFactory } : {}),
  });

  /** 聊天滚动容器。发送新消息后滚到底，流式增长不强制跟随。 */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const appliedInitialDraftIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!initialDraft?.text.trim()) return;
    if (appliedInitialDraftIdRef.current === initialDraft.id) return;
    changeInputDraft(initialDraft.text);
    appliedInitialDraftIdRef.current = initialDraft.id;
  }, [changeInputDraft, initialDraft]);

  useEffect(() => {
    if (answerBasis === 'video_plus_web' && !webSearchAvailable) {
      changeAnswerBasis('video_only');
    }
  }, [answerBasis, changeAnswerBasis, webSearchAvailable]);

  /** 等 React 提交和浏览器 paint 后再读 scrollHeight，避免拿到陈旧高度。 */
  const scrollToBottomSoon = (): void => {
    const run = (): void => {
      const element = scrollContainerRef.current;
      if (!element) {
        return;
      }
      element.scrollTop = element.scrollHeight;
    };
    const raf: (cb: FrameRequestCallback) => number =
      typeof globalThis.requestAnimationFrame === 'function'
        ? (cb) => globalThis.requestAnimationFrame(cb)
        : (cb) => {
            const handle = globalThis.setTimeout(() => cb(Date.now()), 0);
            // Node setTimeout 返回 Timeout 对象；jsdom 返回 number。统一转 number。
            return typeof handle === 'number' ? handle : 0;
          };
    raf(() => raf(run));
  };

  // 只在消息条数变化时滚动，避免流式输出过程中打断用户阅读。
  useLayoutEffect(() => {
    scrollToBottomSoon();
  }, [state.messages.length]);

  if (phase.kind === 'no_context') {
    return (
      <div
        className="space-y-3 rounded-md border border-border bg-card p-3 text-sm"
        data-testid="followup-no-context"
      >
        <p className="text-muted-foreground">
          {t('需要先读取当前视频字幕作为回答依据。', 'Read the current video subtitles before asking questions.')}
        </p>
        <button
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          type="button"
          disabled={isAnalyzing}
          onClick={onPrepareContentContext}
          data-testid="followup-no-context-cta"
        >
          {isAnalyzing ? t('正在开启...', 'Opening...') : t('开启提问', 'Open Ask')}
        </button>
      </div>
    );
  }

  // 根容器由父级分配高度；内部只负责消息区滚动和底部输入区固定。
  const hasMessages = state.messages.length > 0;
  const scrollClassName = hasMessages
    ? 'min-h-0 flex-1 space-y-3 overflow-y-auto'
    : 'flex min-h-0 flex-1 flex-col space-y-3 overflow-y-auto';
  const includedExchangeCount = savedExchanges.filter(
    (exchange) => exchange.includedInReview === true,
  ).length;
  const includedExchangeIds = savedExchanges
    .filter((exchange) => exchange.includedInReview === true)
    .map((exchange) => exchange.id);
  const phaseErrorMessage =
    phase.kind === 'error'
      ? localizeUserMessage({ code: phase.code, message: phase.message }, locale)
      : '';

  return (
    <div className="flex h-full min-h-0 flex-col pt-3" data-testid="followup-tab-root">
      <div
        ref={scrollContainerRef}
        className={scrollClassName}
        data-testid="followup-tab-scroll"
      >
        {phase.kind === 'error' && phase.code === 'MISSING_CURRENT_TIME' ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {phaseErrorMessage}
          </div>
        ) : null}
        {phase.kind === 'error' && phase.code !== 'MISSING_CURRENT_TIME' ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="followup-error-banner"
            data-error-code={phase.code}
          >
            {phaseErrorMessage}
          </div>
        ) : null}

        <FollowupQuickQuestions disabled={isBusy} onSubmit={submitQuestion} />

        {hasMessages ? (
          <FollowupMessages
            messages={state.messages}
            phase={phase}
            suggestionDisabled={isBusy}
            onSubmitSuggestion={(suggestion) => submitQuestion(suggestion)}
            includedExchangeIds={includedExchangeIds}
            includedExchangeCount={includedExchangeCount}
            {...(onToggleExchangeInReview ? { onToggleExchangeInReview } : {})}
            {...(onSeekTimestamp ? { onSeekTimestamp } : {})}
          />
        ) : null}
      </div>

      <div
        className="bai-composer mt-2 shrink-0 border border-border bg-card p-2"
        data-testid="followup-composer-container"
      >
        <FollowupComposer
          draft={state.inputDraft}
          disabled={isBusy}
          isBusy={isBusy}
          onChange={changeInputDraft}
          onSubmit={() => submitQuestion(state.inputDraft)}
          onCancel={cancelQuestion}
          answerBasis={answerBasis}
          onChangeAnswerBasis={changeAnswerBasis}
          webSearchAvailable={webSearchAvailable}
        />
      </div>
    </div>
  );
}
