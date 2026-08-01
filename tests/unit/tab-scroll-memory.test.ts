import { describe, expect, it } from 'vitest';
import {
  createTabScrollPositions,
  getTabScrollPosition,
  isScrollRestoredAnalysisTab,
  resetTabScrollPositions,
  setTabScrollPosition,
} from '@extension/sidepanel/tab-scroll-memory';

describe('tab-scroll-memory', () => {
  it('只为分析 / 导航 / 笔记保留滚动位置，提问由自身保活逻辑处理', () => {
    expect(isScrollRestoredAnalysisTab('analysis')).toBe(true);
    expect(isScrollRestoredAnalysisTab('navigation')).toBe(true);
    expect(isScrollRestoredAnalysisTab('notes')).toBe(true);
    expect(isScrollRestoredAnalysisTab('followup')).toBe(false);
  });

  it('分别保存和读取不同 tab 的 scrollTop', () => {
    const positions = createTabScrollPositions();

    setTabScrollPosition(positions, 'analysis', 120);
    setTabScrollPosition(positions, 'navigation', 360);
    setTabScrollPosition(positions, 'notes', 48);

    expect(getTabScrollPosition(positions, 'analysis')).toBe(120);
    expect(getTabScrollPosition(positions, 'navigation')).toBe(360);
    expect(getTabScrollPosition(positions, 'notes')).toBe(48);
  });

  it('切到提问不会写入或读取分析页滚动记录', () => {
    const positions = createTabScrollPositions();

    setTabScrollPosition(positions, 'analysis', 120);
    setTabScrollPosition(positions, 'followup', 999);

    expect(getTabScrollPosition(positions, 'followup')).toBe(0);
    expect(getTabScrollPosition(positions, 'analysis')).toBe(120);
  });

  it('新视频 context 重置时清空所有受控 tab 滚动位置', () => {
    const positions = createTabScrollPositions();
    setTabScrollPosition(positions, 'analysis', 120);
    setTabScrollPosition(positions, 'navigation', 360);
    setTabScrollPosition(positions, 'notes', 48);

    resetTabScrollPositions(positions);

    expect(positions).toEqual({
      analysis: 0,
      navigation: 0,
      notes: 0,
    });
  });

  it('负数 scrollTop 会被归零，避免恢复非法位置', () => {
    const positions = createTabScrollPositions();

    setTabScrollPosition(positions, 'navigation', -20);

    expect(getTabScrollPosition(positions, 'navigation')).toBe(0);
  });
});
