import { useEffect, useState, type Ref, type UIEventHandler } from 'react';
import type { LearningGuideDecision, LearningSession } from '@core/types';
import { cn } from '@lib/utils';
import { useUiText } from '@extension/ui/locale-context';

export interface AnalysisTabProps {
  readonly session: LearningSession | null;
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
}

export function AnalysisTab(props: AnalysisTabProps): JSX.Element {
  const t = useUiText();
  const guide = props.session?.guide ?? null;
  const decision = guide?.decision ?? null;

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
          actionLabel={props.isPreparing ? t('正在读取字幕...', 'Reading subtitles...') : t('开始快速分析', 'Start Fast Analysis')}
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
          actionLabel={props.isGeneratingGuide ? t('分析中...', 'Analyzing...') : t('开始快速分析', 'Start Fast Analysis')}
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
      <section className="bai-content-card space-y-3 border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">{t('分析结果', 'Analysis Result')}</p>
          {props.isGeneratingGuide ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {t('生成中', 'Generating')}
            </span>
          ) : null}
        </div>

        {props.isGeneratingGuide ? (
          <AnalysisGenerationProgress
            status={props.generationStatus}
            startedAt={props.generationStartedAt}
            replacing={Boolean(guide)}
            onCancel={props.onCancelGenerateGuide}
          />
        ) : null}

        <AnalysisOverview decision={decision} contentType={guide.contentType} />
      </section>

      <section className="bai-content-card space-y-3 border border-border bg-card p-3">
        <AnalysisDetail decision={decision} suggestedStance={guide.suggestedStance} />
      </section>
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
  const items: readonly {
    readonly index: string;
    readonly title: string;
    readonly description: string;
  }[] = [
    {
      index: '1',
      title: t('分析', 'Analysis'),
      description: t('预览结论、观点和内容精华。', 'Preview conclusions, viewpoints, and highlights.'),
    },
    {
      index: '2',
      title: t('导航', 'Navigation'),
      description: t('生成时间线，快速跳到重点。', 'Generate a timeline and jump to the important parts.'),
    },
    {
      index: '3',
      title: t('提问', 'Ask'),
      description: t('围绕当前片段或全片追问。', 'Ask about the current segment or the whole video.'),
    },
    {
      index: '4',
      title: t('笔记', 'Notes'),
      description: t('保存记录，导出 Markdown。', 'Save records and export Markdown.'),
    },
  ];

  return (
    <section
      className={cn(
        'bai-content-card overflow-hidden border border-border bg-card transition-[max-height,padding,opacity] duration-300 ease-out',
        props.collapsed ? 'max-h-16 p-2 opacity-90' : 'max-h-[560px] space-y-3 p-3 opacity-100',
      )}
      data-testid="quick-start-guide"
      data-collapsed={props.collapsed ? 'true' : 'false'}
    >
      <div className="space-y-1">
        <p className="text-xs font-semibold text-primary">{t('快速预览', 'Quick Preview')}</p>
        <h2
          className={cn(
            'font-bold leading-6',
            props.collapsed ? 'text-sm' : props.compact ? 'text-lg' : 'text-xl',
          )}
        >
          {props.collapsed
            ? t('快速预览已收起，正在生成分析', 'Quick preview collapsed while analysis is generating')
            : t('先快速了解，再按需深入', 'Understand it quickly, then go deeper as needed')}
        </h2>
        {!props.collapsed ? (
          <p
            className={cn(
              'leading-5 text-muted-foreground',
              props.compact ? 'text-[11px]' : 'text-xs',
            )}
          >
            {t(
              '提炼结论与观点、定位重点、围绕内容提问并整理笔记。',
              'Extract conclusions and viewpoints, locate key parts, ask questions, and keep notes.',
            )}
          </p>
        ) : null}
      </div>
      {!props.collapsed ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {items.map((item) => (
              <div key={item.index} className="bai-guide-step border border-border bg-muted/35 p-2">
                <div className="flex items-center gap-2">
                  <span className="bai-guide-number flex h-6 w-6 shrink-0 items-center justify-center bg-primary text-xs font-bold text-primary-foreground">
                    {item.index}
                  </span>
                  <p className="min-w-0 text-sm font-semibold leading-5">{item.title}</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
              </div>
            ))}
          </div>
          {props.actionLabel && props.onAction ? (
            <button
              type="button"
              disabled={props.actionDisabled}
              className="bai-action-button w-full bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
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
        <p className="font-semibold text-foreground">{t('正在生成视频分析', 'Generating video analysis')}</p>
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
        <p className="mt-2 text-muted-foreground">{t('新结果生成完成后会替换当前分析。', 'The new result will replace the current analysis when it is ready.')}</p>
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

function AnalysisOverview(props: {
  readonly decision: LearningGuideDecision;
  readonly contentType: string;
}): JSX.Element {
  const t = useUiText();
  const preview = props.decision.overallMeaning || props.decision.verdict || props.decision.reason;
  const contentType = props.contentType.trim() || t('内容类型', 'Content Type');

  return (
    <div className="bai-analysis-hero space-y-3 bg-muted/35 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-primary">{t('快速预览', 'Quick Preview')}</span>
        <span className="bai-content-type-pill rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
          {contentType}
        </span>
      </div>
      <p className="text-base font-semibold leading-6 text-foreground">{preview}</p>
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
    t('汇总内容精华与适合人群', 'Summarize highlights and relevant audiences'),
    t('生成观看建议并标注信息边界', 'Generate viewing suggestions and note information boundaries'),
  ];
  const visibleCount = Math.min(lines.length, Math.max(1, Math.floor(elapsedSeconds / 2) + 1));
  return lines.slice(0, visibleCount);
}

function AnalysisDetail(props: {
  readonly decision: LearningGuideDecision;
  readonly suggestedStance: string;
}): JSX.Element {
  const t = useUiText();
  const worthReasons = getWorthReasons(props.decision);
  const learningValue = props.decision.learningValue?.slice(0, 3) ?? [];
  const reservations = props.decision.reservations.slice(0, 3);
  const bestFor = props.decision.bestFor.slice(0, 3);
  const notFor = props.decision.notFor.slice(0, 3);

  return (
    <div className="divide-y divide-border/70">
      <CompactText title={t('观看建议', 'Viewing Suggestion')} text={props.decision.reason || props.suggestedStance} />
      <CompactList title={t('内容精华', 'Content Highlights')} items={worthReasons} />
      {learningValue.length ? <CompactList title={t('核心观点', 'Core Viewpoints')} items={learningValue} /> : null}
      <AudienceFitBlock bestFor={bestFor} notFor={notFor} />
      {reservations.length ? <CompactList title={t('信息边界', 'Information Boundaries')} items={reservations} /> : null}
    </div>
  );
}

function CompactText(props: { readonly title: string; readonly text: string }): JSX.Element {
  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <p className="text-xs font-semibold text-foreground">{props.title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.text}</p>
    </div>
  );
}

function CompactList(props: {
  readonly title: string;
  readonly items: readonly string[];
}): JSX.Element | null {
  if (!props.items.length) return null;
  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <p className="text-xs font-semibold text-foreground">{props.title}</p>
      <ul className="mt-1 grid gap-1 text-xs leading-5 text-muted-foreground">
        {props.items.slice(0, 3).map((item, index) => (
          <li
            key={`${props.title}-${item}-${index}`}
            className="grid grid-cols-[0.55rem_minmax(0,1fr)] gap-1"
          >
            <span className="mt-[0.55rem] h-1 w-1 rounded-full bg-primary/70" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AudienceFitBlock(props: {
  readonly bestFor: readonly string[];
  readonly notFor: readonly string[];
}): JSX.Element | null {
  const t = useUiText();
  if (!props.bestFor.length && !props.notFor.length) return null;
  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <p className="text-xs font-semibold text-foreground">{t('适合人群与查看方式', 'Audience and Viewing Approach')}</p>
      <div className="mt-2 grid grid-cols-2 gap-2" data-testid="audience-fit-grid">
        {props.bestFor.length ? <AudienceList title={t('适合深入了解', 'Useful for Deeper Viewing')} items={props.bestFor} /> : null}
        {props.notFor.length ? <AudienceList title={t('可按需参考', 'Reference as Needed')} items={props.notFor} /> : null}
      </div>
    </div>
  );
}

function AudienceList(props: {
  readonly title: string;
  readonly items: readonly string[];
}): JSX.Element {
  return (
    <div className="bai-audience-card border border-border bg-muted/25 p-2 text-xs leading-5">
      <p className="font-semibold text-foreground">{props.title}</p>
      <ul className="mt-1 grid gap-1 text-muted-foreground">
        {props.items.slice(0, 3).map((item, index) => (
          <li
            key={`${props.title}-${item}-${index}`}
            className="grid grid-cols-[0.5rem_minmax(0,1fr)] gap-1"
          >
            <span className="mt-[0.55rem] h-1 w-1 rounded-full bg-primary/70" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function getWorthReasons(decision: LearningGuideDecision): readonly string[] {
  const reasons = decision.worthReasons?.length ? decision.worthReasons : [decision.reason];
  return reasons.slice(0, 3);
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
