import { useEffect, useState } from 'react';
import type { ContentContextCacheValue } from '@core/storage/content-context-cache';
import type { LearningSession } from '@core/types';
import type { PageContext } from '@shared/page-context';
import type { TextModelAccessMode } from '@shared/settings';
import type { AnalysisTab } from './FeatureTabs';
import type { TimelineSessionAnalysisResult } from '../hooks/use-timeline-session';
import { useUiText } from '@extension/ui/locale-context';

/**
 * 页面壳层 header：当前视频摘要 + context status + 三点菜单 + 视频信息面板。
 *
 * 内部拥有菜单 / 视频信息面板这两个纯视觉 UI 局部状态；不写业务状态（result / tab / playback /
 * context 都由 App 通过 props 传入）。`chrome.runtime.openOptionsPage` 作为该菜单的 UI 动作
 * 保留在组件内（不引入通用菜单 service）。
 */

const platformLabels: Record<PageContext['platform'], string> = {
  bilibili: '哔哩哔哩',
  youtube: 'YouTube',
  unknown: '未识别',
};

/** routine 成功状态不占用 header；错误、加载和需用户处理的状态仍显示。 */
function shouldShowHeaderStatus(status: string): boolean {
  const normalized = status.trim();
  if (!normalized) {
    return false;
  }
  const ROUTINE_HIDDEN_PREFIXES: readonly string[] = [
    '已恢复',
    '已读取',
    '已刷新',
    '已连接',
    '已开启',
    '时间线已生成',
    '导航已生成',
    '分析已生成',
    '已导出',
    '正在读取',
    'Restored',
    'Read',
    'Refreshed',
    'Connected',
    'Navigation generated',
    'Analysis generated',
    'Exported',
    'Reading',
  ];
  for (const prefix of ROUTINE_HIDDEN_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return false;
    }
  }
  return true;
}

export interface PageHeaderProps {
  readonly context: PageContext | null;
  readonly status: string;
  readonly contentContext?: ContentContextCacheValue | null;
  readonly analysisResult?: TimelineSessionAnalysisResult | null;
  readonly learningSession?: LearningSession | null;
  readonly activeAnalysisGenerationStartedAt?: number | null;
  readonly activeAnalysisGenerationCharacterCount?: number;
  readonly textModelAccessMode?: TextModelAccessMode | undefined;
  readonly activeTab?: AnalysisTab;
  readonly isActionDisabled?: boolean;
  readonly onRegenerateAnalysis?: () => void;
  readonly onRegenerateNavigation?: () => void;
  readonly onRefreshPageContext: () => Promise<void>;
}

interface HeaderBadge {
  readonly label: string;
  readonly tone: 'attention' | 'ready' | 'connected' | 'idle';
  readonly isStatus: boolean;
}

export function PageHeader(props: PageHeaderProps): JSX.Element {
  const t = useUiText();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDetailsPanelOpen, setIsDetailsPanelOpen] = useState(false);
  const visibleStatus = shouldShowHeaderStatus(props.status) ? props.status.trim() : '';
  const badge = createHeaderBadge({
    context: props.context,
    contentContext: props.contentContext,
    visibleStatus,
    t,
  });
  const title = getHeaderTitle(props.context, t);
  const meta = getHeaderMeta(props.context, t);
  const regenerationAction = getRegenerationAction(props, t);

  // 点击菜单外关闭
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && !target.closest('[data-bai-menu]')) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  useEffect(() => {
    if (!isDetailsPanelOpen) return;
    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && !target.closest('[data-bai-header]')) {
        setIsDetailsPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isDetailsPanelOpen]);

  return (
    <div className="relative z-50 shrink-0" data-bai-header>
      <header
        className="bai-topbar relative z-40 border border-border bg-card p-3"
        data-testid="page-header"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p
              className="bai-topbar-title truncate text-sm font-semibold leading-5 text-foreground"
              title={title}
            >
              {title}
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={`bai-status-pill bai-status-pill-${badge.tone} border px-2 py-0.5 text-[11px] font-semibold leading-4 ${
                  badge.isStatus
                    ? 'inline-block min-w-0 max-w-full whitespace-normal break-words text-left'
                    : 'shrink-0'
                }`}
                data-testid={badge.isStatus ? 'header-status' : 'header-context-state'}
              >
                {badge.label}
              </span>
              {meta ? (
                <span className="bai-topbar-meta min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
                  {meta}
                </span>
              ) : null}
            </div>
          </div>
          <div className="relative shrink-0" data-bai-menu>
            <button
              type="button"
              aria-label={t('更多操作', 'More actions')}
              className="bai-icon-button flex h-8 w-8 items-center justify-center border border-border text-base font-semibold leading-none transition-colors hover:bg-accent"
              onClick={() => setIsMenuOpen((prev) => !prev)}
            >
              <span className="bai-more-dots" aria-hidden="true">
                •••
              </span>
            </button>
            {isMenuOpen ? (
              <div
                role="menu"
                className="bai-menu-panel absolute right-0 top-[calc(100%+0.5rem)] z-[1000] w-40 border border-border bg-card p-1 text-foreground shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="bai-menu-item block w-full px-3 py-2 text-left text-xs font-medium hover:bg-accent"
                  onClick={() => {
                    setIsDetailsPanelOpen((prev) => !prev);
                    setIsMenuOpen(false);
                  }}
                >
                  {isDetailsPanelOpen ? t('隐藏详情', 'Hide Details') : t('显示详情', 'Show Details')}
                </button>
                {regenerationAction ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="bai-menu-item block w-full px-3 py-2 text-left text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={props.isActionDisabled}
                    onClick={() => {
                      setIsMenuOpen(false);
                      regenerationAction.onClick();
                    }}
                  >
                    {regenerationAction.label}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="bai-menu-item block w-full px-3 py-2 text-left text-xs font-medium hover:bg-accent"
                  onClick={() => {
                    setIsMenuOpen(false);
                    void props.onRefreshPageContext();
                  }}
                >
                  {t('刷新页面状态', 'Refresh Page State')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="bai-menu-item block w-full px-3 py-2 text-left text-xs font-medium hover:bg-accent"
                  onClick={() => {
                    setIsMenuOpen(false);
                    try {
                      if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
                        void chrome.runtime.openOptionsPage();
                      }
                    } catch {
                      // ignore
                    }
                  }}
                >
                  {t('设置', 'Settings')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      {props.context && isDetailsPanelOpen ? (
        <DetailsSummaryPanel
          context={props.context}
          contentContext={props.contentContext}
          learningSession={props.learningSession}
          analysisResult={props.analysisResult}
          activeAnalysisGenerationStartedAt={props.activeAnalysisGenerationStartedAt}
          activeAnalysisGenerationCharacterCount={props.activeAnalysisGenerationCharacterCount}
          textModelAccessMode={props.textModelAccessMode}
        />
      ) : null}
    </div>
  );
}

function getRegenerationAction(
  props: PageHeaderProps,
  t: (zh: string, en: string) => string,
): {
  readonly label: string;
  readonly onClick: () => void;
} | null {
  if (props.activeTab === 'analysis' && props.onRegenerateAnalysis) {
    return { label: t('重新生成分析', 'Regenerate Analysis'), onClick: props.onRegenerateAnalysis };
  }
  if (props.activeTab === 'navigation' && props.onRegenerateNavigation) {
    return { label: t('重新生成导航', 'Regenerate Navigation'), onClick: props.onRegenerateNavigation };
  }
  return null;
}

function getHeaderTitle(
  context: PageContext | null,
  t: (zh: string, en: string) => string,
): string {
  const title = context?.title?.trim();
  if (title) return title;
  return context ? t('当前视频', 'Current Video') : t('等待视频页面', 'Waiting for a Video Page');
}

function getHeaderMeta(
  context: PageContext | null,
  t: (zh: string, en: string) => string,
): string {
  if (!context) return t('打开 B 站或 YouTube 视频后开始', 'Open a Bilibili or YouTube video to start');
  const platform = platformLabels[context.platform];
  const videoId = context.videoId?.trim();
  if (videoId) return `${platform} · ${videoId}`;
  return platform;
}

function createHeaderBadge(input: {
  readonly context: PageContext | null;
  readonly contentContext: ContentContextCacheValue | null | undefined;
  readonly visibleStatus: string;
  readonly t: (zh: string, en: string) => string;
}): HeaderBadge {
  if (input.visibleStatus) {
    return { label: input.visibleStatus, tone: 'attention', isStatus: true };
  }
  if (input.contentContext) {
    return { label: input.t('内容已准备', 'Content ready'), tone: 'ready', isStatus: false };
  }
  if (input.context) {
    return { label: input.t('已连接', 'Connected'), tone: 'connected', isStatus: false };
  }
  return { label: input.t('等待视频', 'Waiting for video'), tone: 'idle', isStatus: false };
}

function DetailsSummaryPanel(props: {
  readonly context: PageContext;
  readonly contentContext: ContentContextCacheValue | null | undefined;
  readonly learningSession: LearningSession | null | undefined;
  readonly analysisResult: TimelineSessionAnalysisResult | null | undefined;
  readonly activeAnalysisGenerationStartedAt: number | null | undefined;
  readonly activeAnalysisGenerationCharacterCount: number | undefined;
  readonly textModelAccessMode: TextModelAccessMode | undefined;
}): JSX.Element {
  const t = useUiText();
  const videoItems = createVideoDetailItems(props.context, t);
  const contentItems = createContentDetailItems(props.contentContext, t);
  const analysisItems = createAnalysisDetailItems({
    session: props.learningSession,
    activeStartedAt: props.activeAnalysisGenerationStartedAt,
    activeCharacterCount: props.activeAnalysisGenerationCharacterCount,
    textModelAccessMode: props.textModelAccessMode,
    t,
  });
  const navigationItems = createNavigationDetailItems({
    result: props.analysisResult,
    textModelAccessMode: props.textModelAccessMode,
    t,
  });

  return (
    <section
      className="bai-panel bai-details-panel absolute left-0 right-0 top-[calc(100%+0.5rem)] z-[900] max-h-72 space-y-3 overflow-y-auto rounded-md border border-border bg-card p-3 text-sm shadow-lg"
      data-testid="page-details-panel"
    >
      <p className="text-xs font-semibold text-foreground">{t('视频信息', 'Video Info')}</p>
      <DetailGrid items={videoItems} />
      <DetailGroup title={t('内容底座', 'Content Context')} items={contentItems} />
      <DetailGroup title={t('分析', 'Analysis')} items={analysisItems} />
      <DetailGroup title={t('导航', 'Navigation')} items={navigationItems} />
    </section>
  );
}

function DetailGroup(props: {
  readonly title: string;
  readonly items: readonly DetailItem[];
}): JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-muted-foreground">{props.title}</p>
      <DetailGrid items={props.items} />
    </div>
  );
}

interface DetailItem {
  readonly label: string;
  readonly value: string;
}

function DetailGrid(props: {
  readonly items: readonly DetailItem[];
}): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2">
      {props.items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="bai-detail-chip border border-border bg-background/55 p-2">
          <p className="text-[10px] leading-4 text-muted-foreground">{item.label}</p>
          <p className="mt-0.5 truncate text-xs font-semibold" title={item.value}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function createVideoDetailItems(
  context: PageContext,
  t: (zh: string, en: string) => string,
): readonly DetailItem[] {
  return [
    { label: t('平台', 'Platform'), value: platformLabels[context.platform] },
    { label: t('视频 ID', 'Video ID'), value: context.videoId || t('暂未识别', 'Not detected') },
    {
      label: context.platform === 'bilibili' ? t('分 P', 'Part') : t('内容 ID', 'Content ID'),
      value:
        context.platform === 'bilibili'
          ? String(context.platformSpecific?.page ?? 1)
          : context.contentKey || context.videoId || t('暂未识别', 'Not detected'),
    },
    { label: t('页面', 'Page'), value: compactUrl(context.url) },
  ];
}

function createContentDetailItems(
  contentContext: ContentContextCacheValue | null | undefined,
  t: (zh: string, en: string) => string,
): readonly DetailItem[] {
  return [
    {
      label: t('字幕', 'Subtitles'),
      value: contentContext
        ? t(
            `${contentContext.transcriptCues.length.toLocaleString('zh-CN')} 条`,
            `${contentContext.transcriptCues.length.toLocaleString('en-US')} cues`,
          )
        : t('未开启', 'Not ready'),
    },
    {
      label: t('来源', 'Source'),
      value: contentContext ? formatTranscriptSource(contentContext.transcriptSource, t) : t('暂无', 'None'),
    },
  ];
}

function createAnalysisDetailItems(input: {
  readonly session: LearningSession | null | undefined;
  readonly activeStartedAt: number | null | undefined;
  readonly activeCharacterCount: number | undefined;
  readonly textModelAccessMode: TextModelAccessMode | undefined;
  readonly t: (zh: string, en: string) => string;
}): readonly DetailItem[] {
  const guide = input.session?.guide;
  const t = input.t;
  if (!guide) {
    return [
      { label: t('状态', 'Status'), value: input.activeStartedAt ? t('正在生成', 'Generating') : t('未生成', 'Not generated') },
      {
        label: t('用时', 'Duration'),
        value: input.activeStartedAt ? `${getElapsedSeconds(input.activeStartedAt)}s` : t('暂无', 'None'),
      },
      {
        label: t('输出', 'Output'),
        value: input.activeCharacterCount
          ? t(
              `${input.activeCharacterCount.toLocaleString('zh-CN')} 字`,
              `${input.activeCharacterCount.toLocaleString('en-US')} chars`,
            )
          : t('暂无', 'None'),
      },
    ];
  }
  return [
    { label: t('内容类型', 'Content Type'), value: guide.contentType },
    { label: t('模型', 'Model'), value: formatVisibleModelName(guide.modelUsed, input.textModelAccessMode, t) },
    { label: t('生成', 'Generated'), value: formatDateTime(guide.generatedAt, t) },
    { label: t('用时', 'Duration'), value: formatDurationMs(guide.generationDurationMs, t) },
  ];
}

function createNavigationDetailItems(input: {
  readonly result: TimelineSessionAnalysisResult | null | undefined;
  readonly textModelAccessMode: TextModelAccessMode | undefined;
  readonly t: (zh: string, en: string) => string;
}): readonly DetailItem[] {
  const { result, textModelAccessMode, t } = input;
  if (!result) {
    return [
      { label: t('状态', 'Status'), value: t('未生成', 'Not generated') },
      { label: t('章节', 'Chapters'), value: t('暂无', 'None') },
    ];
  }
  const segmentCount = result.analysis.chapters.reduce(
    (sum, chapter) => sum + chapter.segments.length,
    0,
  );
  return [
    {
      label: t('章节', 'Chapters'),
      value: t(
        `${result.analysis.chapters.length} 章 / ${segmentCount} 小节`,
        `${result.analysis.chapters.length} chapters / ${segmentCount} segments`,
      ),
    },
    { label: t('模型', 'Model'), value: formatVisibleModelName(result.analysis.modelUsed, textModelAccessMode, t) },
    { label: t('生成', 'Generated'), value: formatDateTime(result.analysis.generatedAt, t) },
    { label: t('用时', 'Duration'), value: formatDurationMs(getTotalDurationMs(result.timings), t) },
  ];
}

function formatVisibleModelName(
  modelUsed: string,
  textModelAccessMode: TextModelAccessMode | undefined,
  t: (zh: string, en: string) => string,
): string {
  if (textModelAccessMode === 'bai-free') {
    return t('bAI 免费服务', 'bAI Free Service');
  }
  const trimmed = modelUsed.trim();
  return trimmed || t('暂无', 'None');
}

function compactUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatTranscriptSource(
  source: ContentContextCacheValue['transcriptSource'],
  t: (zh: string, en: string) => string,
): string {
  switch (source) {
    case 'official':
      return t('官方字幕', 'Official subtitles');
    case 'asr':
      return t('自动字幕', 'Auto captions');
    case 'page':
      return t('页面字幕', 'Page captions');
    case 'unknown':
      return t('未知', 'Unknown');
  }
}

function formatDateTime(timestamp: number, t: (zh: string, en: string) => string): string {
  if (!Number.isFinite(timestamp)) return t('暂无', 'None');
  return new Intl.DateTimeFormat(t('zh-CN', 'en-US'), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatDurationMs(
  durationMs: number | undefined,
  t: (zh: string, en: string) => string,
): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return t('暂无', 'None');
  const normalizedMs = Math.max(0, Math.round(durationMs));
  if (normalizedMs < 1000) return `${normalizedMs}ms`;
  return `${Math.round(normalizedMs / 1000)}s`;
}

function getTotalDurationMs(timings: TimelineSessionAnalysisResult['timings']): number | undefined {
  const explicitTotal = timings.find((timing) => timing.label === '总耗时');
  if (explicitTotal) return explicitTotal.durationMs;
  if (timings.length === 0) return undefined;
  return timings.reduce((total, timing) => total + timing.durationMs, 0);
}

function getElapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}
