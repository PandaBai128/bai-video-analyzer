import { useLayoutEffect, useRef, type ReactElement } from 'react';
import type { FollowupAnswerBasis } from '@shared/messages';
import { useUiText } from '@extension/ui/locale-context';

/**
 * FollowupTab 底部输入区。
 *
 * - DOM 顺序：textarea → 底栏（回答依据 + 发送按钮同行）。
 *   底栏是**单一**水平容器：左侧回答依据，右侧发送按钮 `shrink-0`。
 *   正常 sidepanel 宽度下不换行；不另起一行。
 * - textarea 自适应 1-5 行；超过 5 行后固定高度并内部滚动。
 * - Enter 提交；Cmd / Ctrl / Shift + Enter 换行。
 * - textarea + 发送按钮在 disabled / 草稿为空时禁用；**回答依据不受 busy 影响**。
 *   已发请求使用提交瞬间快照，新选择只影响下一次提交。
 * - 回答依据默认只显示：仅视频 / 通识。
 * - 设置页开启联网搜索且已授权后，才显示第三段：联网。
 *   状态由父组件持有，本组件只渲染 + 触发回调。
 *
 * 不负责：
 * - 输入状态本身（由 use-followup-session 持有；这里只接收 draft / onChange / onSubmit）
 */

const MAX_COMPOSER_ROWS = 5;
/** 每行近似高度（与 line-height + padding 一致）。follow tailwind min-h-10 = 40px。 */
const COMPOSER_ROW_HEIGHT_PX = 24;

export interface FollowupComposerProps {
  readonly draft: string;
  readonly disabled: boolean;
  readonly isBusy?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
  /** 当前回答依据。缺省表示老调用方，不渲染依据行。 */
  readonly answerBasis?: FollowupAnswerBasis;
  /** 切换三段单选。 */
  readonly onChangeAnswerBasis?: (next: FollowupAnswerBasis) => void;
  /** 联网搜索是否可选。未传时按未配置处理，不渲染联网入口。 */
  readonly webSearchAvailable?: boolean;
  /** 是否展示回答依据选择。 */
  readonly showAnswerBasis?: boolean;
}

export function FollowupComposer(props: FollowupComposerProps): ReactElement {
  const t = useUiText();
  const {
    draft,
    disabled,
    isBusy = false,
    onChange,
    onSubmit,
    onCancel,
    answerBasis,
    onChangeAnswerBasis,
    webSearchAvailable = false,
    showAnswerBasis = true,
  } = props;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const effectiveAnswerBasis =
    answerBasis === 'video_plus_web' && !webSearchAvailable ? 'video_only' : answerBasis;
  const basisOptions: ReadonlyArray<{
    readonly value: FollowupAnswerBasis;
    readonly label: string;
    readonly title: string;
  }> = [
    {
      value: 'video_only',
      label: t('仅视频', 'Video'),
      title: t('只依据当前视频字幕、导航和已有上下文回答。', 'Answer only from the current video subtitles, navigation, and context.'),
    },
    {
      value: 'video_plus_general',
      label: t('通识', 'General'),
      title: t('视频为底座，允许模型补充通识；不会声称联网。', 'Use the video as the base and allow general knowledge; no web claims.'),
    },
    {
      value: 'video_plus_web',
      label: t('联网', 'Web'),
      title: t('先调用 MiniMax 联网搜索，再把结果作为带来源的补充依据。', 'Run MiniMax web search first and use sourced results as supplements.'),
    },
  ];
  const visibleBasisOptions = webSearchAvailable
    ? basisOptions
    : basisOptions.filter((option) => option.value !== 'video_plus_web');
  // 在 paint 前同步高度，避免输入时出现先截断再重排的闪烁。
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    const maxHeight = MAX_COMPOSER_ROWS * COMPOSER_ROW_HEIGHT_PX;
    // 临时 auto 拿到真实 scrollHeight
    element.style.height = 'auto';
    const nextHeight = Math.min(element.scrollHeight, maxHeight);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [draft]);

  const handleSelectBasis = (next: FollowupAnswerBasis): void => {
    if (!onChangeAnswerBasis) {
      return;
    }
    if (next === 'video_plus_web' && !webSearchAvailable) {
      return;
    }
    onChangeAnswerBasis(next);
  };

  return (
    <div className="space-y-1" data-testid="followup-composer">
      <textarea
        ref={textareaRef}
        className="bai-composer-input w-full min-h-[36px] resize-none border border-input bg-background px-3 py-1 text-sm"
        value={draft}
        placeholder={t('快速提问...', 'Ask quickly...')}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // 修饰键（Cmd/Ctrl/Shift）+ Enter 仍走换行；纯 Enter 走提交。
          if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            if (!disabled && !isBusy && draft.trim()) {
              onSubmit();
            }
          }
        }}
        rows={1}
        data-testid="followup-composer-textarea"
      />
      {/* 底栏：单一水平容器。QA1 必修 4 / QA2 必修 3：必须严格单行。
          - `flex-nowrap`：禁止依据区换行。
          - **不**使用 `overflow-hidden`：禁止静默裁掉回答依据控件；通过
            压缩 gap / chip padding / 字号实现正常 sidepanel 宽度下单行。
          - 每个 segment `whitespace-nowrap`：禁止按钮文字内部换行。
          - 发送按钮 `shrink-0`：保留按钮宽度不被挤压。 */}
      <div
        className="flex flex-nowrap items-center gap-1"
        data-testid="followup-composer-footer"
      >
        {showAnswerBasis && answerBasis !== undefined ? (
          <div
            className="flex min-w-0 flex-1 flex-nowrap items-center gap-1"
            data-testid="followup-answer-basis"
          >
            <div
              className="bai-answer-basis-group flex min-w-0 border border-border"
              role="group"
              aria-label={t('回答依据', 'Answer basis')}
            >
              {visibleBasisOptions.map((option) => {
                const active = option.value === effectiveAnswerBasis;
                const optionDisabled =
                  !onChangeAnswerBasis ||
                  (option.value === 'video_plus_web' && !webSearchAvailable);
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      'bai-answer-basis-option whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium transition-colors ' +
                      (optionDisabled
                        ? 'cursor-not-allowed bg-muted text-muted-foreground opacity-50'
                        : active
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background text-muted-foreground hover:bg-accent')
                    }
                    title={
                      option.value === 'video_plus_web' && !webSearchAvailable
                        ? t('请先在设置中开启实验室联网搜索', 'Enable experimental web search in Settings first')
                        : option.title
                    }
                    data-bai-basis={option.value}
                    aria-pressed={active}
                    disabled={optionDisabled}
                    onClick={() => handleSelectBasis(option.value)}
                  >
                    {active ? `✓ ${option.label}` : option.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex-1" data-testid="followup-answer-basis-spacer" />
        )}
        <button
          className="bai-send-button shrink-0 whitespace-nowrap bg-primary px-2 py-0.5 text-xs font-medium leading-4 text-primary-foreground hover:opacity-90 disabled:opacity-60"
          type="button"
          disabled={isBusy ? !onCancel : disabled || !draft.trim()}
          onClick={isBusy ? onCancel : onSubmit}
          data-testid="followup-composer-send"
        >
          {isBusy ? t('停止', 'Stop') : t('发送', 'Send')}
        </button>
      </div>
    </div>
  );
}
