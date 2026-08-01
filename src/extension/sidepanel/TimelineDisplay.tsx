/** 时间线共享展示组件。最终态和流式预览共用同一套结构，避免完成时样式跳变。 */
import { useEffect, useState } from 'react';
import { cn } from '@lib/utils';
import type { TimelineNode, VideoChapter } from '@core/types';
import { useUiText } from '@extension/ui/locale-context';
import {
  getTimelineChapterPriorityTag,
  getTimelineContentTag,
  getTimelineSegmentPriorityTag,
} from './timeline-labels';

/** `streaming` 弱化交互；`final` 支持跳转、展开和播放进度高亮。 */
export type TimelineDisplayMode = 'streaming' | 'final';

/** 通用时间线视图数据，最终结果和流式草稿都先映射到这个结构再渲染。 */
export interface TimelineDisplayChapterView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly startCueId?: number;
  readonly endCueId?: number;
  /** 时间戳（秒）；流式草稿可能没有。 */
  readonly timestamp?: number;
  readonly endTimestamp?: number;
  readonly importance?: VideoChapter['importance'];
  readonly contentTag?: VideoChapter['contentTag'];
  readonly watchGuide?: string;
  readonly reflectionPrompt?: string;
  readonly segments: readonly TimelineDisplaySegmentView[];
}

export interface TimelineDisplaySegmentView {
  readonly id?: string;
  readonly title: string;
  readonly summary: string;
  readonly startCueId?: number;
  readonly endCueId?: number;
  readonly timestamp?: number;
  readonly endTimestamp?: number;
  readonly importance?: TimelineNode['importance'];
  readonly contentTag?: TimelineNode['contentTag'];
  readonly reasoning?: string;
  readonly watchPrompt?: string;
}

export interface TimelineDisplayProps {
  readonly mode: TimelineDisplayMode;
  readonly overview: string | null;
  readonly showOverview?: boolean;
  readonly chapters: readonly TimelineDisplayChapterView[];
  /** 时间戳精度：字幕模式是精确时间，旧缓存可能是模型估计时间。 */
  readonly timeAccuracy?: 'exact' | 'estimated';
  /** 当前播放章节索引；仅最终态生效，缺省不高亮。 */
  readonly activeChapterIndex?: number;
  /** 展开章节索引；仅最终态生效。 */
  readonly expandedChapterIndex?: number;
  /** 当前小节索引；仅最终态生效，缺省不高亮。 */
  readonly activeSegmentIndex?: number;
  /** 章节点击回调；主区域只负责跳转，不负责展开。 */
  readonly onSeekChapter?: (
    chapter: TimelineDisplayChapterView,
    index: number,
  ) => void;
  /** 章节展开 / 折叠回调（最终态）。 */
  readonly onToggleChapter?: (index: number) => void;
  /** 小节点击回调（最终态跳转视频时间点）。 */
  readonly onSeekSegment?: (
    segment: TimelineDisplaySegmentView,
    chapterIndex: number,
    segmentIndex: number,
  ) => void;
  /** 流式态下未到达的小节占位数量。 */
  readonly placeholderSegmentCount?: number;
}

export function mapVideoChaptersToDisplay(
  chapters: readonly VideoChapter[],
): TimelineDisplayChapterView[] {
  return chapters.map((chapter, idx) => {
    const view: TimelineDisplayChapterView = {
      id: `${chapter.timestamp}-${chapter.title}-${idx}`,
      title: chapter.title,
      summary: chapter.summary,
      timestamp: chapter.timestamp,
      importance: chapter.importance,
      ...(chapter.contentTag !== undefined ? { contentTag: chapter.contentTag } : {}),
      watchGuide: chapter.watchGuide,
      ...(chapter.reflectionPrompt !== undefined
        ? { reflectionPrompt: chapter.reflectionPrompt }
        : {}),
      ...(chapter.endTimestamp !== undefined
        ? { endTimestamp: chapter.endTimestamp }
        : {}),
      segments: chapter.segments.map((seg, segIdx) => {
        const segView: TimelineDisplaySegmentView = {
          id: `${chapter.timestamp}-${seg.timestamp}-${segIdx}`,
          title: seg.title,
          summary: seg.summary,
          timestamp: seg.timestamp,
          importance: seg.importance,
          ...(seg.contentTag !== undefined ? { contentTag: seg.contentTag } : {}),
          ...(seg.reasoning !== undefined ? { reasoning: seg.reasoning } : {}),
          ...(seg.watchPrompt !== undefined ? { watchPrompt: seg.watchPrompt } : {}),
          ...(seg.endTimestamp !== undefined
            ? { endTimestamp: seg.endTimestamp }
            : {}),
        };
        return segView;
      }),
    };
    return view;
  });
}

export interface TimelineStreamingChapterDraftLike {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly importance?: VideoChapter['importance'];
  readonly contentTag?: VideoChapter['contentTag'];
  readonly segments: readonly {
    readonly title: string;
    readonly summary: string;
    readonly importance?: TimelineNode['importance'];
    readonly contentTag?: TimelineNode['contentTag'];
  }[];
}

export function mapDraftChaptersToDisplay(
  drafts: readonly TimelineStreamingChapterDraftLike[],
): TimelineDisplayChapterView[] {
  return drafts.map((draft) => ({
    id: draft.id,
    title: draft.title,
    summary: draft.summary,
    ...(draft.importance !== undefined ? { importance: draft.importance } : {}),
    ...(draft.contentTag !== undefined ? { contentTag: draft.contentTag } : {}),
    segments: draft.segments.map((seg, idx) => ({
      id: `${draft.id}-seg-${idx}`,
      title: seg.title,
      summary: seg.summary,
      ...(seg.importance !== undefined ? { importance: seg.importance } : {}),
      ...(seg.contentTag !== undefined ? { contentTag: seg.contentTag } : {}),
    })),
  }));
}

export function TimelineDisplay(props: TimelineDisplayProps): JSX.Element {
  const t = useUiText();
  const {
    mode,
    overview,
    showOverview = true,
    chapters,
    activeChapterIndex = -1,
    expandedChapterIndex = -1,
    activeSegmentIndex = -1,
    timeAccuracy = 'exact',
    onSeekChapter,
    onToggleChapter,
    onSeekSegment,
    placeholderSegmentCount = 0,
  } = props;

  const isStreaming = mode === 'streaming';
  const isEstimatedTime = timeAccuracy === 'estimated';

  return (
    <div
      className="space-y-2"
      data-testid="timeline-display"
      data-mode={mode}
    >
      {showOverview ? (
        <TimelineOverviewBlock
          overview={overview}
          mode={mode}
          isComplete={!isStreaming || overview !== null}
        />
      ) : null}

      {/* 章节列表 */}
      {chapters.length > 0 ? (
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold" data-testid="timeline-header-title">
            {t('导航', 'Navigation')}
          </h2>
          {isEstimatedTime ? <TimelineEstimatedTimeNotice /> : null}
          {chapters.map((chapter, idx) => (
            <TimelineChapterBlock
              key={chapter.id}
              chapter={chapter}
              chapterNumber={idx + 1}
              totalChapters={chapters.length}
              mode={mode}
              isActive={!isStreaming && idx === activeChapterIndex}
              isExpanded={!isStreaming && idx === expandedChapterIndex}
              activeSegmentIndex={!isStreaming ? activeSegmentIndex : -1}
              timeAccuracy={timeAccuracy}
              onSeekChapter={
                onSeekChapter ? () => onSeekChapter(chapter, idx) : undefined
              }
              onToggleChapter={
                onToggleChapter ? () => onToggleChapter(idx) : undefined
              }
              onSeekSegment={
                onSeekSegment
                  ? (segment, segIdx) => onSeekSegment(segment, idx, segIdx)
                  : undefined
              }
              placeholderSegmentCount={
                isStreaming && idx === chapters.length - 1
                  ? placeholderSegmentCount
                  : 0
              }
            />
          ))}
        </div>
      ) : (
        <div
          className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground"
          data-testid="timeline-empty-state"
        >
          {isStreaming ? t('正在识别章节…', 'Identifying chapters...') : t('暂无章节', 'No chapters yet')}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// 视频核心块（overview）
// -----------------------------------------------------------------------------

export interface TimelineOverviewBlockProps {
  readonly overview: string | null;
  readonly mode: TimelineDisplayMode;
  /** 流式态是否已经收到 overview。 */
  readonly isComplete: boolean;
}

/** 视频核心块。流式态和最终态共用同一结构，避免完成时视觉跳变。 */
export function TimelineOverviewBlock(
  props: TimelineOverviewBlockProps,
): JSX.Element {
  const t = useUiText();
  const isStreaming = props.mode === 'streaming';
  const placeholderText = isStreaming
    ? props.isComplete
      ? t('（无内容）', '(No content)')
      : t('正在生成视频核心…', 'Generating video core...')
    : t('（无内容）', '(No content)');
  return (
    <section
      className="rounded-md border-l-2 border-l-primary/60 bg-muted/40 px-2.5 py-2 text-sm"
      data-testid="timeline-overview-block"
      data-streaming={isStreaming ? 'true' : 'false'}
    >
      <p className="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('视频核心', 'Video Core')}
      </p>
      <p className="leading-5">{props.overview ?? placeholderText}</p>
    </section>
  );
}

function TimelineEstimatedTimeNotice(): JSX.Element {
  const t = useUiText();
  return (
    <p
      className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-900"
      data-testid="timeline-estimated-time-notice"
    >
      {t(
        '当前时间点来自旧缓存的模型估计，只适合按段理解；需要秒级跳转时请以字幕导航为准。',
        'These timestamps come from an older model-estimated cache and are best for segment-level understanding. Regenerate subtitle navigation for precise jumps.',
      )}
    </p>
  );
}

// -----------------------------------------------------------------------------
// 章节块（chapter）
// -----------------------------------------------------------------------------

export interface TimelineChapterBlockProps {
  readonly chapter: TimelineDisplayChapterView;
  /** 1-based 章节编号（"01 / 02"格式化用）。 */
  readonly chapterNumber: number;
  /** 总章节数（用于格式化宽度）。 */
  readonly totalChapters: number;
  readonly mode: TimelineDisplayMode;
  readonly isActive: boolean;
  readonly isExpanded: boolean;
  readonly activeSegmentIndex: number;
  readonly timeAccuracy?: 'exact' | 'estimated';
  /** 章节主 seek 回调（最终态跳转视频时间点）—— 不带 source 参数。 */
  readonly onSeekChapter: (() => void) | undefined;
  readonly onToggleChapter: (() => void) | undefined;
  readonly onSeekSegment:
    | ((
        segment: TimelineDisplaySegmentView,
        segmentIndex: number,
      ) => void)
    | undefined;
  /** 流式态下未到达的小节占位数。 */
  readonly placeholderSegmentCount: number;
}

/**
 * 章节块。
 * 主区域是一个完整跳转按钮；展开按钮作为右上角兄弟节点存在，避免嵌套按钮、
 * 双层 hover 和“点击跳转时顺带展开”的副作用。
 */
export function TimelineChapterBlock(
  props: TimelineChapterBlockProps,
): JSX.Element {
  const t = useUiText();
  const isStreaming = props.mode === 'streaming';
  const chapterNumber = formatChapterNumber(props.chapterNumber);
  const timeAccuracy = props.timeAccuracy ?? 'exact';
  const timeBadge =
    props.chapter.timestamp !== undefined
      ? formatTimeRange(
          props.chapter.timestamp,
          props.chapter.endTimestamp,
          timeAccuracy,
          t,
        )
      : '—';
  const contentTag = getTimelineContentTag(props.chapter, t);
  const priorityTag = getTimelineChapterPriorityTag(props.chapter, t);
  const expandedContentOpen = !isStreaming && props.isExpanded;
  const expandedPresence = useAnimatedPresence(expandedContentOpen);

  return (
    <section
      className={cn(
        'bai-timeline-chapter rounded-md border border-border transition-[background,box-shadow,border-color] duration-200',
        isStreaming
          ? 'border-l-2 border-l-muted-foreground/40 bg-muted/20'
          : 'border-l-2 border-l-primary/60 bg-card',
        !isStreaming && props.isActive && 'bai-timeline-chapter-active',
      )}
      data-testid="timeline-chapter-block"
      data-chapter-index={props.chapterNumber - 1}
      data-streaming={isStreaming ? 'true' : 'false'}
      data-active={!isStreaming && props.isActive ? 'true' : 'false'}
    >
      <div className="relative px-2.5 py-2">
        <button
          type="button"
          data-testid="timeline-chapter-seek"
          aria-label={t(`跳转到章节：${props.chapter.title}`, `Jump to chapter: ${props.chapter.title}`)}
          className={cn(
            'block w-full rounded text-left',
            'bai-timeline-chapter-seek',
            isStreaming || !props.onSeekChapter
              ? 'cursor-default'
              : 'cursor-pointer hover:bg-accent/30',
          )}
          disabled={isStreaming || !props.onSeekChapter}
          onClick={
            isStreaming || !props.onSeekChapter
              ? undefined
              : props.onSeekChapter
          }
        >
          {/* 只有 meta 行给右上角展开按钮让位；标题和摘要保持完整宽度。 */}
          <span
            className="block pr-12 font-mono text-[11px] text-muted-foreground"
            data-testid="timeline-chapter-meta-row"
          >
            <span
              className="font-semibold"
              data-testid="timeline-chapter-number"
              aria-hidden="true"
            >
              {chapterNumber}
            </span>
            <span aria-hidden="true">  </span>
            <span data-testid="timeline-chapter-time">{timeBadge}</span>
            {contentTag ? (
              <span
                className={cn('ml-1.5 inline-flex whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10px]', contentTag.className)}
                data-testid="timeline-content-tag"
              >
                {contentTag.label}
              </span>
            ) : null}
            {priorityTag ? (
              <span
                className={cn('ml-1.5 inline-flex whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10px]', priorityTag.className)}
                data-testid="timeline-value-tag"
              >
                {priorityTag.label}
              </span>
            ) : null}
          </span>
          <span
            className="mt-1 block text-[13px] font-semibold leading-4"
            data-testid="timeline-chapter-title-row"
          >
            {props.chapter.title}
          </span>
          {props.chapter.summary ? (
            <span
              className={cn(
                'mt-0.5 block text-xs leading-4 text-muted-foreground',
                !expandedContentOpen &&
                  'overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]',
              )}
              data-testid="timeline-chapter-summary-row"
            >
              {props.chapter.summary}
            </span>
          ) : null}
        </button>

        {/* 展开 / 收起按钮不能嵌在主跳转按钮里。 */}
        {!isStreaming && props.onToggleChapter ? (
          <button
            type="button"
            data-testid="timeline-chapter-toggle"
            className="absolute right-2 top-2 shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground hover:bg-accent"
            onClick={(event) => {
              // 阻止冒泡到主 button（避免同时触发章节 seek）
              event.stopPropagation();
              props.onToggleChapter?.();
            }}
            aria-expanded={props.isExpanded}
          >
            {props.isExpanded ? t('收起', 'Collapse') : t('展开', 'Expand')}
          </button>
        ) : null}
      </div>

      {/* 展开后的小节列表只在最终态显示。 */}
      {expandedPresence.shouldRender ? (
        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows,opacity,transform] duration-300 ease-out',
            expandedPresence.isVisible
              ? 'grid-rows-[1fr] translate-y-0 opacity-100'
              : 'grid-rows-[0fr] -translate-y-1 opacity-0',
          )}
          data-testid="timeline-chapter-expanded-region"
          data-open={expandedPresence.isVisible ? 'true' : 'false'}
        >
          <div className="min-h-0 overflow-hidden">
            <TimelineChapterDecision chapter={props.chapter} />
            <TimelineSegmentList
              segments={props.chapter.segments}
              chapterNumber={props.chapterNumber}
              activeSegmentIndex={props.activeSegmentIndex}
              timeAccuracy={timeAccuracy}
              onSeekSegment={props.onSeekSegment}
            />
          </div>
        </div>
      ) : null}

      {/* 流式态：未到达的小节占位。 */}
      {isStreaming && props.placeholderSegmentCount > 0 ? (
        <div
          className="space-y-1 border-t border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground"
          data-testid="timeline-segment-placeholder"
        >
          {Array.from({ length: props.placeholderSegmentCount }).map((_, i) => (
            <div
              key={`placeholder-${i}`}
              className="rounded-md border border-dashed border-border/60 bg-muted/20 px-2 py-1 text-[11px]"
            >
              <span>{t('继续生成中…', 'Still generating...')}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function useAnimatedPresence(open: boolean): {
  readonly shouldRender: boolean;
  readonly isVisible: boolean;
} {
  const [shouldRender, setShouldRender] = useState(open);
  const [isVisible, setIsVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsVisible(false);
      return scheduleAfterPaint(() => setIsVisible(true));
    }
    setIsVisible(false);
    const timer = globalThis.setTimeout(() => setShouldRender(false), 280);
    return () => globalThis.clearTimeout(timer);
  }, [open]);

  return { shouldRender, isVisible };
}

function scheduleAfterPaint(callback: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    const timer = globalThis.setTimeout(callback, 32);
    return () => globalThis.clearTimeout(timer);
  }

  let secondFrame: number | undefined;
  const firstFrame = globalThis.requestAnimationFrame(() => {
    secondFrame = globalThis.requestAnimationFrame(callback);
  });

  return () => {
    globalThis.cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) {
      globalThis.cancelAnimationFrame(secondFrame);
    }
  };
}

// -----------------------------------------------------------------------------
// 小节列表（segments）
// -----------------------------------------------------------------------------

export interface TimelineSegmentListProps {
  readonly segments: readonly TimelineDisplaySegmentView[];
  readonly chapterNumber: number;
  readonly activeSegmentIndex: number;
  readonly timeAccuracy?: 'exact' | 'estimated';
  readonly onSeekSegment:
    | ((
        segment: TimelineDisplaySegmentView,
        segmentIndex: number,
      ) => void)
    | undefined;
}

/** 小节列表：编号时间、标题、摘要分三行，适配窄侧边栏阅读。 */
export function TimelineSegmentList(
  props: TimelineSegmentListProps,
): JSX.Element {
  return (
    <ol
      className="space-y-0.5 border-t border-border bg-muted/20 px-1.5 pb-1.5 pt-1"
      data-testid="timeline-segment-list"
    >
      {props.segments.map((segment, segIdx) => (
        <TimelineSegmentItem
          key={segment.id ?? `${props.chapterNumber}-${segIdx}`}
          segment={segment}
          segmentIndex={segIdx}
          segmentNumber={`${props.chapterNumber}.${segIdx + 1}`}
          isActive={segIdx === props.activeSegmentIndex}
          {...(props.timeAccuracy ? { timeAccuracy: props.timeAccuracy } : {})}
          onSeekSegment={
            props.onSeekSegment
              ? () => props.onSeekSegment!(segment, segIdx)
              : undefined
          }
        />
      ))}
    </ol>
  );
}

function TimelineSegmentItem(props: {
  readonly segment: TimelineDisplaySegmentView;
  readonly segmentIndex: number;
  readonly segmentNumber: string;
  readonly isActive: boolean;
  readonly timeAccuracy?: 'exact' | 'estimated';
  readonly onSeekSegment: (() => void) | undefined;
}): JSX.Element {
  const t = useUiText();
  const contentTag = getTimelineContentTag(props.segment, t);
  const priorityTag = getTimelineSegmentPriorityTag(props.segment, t);
  const hasDecision = Boolean(props.segment.reasoning || props.segment.watchPrompt);
  const defaultExpanded = hasDecision && (props.isActive || priorityTag?.kind === 'must_watch');
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const isExpanded = hasDecision && (userExpanded ?? defaultExpanded);
  const expandedPresence = useAnimatedPresence(isExpanded);
  const timeBadge =
    props.segment.timestamp !== undefined
      ? formatTimeRange(
          props.segment.timestamp,
          props.segment.endTimestamp,
          props.timeAccuracy,
          t,
        )
      : '—';

  return (
    <li
      className={cn(
        'bai-timeline-segment relative rounded-md border-l-2 pl-1.5 transition-[background,box-shadow,border-color] duration-200',
        props.isActive
          ? 'bai-timeline-segment-active border-l-primary'
          : 'border-l-border/60',
      )}
      data-testid="timeline-segment-item"
      data-segment-index={props.segmentIndex}
      data-active={props.isActive ? 'true' : 'false'}
    >
      <button
        type="button"
        className={cn(
          'bai-timeline-segment-seek block w-full rounded-md px-1 py-0.5 text-left hover:bg-background',
          hasDecision ? 'pr-12' : 'pr-1',
        )}
        onClick={props.onSeekSegment}
        disabled={!props.onSeekSegment}
        data-testid="timeline-segment-seek"
      >
        <p
          className="font-mono text-[11px] text-muted-foreground"
          data-testid="timeline-segment-meta"
        >
          <span data-testid="timeline-segment-number">{props.segmentNumber}</span>
          <span aria-hidden="true"> · </span>
          <span data-testid="timeline-segment-time">{timeBadge}</span>
        </p>
        <p className="text-[13px] font-medium leading-4">
          {props.segment.title}
          {contentTag ? (
            <span
              className={cn('ml-1.5 inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]', contentTag.className)}
              data-testid="timeline-segment-content-tag"
            >
              {contentTag.label}
            </span>
          ) : null}
          {priorityTag ? (
            <span
              className={cn('ml-1.5 inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]', priorityTag.className)}
              data-testid="timeline-segment-value-tag"
            >
              {priorityTag.label}
            </span>
          ) : null}
        </p>
        {props.segment.summary ? (
          <p className="overflow-hidden text-[11px] leading-4 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
            {props.segment.summary}
          </p>
        ) : null}
      </button>

      {hasDecision ? (
        <button
          type="button"
          data-testid="timeline-segment-toggle"
          className="absolute right-1 top-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-semibold text-muted-foreground hover:bg-accent"
          onClick={(event) => {
            event.stopPropagation();
            setUserExpanded((current) => !(current ?? defaultExpanded));
          }}
          aria-expanded={isExpanded}
        >
          {isExpanded ? t('收起', 'Collapse') : t('展开', 'Expand')}
        </button>
      ) : null}

      {expandedPresence.shouldRender ? (
        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows,opacity,transform] duration-300 ease-out',
            expandedPresence.isVisible
              ? 'grid-rows-[1fr] translate-y-0 opacity-100'
              : 'grid-rows-[0fr] -translate-y-1 opacity-0',
          )}
          data-testid="timeline-segment-expanded-region"
          data-open={expandedPresence.isVisible ? 'true' : 'false'}
        >
          <div className="min-h-0 overflow-hidden">
            <TimelineSegmentDecision segment={props.segment} />
          </div>
        </div>
      ) : null}
    </li>
  );
}

function TimelineChapterDecision(props: {
  readonly chapter: TimelineDisplayChapterView;
}): JSX.Element | null {
  const t = useUiText();
  const watchGuide = normalizeChapterDecisionText(props.chapter.watchGuide);
  const reflectionPrompt = normalizeChapterDecisionText(props.chapter.reflectionPrompt);
  if (!watchGuide && !reflectionPrompt) {
    return null;
  }
  return (
    <div
      className="space-y-1 border-t border-border bg-muted/10 px-3 py-2 text-xs leading-5"
      data-testid="timeline-chapter-decision"
    >
      {watchGuide ? (
        <p>
          <span className="font-semibold text-foreground">{t('怎么看：', 'How to watch: ')}</span>
          <span className="text-muted-foreground">{watchGuide}</span>
        </p>
      ) : null}
      {reflectionPrompt ? (
        <p>
          <span className="font-semibold text-foreground">{t('思考：', 'Think: ')}</span>
          <span className="text-muted-foreground">{reflectionPrompt}</span>
        </p>
      ) : null}
    </div>
  );
}

function TimelineSegmentDecision(props: {
  readonly segment: TimelineDisplaySegmentView;
}): JSX.Element | null {
  const t = useUiText();
  if (!props.segment.reasoning && !props.segment.watchPrompt) {
    return null;
  }
  return (
    <div
      className="ml-2 space-y-1 px-1 pb-1 text-xs leading-5"
      data-testid="timeline-segment-decision"
    >
      {props.segment.reasoning ? (
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">{t('原因：', 'Reason: ')}</span>
          {props.segment.reasoning}
        </p>
      ) : null}
      {props.segment.watchPrompt ? (
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">{t('操作：', 'Action: ')}</span>
          {props.segment.watchPrompt}
        </p>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// 工具函数
// -----------------------------------------------------------------------------

/**
 * 把 1-based 章节编号格式化为 "01 / 02 / 03"（位数自动适配总章节数）。
 */
function formatChapterNumber(n: number): string {
  if (n < 1) return String(n);
  // 1-9 → "01"，10-99 → 直接显示
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 内部 helper：把秒数格式化为 "mm:ss" 或 "mm:ss-mm:ss"。
 */
function formatTimeRange(
  start: number,
  end: number | undefined,
  accuracy: 'exact' | 'estimated' = 'exact',
  t: (zh: string, en: string) => string,
): string {
  const startText = formatSeconds(start);
  const prefix = accuracy === 'estimated' ? t('约 ', 'approx. ') : '';
  if (typeof end === 'number' && end > start) {
    return `${prefix}${startText}-${formatSeconds(end)}`;
  }
  return `${prefix}${startText}`;
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function normalizeChapterDecisionText(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const genericTexts = new Set([
    '重点看这一章，先理解主线再看细节。',
    '建议看这一章，关注它和前后内容的关系。',
    '可以按需看，重点抓对自己有用的部分。',
    '可以快速浏览，除非你对这个话题特别关心。',
    '先按这一组理解主线，再展开细分节点看细节。',
  ]);
  if (genericTexts.has(text)) return undefined;
  return text;
}
