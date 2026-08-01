import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@extension/sidepanel/App';
import type { LearningSession } from '@core/types';
import type { PageContext } from '@shared/page-context';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';

const mocks = vi.hoisted(() => ({
  sendRuntimeMessage: vi.fn<(message: ExtensionRequest) => Promise<ExtensionResponse>>(),
  loadPlaybackState: vi.fn<() => Promise<void>>(),
  refreshPageContext: vi.fn<() => Promise<void>>(),
  addMoment: vi.fn(),
  updateMoment: vi.fn(),
  toggleExchangeInReview: vi.fn(),
  getContext: vi.fn<() => PageContext | null>(),
}));

const CONTEXT: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1guide',
  contentKey: 'BV1guide:p=1',
  url: 'https://www.bilibili.com/video/BV1guide',
  title: '视频分析助手测试视频',
  detectedAt: 1,
};

const NEXT_CONTEXT: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1next',
  contentKey: 'BV1next:p=1',
  url: 'https://www.bilibili.com/video/BV1next',
  title: '切换后的测试视频',
  detectedAt: 2,
};

const SESSION: LearningSession = {
  id: 'bilibili:BV1guide:p=1',
  schemaVersion: 2,
  platform: 'bilibili',
  videoId: 'BV1guide:p=1',
  goal: { mode: 'adaptive', focus: '', guideOptionId: 'method' },
  coach: { enabled: true, intensity: 'light', customInstruction: '' },
  guide: {
    decision: {
      rating: 'worth_watching',
      score: 84,
      valueProfile: {
        kind: 'learning_tutorial',
        label: '教程学习',
        criteria: [
          { label: '结构清晰', score: 84, reason: '任务拆解段结构明确。' },
          { label: '可迁移性', score: 86, reason: '方法能复用到项目推进。' },
          { label: '实践成本', score: 80, reason: '需要用户自行套用。' },
        ],
      },
      verdict: '值得看，但先跳到任务拆解段。',
      overallMeaning: '这个视频讲如何用任务拆解推进项目，核心价值在中段方法。',
      reason: '任务拆解段可以直接复用，片尾寒暄可以跳过。',
      bestFor: ['需要学习工作流拆解的人'],
      notFor: ['只想快速看结论的人'],
      timePlans: [
        {
          budget: '10min',
          label: '只有 10 分钟',
          instruction: '直接看任务拆解。',
          segments: [
            {
              title: '任务拆解',
              tag: 'method',
              reason: '这里是核心方法。',
              startTimestamp: 522,
              endTimestamp: 790,
            },
          ],
        },
      ],
      mustWatch: [
        {
          title: '任务拆解',
          tag: 'method',
          reason: '这里开始进入可复用方法。',
          startTimestamp: 522,
          endTimestamp: 790,
        },
      ],
      canWatch: [
        {
          title: '案例补充',
          tag: 'case',
          reason: '帮助理解任务拆解，但不是最高优先级。',
          startTimestamp: 790,
          endTimestamp: 940,
        },
      ],
      canSkim: [
        {
          title: '片尾寒暄',
          tag: 'skim',
          reason: '信息密度较低，可以轻放。',
          startTimestamp: 940,
          endTimestamp: 1080,
        },
      ],
      canSkip: [],
      reservations: [],
    },
    contentType: '方法教程',
    contentTypeReason: '讲的是可复用方法，不是纯资讯。',
    suggestedStance: '值得看，但先跳到任务拆解段。',
    generatedAt: 1,
    modelUsed: 'model',
  },
  moments: [
    {
      id: 'm1',
      kind: 'note',
      content: '任务拆解方法值得加入笔记。',
      timestamp: 522,
      createdAt: 1,
    },
  ],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

function makeContentContextResponse(context: PageContext): ExtensionResponse {
  if (context.platform !== 'bilibili' && context.platform !== 'youtube') {
    throw new Error('测试内容底座只支持视频平台');
  }
  const platform = context.platform;
  const contentKey = context.contentKey ?? context.videoId ?? context.url;
  return {
    ok: true,
    type: 'CONTENT_CONTEXT',
    payload: {
      schemaVersion: 12,
      platform,
      contentKey,
      videoId: context.videoId ?? contentKey,
      kind: 'video',
      metadata: {
        platform,
        videoId: context.videoId ?? contentKey,
        title: context.title ?? '测试视频',
        author: '作者',
        url: context.url,
      },
      transcriptCues: [],
      transcriptCueCount: 0,
      transcriptSource: 'official',
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

vi.mock('@shared/extension-runtime', () => ({
  sendRuntimeMessage: mocks.sendRuntimeMessage,
}));

vi.mock('@extension/sidepanel/hooks/use-page-session', () => ({
  usePageSession: () => ({
    context: mocks.getContext(),
    analysisMode: 'subtitle',
    playbackState: { currentTime: 530, duration: 1200, paused: false },
    refreshPageContext: mocks.refreshPageContext,
    loadPlaybackState: mocks.loadPlaybackState,
  }),
}));

vi.mock('@extension/sidepanel/hooks/use-learning-session', () => ({
  useLearningSession: () => ({
    session: SESSION,
    isMutating: false,
    isGenerating: false,
    isGeneratingGuide: false,
    processingMomentId: null,
    loadSession: vi.fn().mockResolvedValue(undefined),
    updateGoal: vi.fn().mockResolvedValue(undefined),
    updateCoach: vi.fn().mockResolvedValue(undefined),
    generateGuide: vi.fn().mockResolvedValue(undefined),
    addMoment: mocks.addMoment,
    updateMoment: mocks.updateMoment,
    removeMoment: vi.fn().mockResolvedValue(undefined),
    processMoment: vi.fn().mockResolvedValue(undefined),
    toggleExchangeInReview: mocks.toggleExchangeInReview,
    generateReview: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@extension/sidepanel/hooks/use-timeline-session', () => ({
  useTimelineSession: () => ({
    streamingOverviewDraft: '',
    streamingChaptersDraft: [],
    streamingStatus: '',
    streamingCharacterCount: 0,
    isTimelineStreaming: false,
    isReplacingExistingResult: false,
    requestTimeline: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('App 视频分析助手入口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getContext.mockReturnValue(CONTEXT);
    mocks.addMoment.mockResolvedValue(SESSION);
    mocks.updateMoment.mockResolvedValue(undefined);
    mocks.toggleExchangeInReview.mockResolvedValue(undefined);
    mocks.sendRuntimeMessage.mockResolvedValue(makeContentContextResponse(CONTEXT));
    mocks.loadPlaybackState.mockResolvedValue(undefined);
    mocks.refreshPageContext.mockResolvedValue(undefined);
  });

  it('默认进入分析页并自动准备内容底座，旧顶部陪看卡不再跨页显示', async () => {
    render(<App />);

    expect(screen.getByTestId('feature-tab-analysis')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('mentor-guide-card')).toBeNull();
    expect(screen.queryByTestId('mentor-guide-hidden-bar')).toBeNull();
    expect(screen.queryByRole('button', { name: '开启分析' })).toBeNull();
    await waitFor(() => {
      expect(mocks.sendRuntimeMessage).toHaveBeenCalledWith({
        type: 'PREPARE_CONTENT_CONTEXT',
        payload: { forceRefresh: false },
      });
    });
  });

  it('非视频页展示无按钮快速预览说明，但不显示功能入口', () => {
    mocks.getContext.mockReturnValue({
      platform: 'bilibili',
      url: 'https://www.bilibili.com/',
      title: '哔哩哔哩首页',
      detectedAt: 1,
    });

    render(<App />);

    expect(screen.getByTestId('non-video-page-guide')).toHaveTextContent(
      '请打开 B 站 / YouTube 视频页',
    );
    expect(screen.getByText('先快速了解，再按需深入')).toBeDefined();
    expect(screen.getByText('预览结论、观点和内容精华。')).toBeDefined();
    expect(screen.getByText('生成时间线，快速跳到重点。')).toBeDefined();
    expect(screen.getByText('围绕当前片段或全片追问。')).toBeDefined();
    expect(screen.getByText('保存记录，导出 Markdown。')).toBeDefined();
    expect(screen.queryByTestId('feature-tab-analysis')).toBeNull();
    expect(screen.queryByRole('button', { name: '开启分析' })).toBeNull();
    expect(screen.queryByRole('button', { name: '开始快速分析' })).toBeNull();
    expect(screen.queryByTestId('timeline-cta-generate')).toBeNull();
  });

  it('内容底座自动准备后，分析页展示快速分析，笔记页只展示加入笔记入口', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('分析结果')).toBeDefined();
    });
    expect(screen.getByText('这个视频讲如何用任务拆解推进项目，核心价值在中段方法。')).toBeDefined();
    expect(screen.queryByText('84')).toBeNull();
    expect(screen.queryByText('只有 10 分钟')).toBeNull();
    expect(screen.getByText('观看建议')).toBeDefined();
    expect(screen.getByText('内容精华')).toBeDefined();
    expect(screen.getAllByText('任务拆解段可以直接复用，片尾寒暄可以跳过。').length).toBeGreaterThan(0);
    expect(screen.getByText('适合人群与查看方式')).toBeDefined();
    expect(screen.queryByText(/段落取舍/)).toBeNull();
    expect(screen.queryByTestId('mentor-guide-card')).toBeNull();

    fireEvent.click(screen.getByTestId('feature-tab-navigation'));
    expect(screen.getByTestId('feature-tab-navigation')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByTestId('feature-tab-followup'));
    expect(screen.getByTestId('feature-tab-followup')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByTestId('feature-tab-notes'));
    expect(screen.getByTestId('feature-tab-notes')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('1. 加入笔记')).toBeDefined();
    expect(screen.getByText('任务拆解方法值得加入笔记。')).toBeDefined();
    expect(screen.queryByRole('button', { name: '补充判断' })).toBeNull();
    expect(screen.queryByRole('button', { name: '补充说明' })).toBeDefined();
  });

  it('自动准备内容底座的旧视频迟到响应不会写入新视频页面', async () => {
    let resolvePrepare!: (value: ExtensionResponse) => void;
    const pendingPrepare = new Promise<ExtensionResponse>((resolve) => {
      resolvePrepare = resolve;
    });
    mocks.sendRuntimeMessage.mockImplementation((message) => {
      if (message.type === 'PREPARE_CONTENT_CONTEXT') {
        return pendingPrepare;
      }
      return Promise.resolve(makeContentContextResponse(CONTEXT));
    });
    const rendered = render(<App />);

    await waitFor(() => {
      expect(mocks.sendRuntimeMessage).toHaveBeenCalledWith({
        type: 'PREPARE_CONTENT_CONTEXT',
        payload: { forceRefresh: false },
      });
    });

    mocks.getContext.mockReturnValue(NEXT_CONTEXT);
    rendered.rerender(<App />);
    await waitFor(() => {
      expect(screen.getByText('切换后的测试视频')).toBeDefined();
    });

    await act(async () => {
      resolvePrepare(makeContentContextResponse(CONTEXT));
      await pendingPrepare;
    });

    expect(screen.getByText('切换后的测试视频')).toBeDefined();
    expect(screen.getByTestId('header-context-state')).toHaveTextContent('已连接');
    expect(screen.queryByText('内容已准备')).toBeNull();
  });
});
