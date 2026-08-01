import type { AnalysisTab } from './components/FeatureTabs';

export type ScrollRestoredAnalysisTab = Exclude<AnalysisTab, 'followup'>;

export type TabScrollPositions = Record<ScrollRestoredAnalysisTab, number>;

const SCROLL_RESTORED_TABS: readonly ScrollRestoredAnalysisTab[] = [
  'analysis',
  'navigation',
  'notes',
];

export function isScrollRestoredAnalysisTab(
  tab: AnalysisTab,
): tab is ScrollRestoredAnalysisTab {
  return (SCROLL_RESTORED_TABS as readonly string[]).includes(tab);
}

export function createTabScrollPositions(): TabScrollPositions {
  return {
    analysis: 0,
    navigation: 0,
    notes: 0,
  };
}

export function getTabScrollPosition(
  positions: TabScrollPositions,
  tab: AnalysisTab,
): number {
  return isScrollRestoredAnalysisTab(tab) ? positions[tab] : 0;
}

export function setTabScrollPosition(
  positions: TabScrollPositions,
  tab: AnalysisTab,
  scrollTop: number,
): void {
  if (!isScrollRestoredAnalysisTab(tab)) return;
  positions[tab] = Math.max(0, scrollTop);
}

export function resetTabScrollPositions(positions: TabScrollPositions): void {
  for (const tab of SCROLL_RESTORED_TABS) {
    positions[tab] = 0;
  }
}
