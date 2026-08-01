import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PageHeader, type PageHeaderProps } from '@extension/sidepanel/components/PageHeader';
import { FeatureTabs, type AnalysisTab } from '@extension/sidepanel/components/FeatureTabs';
import type { ContentContextCacheValue } from '@core/storage/content-context-cache';
import type { PageContext } from '@shared/page-context';

const SAMPLE_CONTEXT: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频标题',
  detectedAt: 1_700_000_000_000,
};

const SAMPLE_CONTENT_CONTEXT: ContentContextCacheValue = {
  metadata: {
    platform: 'bilibili',
    videoId: 'BV1xx',
    url: 'https://www.bilibili.com/video/BV1xx',
    title: '测试视频标题',
    author: '测试作者',
  },
  transcriptCues: [{ start: 0, end: 1, text: '测试字幕' }],
  transcriptSource: 'official',
};

interface Harness {
  readonly onRefreshPageContext: ReturnType<typeof vi.fn>;
  unmount: () => void;
}

function renderHeader(options: {
  context?: PageContext | null;
  status?: string;
  contentContext?: ContentContextCacheValue | null;
  learningSession?: PageHeaderProps['learningSession'];
  analysisResult?: PageHeaderProps['analysisResult'];
  activeTab?: 'analysis' | 'navigation' | 'followup' | 'notes';
  textModelAccessMode?: PageHeaderProps['textModelAccessMode'];
  onRegenerateAnalysis?: () => void;
  onRegenerateNavigation?: () => void;
} = {}): Harness {
  const onRefreshPageContext = vi.fn().mockResolvedValue(undefined);
  const rendered = render(
    <PageHeader
      context={options.context ?? null}
      status={options.status ?? ''}
      contentContext={options.contentContext ?? null}
      learningSession={options.learningSession ?? null}
      analysisResult={options.analysisResult ?? null}
      textModelAccessMode={options.textModelAccessMode}
      {...(options.activeTab ? { activeTab: options.activeTab } : {})}
      {...(options.onRegenerateAnalysis
        ? { onRegenerateAnalysis: options.onRegenerateAnalysis }
        : {})}
      {...(options.onRegenerateNavigation
        ? { onRegenerateNavigation: options.onRegenerateNavigation }
        : {})}
      onRefreshPageContext={onRefreshPageContext}
    />,
  );
  return {
    onRefreshPageContext,
    unmount: rendered.unmount,
  };
}

function makeLearningSession(
  overrides: Partial<NonNullable<PageHeaderProps['learningSession']>> = {},
): NonNullable<PageHeaderProps['learningSession']> {
  return {
    id: 'bilibili:BV1xx',
    schemaVersion: 3,
    platform: 'bilibili',
    videoId: 'BV1xx',
    goal: { mode: 'adaptive', focus: '' },
    coach: { enabled: false, intensity: 'light', customInstruction: '' },
    moments: [],
    exchanges: [],
    guide: {
      contentType: '访谈',
      contentTypeReason: '主要是 Q&A 内容。',
      suggestedStance: '选择性看。',
      generatedAt: 1_700_000_010_000,
      modelUsed: 'MiniMax-M2.7-highspeed',
      generationDurationMs: 12_345,
      decision: {
        rating: 'selective',
        score: 62,
        valueProfile: {
          kind: 'interview_qa',
          label: '访谈 Q&A',
          criteria: [
            { label: '回答信息量', score: 62, reason: '按问题挑重点即可。' },
            { label: '真实细节', score: 60, reason: '有少量具体信息。' },
            { label: '闲聊控制', score: 58, reason: '部分内容可略过。' },
          ],
        },
        verdict: '选择性看',
        overallMeaning: '按问题挑重点即可。',
        reason: '信息密度中等。',
        bestFor: [],
        notFor: [],
        timePlans: [],
        mustWatch: [],
        canWatch: [],
        canSkim: [],
        canSkip: [],
        reservations: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeAnalysisResult(
  overrides: Partial<NonNullable<PageHeaderProps['analysisResult']>> = {},
): NonNullable<PageHeaderProps['analysisResult']> {
  return {
    metadata: SAMPLE_CONTENT_CONTEXT.metadata,
    subtitleCueCount: 469,
    timings: [
      { label: '读取字幕', durationMs: 300 },
      { label: '总耗时', durationMs: 72_000 },
    ],
    analysis: {
      overview: '导航概览',
      watchStrategy: [],
      coreTakeaways: [],
      reviewSummary: '',
      chapters: [
        {
          timestamp: 0,
          title: '开场',
          summary: '开场说明',
          importance: 'recommended',
          watchGuide: '看即可',
          segments: [
            {
              timestamp: 0,
              title: '引入',
              summary: '引入',
              importance: 'recommended',
            },
          ],
        },
      ],
      timeline: [],
      quotes: [],
      keyConcepts: [],
      inspirations: [],
      generatedAt: 1_700_000_020_000,
      modelUsed: 'MiniMax-M2.7-highspeed',
      sourceMode: 'subtitle',
    },
    ...overrides,
  };
}

interface TabsHarness {
  readonly onSelectTab: ReturnType<typeof vi.fn>;
}

function renderTabs(activeTab: AnalysisTab = 'navigation'): TabsHarness {
  const onSelectTab = vi.fn();
  render(<FeatureTabs activeTab={activeTab} onSelectTab={onSelectTab} />);
  return { onSelectTab };
}

function firePointerEventWithClientX(
  element: Element,
  type: 'pointerDown' | 'pointerUp',
  clientX: number,
): void {
  const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: clientX });
  fireEvent(element, event);
}

beforeEach(() => {
  // 默认 chrome.runtime.openOptionsPage stub
  vi.stubGlobal('chrome', {
    runtime: {
      openOptionsPage: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PageHeader (SG-03C: 页面壳层 header)', () => {
  it('无 context 时显示等待视频摘要，且不重复顶部插件产品名', () => {
    renderHeader();
    expect(screen.queryByText('bAI 视频分析助手')).toBeNull();
    expect(screen.getByText('等待视频页面')).toBeDefined();
    expect(screen.getByTestId('header-context-state').textContent).toBe('等待视频');
    expect(screen.getByText('打开 B 站或 YouTube 视频后开始')).toBeDefined();
    expect(screen.queryByText('分析模式')).toBeNull();
    expect(screen.queryByRole('button', { name: '快速' })).toBeNull();
    expect(screen.queryByRole('button', { name: '精准' })).toBeNull();
  });

  it('有 context 时标题 = context.title', () => {
    renderHeader({ context: SAMPLE_CONTEXT, status: '已连接当前页面' });
    expect(screen.getByText('测试视频标题')).toBeDefined();
    expect(screen.getByText('哔哩哔哩 · BV1xx')).toBeDefined();
    expect(screen.getByTestId('header-context-state').textContent).toBe('已连接');
    expect(screen.queryByText('已连接当前页面')).toBeNull();
    const headerClassName = screen.getByTestId('page-header').getAttribute('class') ?? '';
    expect(headerClassName).toMatch(/\bbai-topbar\b/);
    expect(headerClassName).toMatch(/\bz-40\b/);
    expect(headerClassName).not.toMatch(/\bborder-b\b/);
  });

  it('内容底座准备后只显示短状态，不再显示长说明', () => {
    renderHeader({
      context: SAMPLE_CONTEXT,
      contentContext: SAMPLE_CONTENT_CONTEXT,
      status: '已开启当前视频内容，可以分析、导航、提问或写笔记',
    });
    expect(screen.getByTestId('header-context-state').textContent).toBe('内容已准备');
    expect(screen.queryByText(/已开启当前视频内容/)).toBeNull();
  });

  it('routine status 不显示；错误 / 加载状态显示', () => {
    const { rerender } = render(
      <PageHeader
        context={null}
        status="正在读取视频信息..."
        onRefreshPageContext={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // routine status（"正在读取" 前缀）隐藏
    expect(screen.queryByTestId('header-status')).toBeNull();
    expect(screen.getByTestId('header-context-state').textContent).toBe('等待视频');

    // 错误 / 需处理状态显示
    rerender(
      <PageHeader
        context={null}
        status="读取页面失败"
        onRefreshPageContext={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const status = screen.getByTestId('header-status');
    expect(status.textContent).toBe('读取页面失败');

    // 已恢复 / 时间线已生成 / 已导出 等 routine 状态仍隐藏
    rerender(
      <PageHeader
        context={null}
        status="已恢复上次分析结果"
        onRefreshPageContext={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByTestId('header-status')).toBeNull();

    rerender(
      <PageHeader
        context={null}
        status="Restored previous analysis"
        onRefreshPageContext={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByTestId('header-status')).toBeNull();
  });

  it('长错误状态在侧栏内换行，不撑宽 header', () => {
    renderHeader({
      context: SAMPLE_CONTEXT,
      status:
        '分析生成失败：解析错误，模型输出包含一段特别特别特别特别特别特别特别特别长的原始错误路径',
    });

    const status = screen.getByTestId('header-status');
    const className = status.getAttribute('class') ?? '';
    expect(className).toMatch(/\bbreak-words\b/);
    expect(className).toMatch(/\bwhitespace-normal\b/);
    expect(className).toMatch(/\bmax-w-full\b/);
    expect(className).not.toMatch(/\bshrink-0\b/);
  });

  it('菜单：点 ⋯ 打开，点菜单外关闭，点内部不关闭', () => {
    const h = renderHeader({ context: SAMPLE_CONTEXT });
    const menuButton = screen.getByLabelText('更多操作');
    expect(menuButton.getAttribute('class')).toMatch(/\bh-8\b/);
    expect(menuButton.getAttribute('class')).toMatch(/\bw-8\b/);
    fireEvent.click(menuButton);
    // 菜单项出现
    expect(screen.getByText('刷新页面状态')).toBeDefined();
    expect(screen.getByText('设置')).toBeDefined();
    const menu = screen.getByRole('menu');
    const menuClassName = menu.getAttribute('class') ?? '';
    expect(menuClassName).toMatch(/\bbai-menu-panel\b/);
    expect(menuClassName).toContain('z-[1000]');

    // 点菜单外（document mousedown）关闭
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('刷新页面状态')).toBeNull();

    // 再次打开 → 点刷新菜单项 → 调用 onRefreshPageContext + 关闭菜单
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByText('刷新页面状态'));
    expect(h.onRefreshPageContext).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('刷新页面状态')).toBeNull();
  });

  it('设置菜单项调用 chrome.runtime.openOptionsPage', () => {
    renderHeader({ context: SAMPLE_CONTEXT });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('设置'));
    expect((chrome.runtime.openOptionsPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('当前页面的重新生成动作收进更多菜单', () => {
    const onRegenerateAnalysis = vi.fn();
    renderHeader({
      context: SAMPLE_CONTEXT,
      activeTab: 'analysis',
      onRegenerateAnalysis,
    });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('重新生成分析'));
    expect(onRegenerateAnalysis).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('重新生成分析')).toBeNull();
  });

  it('导航页的重新生成动作使用导航文案', () => {
    const onRegenerateNavigation = vi.fn();
    renderHeader({
      context: SAMPLE_CONTEXT,
      activeTab: 'navigation',
      onRegenerateNavigation,
    });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('重新生成导航'));
    expect(onRegenerateNavigation).toHaveBeenCalledTimes(1);
  });

  it('菜单里"显示详情"打开详情面板 + "分 P" 显示 B 站 page', () => {
    renderHeader({ context: SAMPLE_CONTEXT });
    fireEvent.click(screen.getByLabelText('更多操作'));
    // 第一次点 → 显示详情
    fireEvent.click(screen.getByText('显示详情'));
    const detailsPanel = screen.getByTestId('page-details-panel');
    expect(detailsPanel.getAttribute('class')).toContain('absolute');
    expect(detailsPanel.getAttribute('class')).toContain('max-h-72');
    expect(detailsPanel.getAttribute('class')).toContain('overflow-y-auto');
    const videoInfoPanel = screen.getByText('视频信息').parentElement;
    expect(videoInfoPanel).toBeDefined();
    // 平台 + 视频 ID + 分 P（B 站）
    const panelScope = within(videoInfoPanel!);
    expect(panelScope.getByText('哔哩哔哩')).toBeDefined();
    expect(panelScope.getByText('BV1xx')).toBeDefined();
    // 分 P：page 不在 platformSpecific → 显示 1
    expect(panelScope.getByText('分 P')).toBeDefined();
    expect(panelScope.getByText('1')).toBeDefined();
    expect(panelScope.queryByText('https://www.bilibili.com/video/BV1xx')).toBeNull();

    // 第二次点 → 隐藏详情（菜单文案变回"显示详情"）
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('隐藏详情'));
    expect(screen.queryByText('哔哩哔哩')).toBeNull();
  });

  it('详情面板是悬浮层，点击 header 外部会收起', () => {
    renderHeader({ context: SAMPLE_CONTEXT, contentContext: SAMPLE_CONTENT_CONTEXT });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('显示详情'));
    expect(screen.getByTestId('page-details-panel')).toBeDefined();
    expect(screen.getByText('官方字幕')).toBeDefined();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('page-details-panel')).toBeNull();
  });

  it('详情面板显示自动字幕来源、模型，以及分析 / 导航生成用时', () => {
    renderHeader({
      context: SAMPLE_CONTEXT,
      contentContext: {
        ...SAMPLE_CONTENT_CONTEXT,
        transcriptCues: Array.from({ length: 469 }, (_, index) => ({
          start: index,
          text: `字幕 ${index}`,
        })),
        transcriptSource: 'asr',
      },
      learningSession: makeLearningSession(),
      analysisResult: makeAnalysisResult(),
    });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('显示详情'));

    const detailsPanel = screen.getByTestId('page-details-panel');
    const panelScope = within(detailsPanel);
    expect(panelScope.getByText('自动字幕')).toBeDefined();
    expect(panelScope.getAllByText('469 条').length).toBe(1);
    expect(panelScope.getAllByText('MiniMax-M2.7-highspeed').length).toBe(2);
    expect(panelScope.getAllByText('用时').length).toBeGreaterThanOrEqual(2);
    expect(panelScope.getByText('12s')).toBeDefined();
    expect(panelScope.getByText('72s')).toBeDefined();
  });

  it('bAI 免费服务模式下详情面板不暴露上游真实模型名', () => {
    renderHeader({
      context: SAMPLE_CONTEXT,
      contentContext: SAMPLE_CONTENT_CONTEXT,
      learningSession: makeLearningSession({
        guide: {
          ...makeLearningSession().guide!,
          modelUsed: 'MiniMax-M3',
        },
      }),
      analysisResult: makeAnalysisResult({
        analysis: {
          ...makeAnalysisResult().analysis,
          modelUsed: 'MiniMax-M3',
        },
      }),
      textModelAccessMode: 'bai-free',
    });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('显示详情'));

    const detailsPanel = screen.getByTestId('page-details-panel');
    const panelScope = within(detailsPanel);
    expect(panelScope.getAllByText('bAI 免费服务').length).toBe(2);
    expect(panelScope.queryByText('MiniMax-M3')).toBeNull();
  });

  it('非 B 站视频信息面板显示"内容 ID" + contentKey 兜底', () => {
    const youtubeContext: PageContext = {
      ...SAMPLE_CONTEXT,
      platform: 'youtube',
      videoId: 'yt-1',
      contentKey: 'yt-1',
      url: 'https://www.youtube.com/watch?v=yt-1',
    };
    renderHeader({ context: youtubeContext });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('显示详情'));
    expect(screen.getByTestId('page-details-panel').getAttribute('class')).toContain('max-h-72');
    const videoInfoPanel = screen.getByText('视频信息').parentElement;
    expect(within(videoInfoPanel!).getByText('YouTube')).toBeDefined();
    expect(within(videoInfoPanel!).getByText('内容 ID')).toBeDefined();
    // contentKey 优先于 videoId 作为内容 ID 展示
    expect(within(videoInfoPanel!).getAllByText('yt-1').length).toBeGreaterThanOrEqual(2);
  });
});

describe('FeatureTabs (SG-03C: 四入口受控切换)', () => {
  it('四个 tab testid + activeTab 高亮 + 点击调 onSelectTab', () => {
    const h = renderTabs('notes');
    const tabsRoot = screen.getByTestId('feature-tabs');
    expect(tabsRoot.getAttribute('role')).toBe('tablist');
    expect(within(tabsRoot).getByTestId('feature-tab-analysis')).toBeDefined();
    expect(within(tabsRoot).getByTestId('feature-tab-navigation')).toBeDefined();
    expect(within(tabsRoot).getByTestId('feature-tab-followup')).toBeDefined();
    expect(within(tabsRoot).getByTestId('feature-tab-notes')).toBeDefined();
    // notes 高亮
    expect(within(tabsRoot).getByTestId('feature-tab-notes')).toHaveAttribute('aria-selected', 'true');
    expect(within(tabsRoot).getByTestId('feature-tab-navigation')).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(within(tabsRoot).getByTestId('feature-tab-followup'));
    expect(h.onSelectTab).toHaveBeenCalledWith('followup');
    fireEvent.click(within(tabsRoot).getByTestId('feature-tab-navigation'));
    expect(h.onSelectTab).toHaveBeenCalledWith('navigation');
  });

  it('液态滑块有稳定起点和宽度公式，不再带阴影偏移', () => {
    renderTabs('analysis');
    const tabsRoot = screen.getByTestId('feature-tabs');
    const slider = tabsRoot.querySelector('[aria-hidden="true"]');
    expect(slider).not.toBeNull();
    expect(slider?.getAttribute('class')).toMatch(/\bleft-1\b/);
    expect(slider?.getAttribute('class')).not.toMatch(/\bshadow/);
    expect((slider as HTMLElement).style.width).toBe('calc(0.25 * (100% - 20px))');
    expect((slider as HTMLElement).style.transform).toBe('translateX(calc(0% + 0px))');
  });

  it('不同 active tab 的滑块位移按单格宽度加 gap 对齐', () => {
    const { rerender } = render(
      <FeatureTabs activeTab="analysis" onSelectTab={vi.fn()} />,
    );
    const tabsRoot = screen.getByTestId('feature-tabs');
    const slider = tabsRoot.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(slider.style.transform).toBe('translateX(calc(0% + 0px))');

    rerender(<FeatureTabs activeTab="navigation" onSelectTab={vi.fn()} />);
    expect(slider.style.transform).toBe('translateX(calc(100% + 4px))');

    rerender(<FeatureTabs activeTab="followup" onSelectTab={vi.fn()} />);
    expect(slider.style.transform).toBe('translateX(calc(200% + 8px))');

    rerender(<FeatureTabs activeTab="notes" onSelectTab={vi.fn()} />);
    expect(slider.style.transform).toBe('translateX(calc(300% + 12px))');
  });

  it('tab 文本标签 = 分析 / 导航 / 提问 / 笔记', () => {
    renderTabs();
    expect(screen.getByRole('tab', { name: '分析' })).toBeDefined();
    expect(screen.getByRole('tab', { name: '导航' })).toBeDefined();
    expect(screen.getByRole('tab', { name: '提问' })).toBeDefined();
    expect(screen.getByRole('tab', { name: '笔记' })).toBeDefined();
  });

  it('支持左右拖动切换相邻入口，且小幅滑动不误触发', () => {
    const h = renderTabs('navigation');
    const tabsRoot = screen.getByTestId('feature-tabs');

    firePointerEventWithClientX(tabsRoot, 'pointerDown', 200);
    firePointerEventWithClientX(tabsRoot, 'pointerUp', 150);
    expect(h.onSelectTab).toHaveBeenCalledWith('followup');

    h.onSelectTab.mockClear();
    firePointerEventWithClientX(tabsRoot, 'pointerDown', 200);
    firePointerEventWithClientX(tabsRoot, 'pointerUp', 180);
    expect(h.onSelectTab).not.toHaveBeenCalled();

    firePointerEventWithClientX(tabsRoot, 'pointerDown', 120);
    firePointerEventWithClientX(tabsRoot, 'pointerUp', 170);
    expect(h.onSelectTab).toHaveBeenCalledWith('analysis');
  });
});
