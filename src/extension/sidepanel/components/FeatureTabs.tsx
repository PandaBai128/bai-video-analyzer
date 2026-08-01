import { useRef } from 'react';
import { cn } from '@lib/utils';
import { useUiText } from '@extension/ui/locale-context';

export type AnalysisTab = 'analysis' | 'navigation' | 'followup' | 'notes';

export interface FeatureTabsProps {
  readonly activeTab: AnalysisTab;
  readonly onSelectTab: (tab: AnalysisTab) => void;
}

const DRAG_THRESHOLD_PX = 34;

/**
 * 四个入口 tab：分析 / 导航 / 提问 / 笔记。受控组件，由 App 持有状态。
 * 支持窄侧边栏里的轻量左右拖动，但点击仍由每个 button 自己处理。
 */
export function FeatureTabs(props: FeatureTabsProps): JSX.Element {
  const t = useUiText();
  const tabs: readonly {
    readonly value: AnalysisTab;
    readonly label: string;
    readonly ariaLabel: string;
  }[] = [
    { value: 'analysis', label: t('分析', 'Analysis'), ariaLabel: t('分析', 'Analysis') },
    { value: 'navigation', label: t('导航', 'Nav'), ariaLabel: t('导航', 'Navigation') },
    { value: 'followup', label: t('提问', 'Ask'), ariaLabel: t('提问', 'Ask') },
    { value: 'notes', label: t('笔记', 'Notes'), ariaLabel: t('笔记', 'Notes') },
  ];
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.value === props.activeTab),
  );
  const dragStartXRef = useRef<number | null>(null);
  const sliderTransform = `translateX(calc(${activeIndex * 100}% + ${activeIndex * 4}px))`;

  const selectByIndex = (index: number): void => {
    const next = tabs[Math.max(0, Math.min(tabs.length - 1, index))];
    if (next && next.value !== props.activeTab) {
      props.onSelectTab(next.value);
    }
  };

  return (
    <div
      className="bai-feature-tabs relative grid touch-pan-y select-none grid-cols-4 gap-1 overflow-hidden rounded-full border border-border bg-muted/40 p-1"
      data-testid="feature-tabs"
      role="tablist"
      onPointerDown={(event) => {
        dragStartXRef.current = event.clientX;
      }}
      onPointerUp={(event) => {
        const startX = dragStartXRef.current;
        dragStartXRef.current = null;
        if (startX === null) return;
        const delta = event.clientX - startX;
        if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
        selectByIndex(activeIndex + (delta < 0 ? 1 : -1));
      }}
      onPointerCancel={() => {
        dragStartXRef.current = null;
      }}
    >
      <span
        className="pointer-events-none absolute bottom-1 left-1 top-1 z-0 rounded-full bg-primary transition-transform duration-300 ease-out"
        style={{
          width: 'calc((100% - 20px) / 4)',
          transform: sliderTransform,
        }}
        aria-hidden="true"
      />
      {tabs.map(({ value, label, ariaLabel }) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={props.activeTab === value}
          aria-label={ariaLabel}
          title={ariaLabel}
          className={cn(
            'relative z-10 min-w-0 rounded-full px-1.5 py-2 text-xs font-semibold transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            props.activeTab === value
              ? 'text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          data-testid={`feature-tab-${value}`}
          onClick={() => props.onSelectTab(value)}
        >
          <span className="block truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}
