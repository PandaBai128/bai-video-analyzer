import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@extension/sidepanel/App';
import type { PageContext } from '@shared/page-context';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';

const mocks = vi.hoisted(() => ({
  sendRuntimeMessage: vi.fn<
    (message: ExtensionRequest) => Promise<ExtensionResponse>
  >(),
  loadPlaybackState: vi.fn<() => Promise<void>>(),
  refreshPageContext: vi.fn<() => Promise<void>>(),
}));

const CONTEXT: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1auto',
  contentKey: 'BV1auto:p=1',
  url: 'https://www.bilibili.com/video/BV1auto',
  title: '自动开启测试视频',
  detectedAt: 1,
};

vi.mock('@shared/extension-runtime', () => ({
  sendRuntimeMessage: mocks.sendRuntimeMessage,
}));

vi.mock('@extension/sidepanel/hooks/use-page-session', () => ({
  usePageSession: () => ({
    context: CONTEXT,
    analysisMode: 'subtitle',
    playbackState: null,
    refreshPageContext: mocks.refreshPageContext,
    loadPlaybackState: mocks.loadPlaybackState,
  }),
}));

vi.mock('@extension/sidepanel/hooks/use-learning-session', () => ({
  useLearningSession: () => ({
    session: null,
    isMutating: false,
    isGenerating: false,
    isGeneratingGuide: false,
    processingMomentId: null,
    loadSession: vi.fn().mockResolvedValue(undefined),
    updateGoal: vi.fn().mockResolvedValue(undefined),
    updateCoach: vi.fn().mockResolvedValue(undefined),
    generateGuide: vi.fn().mockResolvedValue(undefined),
    addMoment: vi.fn().mockResolvedValue(null),
    updateMoment: vi.fn().mockResolvedValue(undefined),
    removeMoment: vi.fn().mockResolvedValue(undefined),
    processMoment: vi.fn().mockResolvedValue(undefined),
    toggleExchangeInReview: vi.fn().mockResolvedValue(undefined),
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

describe('App 分析/提问/笔记自动开启内容', () => {
  beforeEach(() => {
    globalThis.sessionStorage?.clear();
    vi.clearAllMocks();
    mocks.sendRuntimeMessage.mockResolvedValue({
      ok: true,
      type: 'CONTENT_CONTEXT',
      payload: {
        schemaVersion: 12,
        platform: 'bilibili',
        contentKey: 'BV1auto:p=1',
        videoId: 'BV1auto',
        kind: 'video',
        metadata: {
          platform: 'bilibili',
          videoId: 'BV1auto',
          title: '自动开启测试视频',
          author: '作者',
          url: 'https://www.bilibili.com/video/BV1auto',
        },
        transcriptCues: [],
        transcriptCueCount: 0,
        transcriptSource: 'official',
        createdAt: 1,
        updatedAt: 1,
      },
    });
    mocks.loadPlaybackState.mockResolvedValue(undefined);
    mocks.refreshPageContext.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.sessionStorage?.clear();
  });

  it('切到分析时自动开启当前视频内容并刷新播放状态', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('feature-tab-analysis'));

    await waitFor(() => {
      expect(mocks.loadPlaybackState).toHaveBeenCalledTimes(1);
      expect(mocks.sendRuntimeMessage).toHaveBeenCalledWith({
        type: 'PREPARE_CONTENT_CONTEXT',
        payload: { forceRefresh: false },
      });
    });
  });

  it('切到笔记时自动开启当前视频内容并刷新播放状态', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('feature-tab-notes'));

    await waitFor(() => {
      expect(mocks.loadPlaybackState).toHaveBeenCalledTimes(1);
      expect(mocks.sendRuntimeMessage).toHaveBeenCalledWith({
        type: 'PREPARE_CONTENT_CONTEXT',
        payload: { forceRefresh: false },
      });
    });
  });

  it('切到提问时自动开启当前视频内容并刷新播放状态', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('feature-tab-followup'));

    await waitFor(() => {
      expect(mocks.loadPlaybackState).toHaveBeenCalledTimes(1);
      expect(mocks.sendRuntimeMessage).toHaveBeenCalledWith({
        type: 'PREPARE_CONTENT_CONTEXT',
        payload: { forceRefresh: false },
      });
    });
  });

  it('side panel 重新挂载后恢复最后打开的提问页', async () => {
    const first = render(<App />);

    fireEvent.click(screen.getByTestId('feature-tab-followup'));
    await waitFor(() => {
      expect(screen.getByTestId('feature-tab-followup')).toHaveAttribute('aria-selected', 'true');
    });

    first.unmount();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('feature-tab-followup')).toHaveAttribute('aria-selected', 'true');
    });
  });
});
