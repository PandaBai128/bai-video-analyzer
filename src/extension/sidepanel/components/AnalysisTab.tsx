import { useEffect, useState, type Ref, type UIEventHandler } from 'react';
import type { LearningSession, VideoAnalysis } from '@core/types';
import { alignLearningGuideWithTimeline } from '@core/learning/align-learning-guide-timeline';
import { cn } from '@lib/utils';
import { useUiText } from '@extension/ui/locale-context';
import { ContentOverview } from './ContentOverview';

export interface AnalysisTabProps {
  readonly session: LearningSession | null;
  readonly analysis?: VideoAnalysis | null;
  readonly hasContentContext: boolean;
  readonly isPreparing: boolean;
  readonly isMutating: boolean;
  readonly isGeneratingGuide: boolean;
  readonly generationStatus?: string;
  readonly generationStartedAt?: number | null;
  readonly scrollContainerRef?: Ref<HTMLDivElement>;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
  readonly onStartAnalysis: (forceRefresh?: boolean) => Promise<void>;
  readonly onCancelGenerateGuide?: () => void;
  readonly onSeek?: ((timestamp: number) => void) | undefined;
  readonly duration?: number | undefined;
}

export function AnalysisTab(props: AnalysisTabProps): JSX.Element {
  const t = useUiText();
  const guide = props.session?.guide ?? null;
  const decision = guide
    ? alignLearningGuideWithTimeline(guide, props.analysis ?? null).decision
    : null;

  const generateGuideWithMode = async (): Promise<void> => {
    await props.onStartAnalysis(Boolean(guide));
  };

  if (!props.hasContentContext) {
    return (
      <div
        ref={props.scrollContainerRef}
        className="h-full min-h-0 space-y-3 overflow-y-auto pt-3"
        data-scroll-tab="analysis"
        data-testid="analysis-no-context"
        onScroll={props.onScroll}
      >
        <QuickStartGuide
          actionLabel={
            props.isPreparing
              ? t('正在读取字幕...', 'Reading subtitles...')
              : t('生成内容速览', 'Create Overview')
          }
          actionDisabled={props.isPreparing}
          onAction={() => void generateGuideWithMode()}
        />
      </div>
    );
  }

  if (!guide || !decision) {
    return (
      <div
        ref={props.scrollContainerRef}
        className="h-full min-h-0 space-y-3 overflow-y-auto pt-3"
        data-scroll-tab="analysis"
        data-testid="analysis-tab"
        onScroll={props.onScroll}
      >
        <QuickStartGuide
          actionLabel={
            props.isGeneratingGuide
              ? t('生成中...', 'Creating...')
              : t('生成内容速览', 'Create Overview')
          }
          actionDisabled={props.isGeneratingGuide || props.isMutating}
          collapsed={props.isGeneratingGuide}
          onAction={() => void generateGuideWithMode()}
        />
        {props.isGeneratingGuide ? (
          <AnalysisGenerationProgress
            status={props.generationStatus}
            startedAt={props.generationStartedAt}
            replacing={false}
            onCancel={props.onCancelGenerateGuide}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={props.scrollContainerRef}
      className="h-full min-h-0 space-y-3 overflow-y-auto pt-3"
      data-scroll-tab="analysis"
      data-testid="analysis-tab"
      onScroll={props.onScroll}
    >
      {props.isGeneratingGuide ? (
        <AnalysisGenerationProgress
          status={props.generationStatus}
          startedAt={props.generationStartedAt}
          replacing={Boolean(guide)}
          onCancel={props.onCancelGenerateGuide}
        />
      ) : null}
      <ContentOverview
        decision={decision}
        contentType={guide.contentType}
        duration={props.duration}
        isGenerating={props.isGeneratingGuide}
        onSeek={props.onSeek}
        onRegenerate={() => void props.onStartAnalysis(true)}
      />
    </div>
  );
}

export function QuickStartGuide(props: {
  readonly actionLabel?: string;
  readonly actionDisabled?: boolean;
  readonly collapsed?: boolean;
  readonly compact?: boolean;
  readonly onAction?: () => void;
}): JSX.Element {
  const t = useUiText();
  const items = [
    {
      icon: '✦',
      title: t('速览', 'Overview'),
      description: t('看懂内容与观点', 'Understand the content and ideas'),
    },
    {
      icon: '◷',
      title: t('导航', 'Navigation'),
      description: t('按时间找到想看的片段', 'Find the moment you want'),
    },
    {
      icon: '?',
      title: t('提问', 'Ask'),
      description: t('有疑问，接着聊', 'Ask about anything in the video'),
    },
    { icon: '✎', title: t('笔记', 'Notes'), description: t('留下有用的内容', 'Keep what matters') },
  ];

  return (
    <section
      className={cn(
        'bai-content-card overflow-hidden border border-border bg-card',
        props.collapsed ? 'p-3' : 'p-4',
      )}
      data-testid="quick-start-guide"
      data-collapsed={props.collapsed ? 'true' : 'false'}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg text-primary"
        >
          ✦
        </span>
        <h2
          className={cn(
            'font-semibold leading-snug',
            props.collapsed ? 'text-sm' : props.compact ? 'text-base' : 'text-lg',
          )}
        >
          {props.collapsed
            ? t('正在生成内容速览', 'Creating your overview')
            : t('快速看懂这期视频', 'Get to know this video')}
        </h2>
      </div>
      {!props.collapsed ? (
        <>
          <div className="my-4 divide-y divide-border/60">
            {items.map((item) => (
              <div key={item.title} className="flex items-start gap-2.5 py-2.5">
                <span
                  aria-hidden="true"
                  className="w-5 shrink-0 text-center text-sm font-semibold leading-5 text-primary"
                >
                  {item.icon}
                </span>
                <p className="shrink-0 text-sm font-medium leading-5">{item.title}</p>
                <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
          {props.actionLabel && props.onAction ? (
            <button
              type="button"
              disabled={props.actionDisabled}
              className="bai-action-button w-full bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
              onClick={props.onAction}
            >
              {props.actionLabel}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function AnalysisGenerationProgress(props: {
  readonly status: string | undefined;
  readonly startedAt: number | null | undefined;
  readonly replacing: boolean;
  readonly onCancel?: (() => void) | undefined;
}): JSX.Element {
  const t = useUiText();
  const elapsedSeconds = useElapsedSeconds(props.startedAt);
  const flowLines = getGenerationFlowLines(elapsedSeconds, t);
  return (
    <div
      className="bai-content-card border border-primary/35 bg-primary/5 p-3 text-xs leading-5"
      data-testid="analysis-generation-progress"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-foreground">
          {t('正在生成视频分析', 'Generating video analysis')}
        </p>
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 font-medium tabular-nums text-muted-foreground">
          {elapsedSeconds}s
        </span>
      </div>
      {props.status ? (
        <p className="mt-2 rounded bg-background/80 px-2 py-1 text-muted-foreground break-words">
          {props.status}
        </p>
      ) : null}
      <div className="mt-2 grid gap-1.5" data-testid="analysis-generation-flow">
        {flowLines.map((line, index) => (
          <div
            key={line}
            className={cn(
              'rounded border px-2 py-1 transition-colors',
              index === flowLines.length - 1
                ? 'border-primary/35 bg-primary/10 text-foreground'
                : 'border-border bg-background/70 text-muted-foreground',
            )}
          >
            {line}
          </div>
        ))}
      </div>
      {props.replacing ? (
        <p className="mt-2 text-muted-foreground">
          {t(
            '新结果生成完成后会替换当前分析。',
            'The new result will replace the current analysis when it is ready.',
          )}
        </p>
      ) : null}
      {props.onCancel ? (
        <button
          type="button"
          className="mt-2 w-full rounded border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          onClick={props.onCancel}
        >
          {t('停止生成', 'Stop')}
        </button>
      ) : null}
    </div>
  );
}

function getGenerationFlowLines(
  elapsedSeconds: number,
  t: (zh: string, en: string) => string,
): readonly string[] {
  const lines = [
    t('读取字幕和视频标题，建立内容底座', 'Read subtitles and title to build content context'),
    t('提炼视频主线、结论和核心观点', 'Extract the main thread, conclusions, and core viewpoints'),
    t('整理具体观点与关键片段', 'Organize ideas and key moments'),
    t('核对时间点并标注信息边界', 'Check timestamps and information boundaries'),
  ];
  const visibleCount = Math.min(lines.length, Math.max(1, Math.floor(elapsedSeconds / 2) + 1));
  return lines.slice(0, visibleCount);
}

function useElapsedSeconds(startedAt: number | null | undefined): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => getElapsedSeconds(startedAt));

  useEffect(() => {
    setElapsedSeconds(getElapsedSeconds(startedAt));
    if (!startedAt) return undefined;
    const timer = globalThis.setInterval(() => {
      setElapsedSeconds(getElapsedSeconds(startedAt));
    }, 1000);
    return () => globalThis.clearInterval(timer);
  }, [startedAt]);

  return elapsedSeconds;
}

function getElapsedSeconds(startedAt: number | null | undefined): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}
