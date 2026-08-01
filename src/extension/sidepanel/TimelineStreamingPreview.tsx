/**
 * 导航流式预览。
 * 复用最终导航组件结构，只增加生成状态和可选调试输出，避免完成时样式跳变。
 */
import {
  TimelineDisplay,
  type TimelineDisplayChapterView,
  type TimelineStreamingChapterDraftLike,
  mapDraftChaptersToDisplay,
} from './TimelineDisplay';
import { useUiText } from '@extension/ui/locale-context';

export type TimelineStreamingChapterDraft = TimelineStreamingChapterDraftLike;

export interface TimelineStreamingPreviewProps {
  readonly isStreaming: boolean;
  /** 阶段状态文本（来自 controller 推的 VIDEO_TIMELINE_STATUS）。 */
  readonly status: string;
  /** 已收到的原始 LLM 字符数（仅用于摘要显示 "已接收 N 字"，与渲染内容解耦）。 */
  readonly characterCount: number;
  /** overview 草稿（最后一次接收到的 overview partial 事件）。 */
  readonly overviewDraft: string | null;
  /** chapter 草稿（按到达顺序累积，按 chapterId 去重 / 更新）。 */
  readonly chaptersDraft: readonly TimelineStreamingChapterDraft[];
  /** 已接收到的 chapter 数（summary 里"已识别 N 章"用）。 */
  readonly chapterCount: number;
  /** 原始 JSONL 行，仅用于高级调试折叠项。 */
  readonly rawLinesForDebug?: readonly string[];
  /** 刷新已有时间线时提示新结果会替换当前结果。 */
  readonly replacing?: boolean;
  /** 用户主动停止当前导航生成。 */
  readonly onCancel?: () => void;
}

export function TimelineStreamingPreview(
  props: TimelineStreamingPreviewProps,
): JSX.Element | null {
  const t = useUiText();
  if (!props.isStreaming) return null;
  const displayStatus = localizeTimelineStatus(props.status, t);
  const charText =
    props.characterCount > 0
      ? t(` · 已接收 ${props.characterCount} 字`, ` · received ${props.characterCount} chars`)
      : '';
  const chapterText =
    props.chapterCount > 0
      ? t(` · 已识别 ${props.chapterCount} 章`, ` · identified ${props.chapterCount} chapters`)
      : '';
  return (
    <section
      className="space-y-3"
      data-testid="timeline-streaming-preview"
    >
      {props.replacing ? (
        <p
          className="rounded-md border border-dashed border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
          data-testid="timeline-streaming-replacing"
        >
          {t('新结果将替换当前结果', 'The new result will replace the current one')}
        </p>
      ) : null}
      <header className="border-b border-dashed border-border/60 pb-2" data-testid="timeline-streaming-status">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            {t('正在生成导航', 'Generating navigation')}{chapterText}
            {charText}
          </p>
          {props.onCancel ? (
            <button
              type="button"
              aria-label={t('停止生成导航', 'Stop generating navigation')}
              className="shrink-0 rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              onClick={props.onCancel}
            >
              {t('停止', 'Stop')}
              <span className="sr-only">{t('生成导航', 'generating navigation')}</span>
            </button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{displayStatus}</p>
      </header>

      {/* 共享结构：mode=streaming 会弱化点击交互。 */}
      <TimelineDisplay
        mode="streaming"
        overview={props.overviewDraft}
        showOverview={Boolean(props.overviewDraft)}
        chapters={mapDraftChaptersToDisplay(props.chaptersDraft)}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        placeholderSegmentCount={0}
      />

      {props.rawLinesForDebug && props.rawLinesForDebug.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {t(
              `调试输出（${props.rawLinesForDebug.length} 行）`,
              `Debug output (${props.rawLinesForDebug.length} lines)`,
            )}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-muted-foreground">
            {props.rawLinesForDebug.join('\n')}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

export type { TimelineDisplayChapterView };

function localizeTimelineStatus(
  status: string,
  t: (zh: string, en: string) => string,
): string {
  const normalized = status.replaceAll('时间线', '导航');
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['正在读取当前页面', 'Reading current page'],
    ['正在加载设置', 'Loading settings'],
    ['正在查询缓存', 'Checking cache'],
    ['已复用内容底座字幕', 'Reused prepared subtitles'],
    ['正在读取字幕', 'Reading subtitles'],
    ['正在识别导航', 'Generating navigation'],
    ['流式结果不可用，已切换为普通生成', 'Streaming output unavailable. Switched to normal generation'],
  ];
  for (const [zh, en] of pairs) {
    if (normalized.includes(zh)) {
      return normalized.replace(zh, t(zh, en));
    }
  }
  return normalized;
}
