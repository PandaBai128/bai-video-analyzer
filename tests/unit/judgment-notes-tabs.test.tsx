import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisTab } from '@extension/sidepanel/components/AnalysisTab';
import { NotesTab } from '@extension/sidepanel/components/NotesTab';
import type { LearningSession } from '@core/types';

const localeMock = vi.hoisted(() => ({
  locale: 'zh-CN' as 'zh-CN' | 'en-US',
}));

vi.mock('@extension/ui/locale-context', () => ({
  useUiLocale: () => localeMock.locale,
  useUiText: () => (zh: string, en: string) => (localeMock.locale === 'en-US' ? en : zh),
}));

afterEach(() => {
  localeMock.locale = 'zh-CN';
});

const SESSION: LearningSession = {
  id: 'youtube:video',
  schemaVersion: 2,
  platform: 'youtube',
  videoId: 'video',
  goal: { mode: 'adaptive', focus: '', guideOptionId: 'method' },
  coach: { enabled: true, intensity: 'light', customInstruction: '' },
  guide: {
    decision: {
      rating: 'worth_watching',
      score: 86,
      valueProfile: {
        kind: 'learning_tutorial',
        label: '教程学习',
        criteria: [
          {
            label: '结构清晰',
            score: 90,
            reason: '内容是否有清楚的目标、顺序和层次，用户能否快速跟上。',
          },
          {
            label: '可迁移方法',
            score: 88,
            reason: '是否提供能迁移到其他任务或场景的方法，而不是只讲个例。',
          },
          {
            label: '步骤完整',
            score: 82,
            reason: '关键步骤、前置条件和结论是否交代完整，是否方便照着做。',
          },
          {
            label: '时效可控',
            score: 84,
            reason: '内容是否不依赖易过时的版本、政策、工具界面或短期信息；高分表示时效风险可控。',
          },
          {
            label: '实践成本',
            score: 80,
            reason: '用户看完后实际尝试所需时间、资源和门槛是否合理。',
          },
        ],
      },
      verdict: '值得看，重点看任务拆解和案例。',
      overallMeaning: '这个视频主要讲如何把复杂任务拆成可执行步骤，适合节省试错时间。',
      reason: '中段进入可复用方法，能直接迁移到自己的项目；片尾闲聊信息密度低。',
      worthReasons: ['中段进入可复用方法，能直接迁移到自己的项目。'],
      bestFor: ['想学习任务拆解方法的人', '需要快速判断教程价值的人'],
      notFor: ['只想看娱乐内容的人'],
      learningValue: ['可以参考把复杂任务拆成可执行步骤的流程。'],
      timePlans: [
        {
          budget: '10min',
          label: '只有 10 分钟',
          instruction: '直接看任务拆解段，跳过片尾闲聊。',
          segments: [
            {
              title: '任务拆解',
              tag: 'must_watch',
              reason: '进入可复用方法。',
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
          reason: '可以帮助理解任务拆解，但不是最高优先级。',
          startTimestamp: 790,
          endTimestamp: 940,
        },
      ],
      canSkim: [
        {
          title: '背景铺垫',
          tag: 'skim',
          reason: '信息密度较低，可以轻放。',
          startTimestamp: 120,
          endTimestamp: 240,
        },
      ],
      canSkip: [
        {
          title: '片尾闲聊',
          tag: 'skip',
          reason: '只是收尾和闲聊，信息密度低。',
          startTimestamp: 1100,
          endTimestamp: 1200,
        },
      ],
      reservations: ['方法是否适合大型团队还需要自己验证。'],
    },
    contentType: '方法教程',
    contentTypeReason: '重点是可复用步骤。',
    suggestedStance: '值得看，重点看任务拆解和案例。',
    generatedAt: 1,
    modelUsed: 'model',
  },
  moments: [
    {
      id: 'm1',
      kind: 'insight',
      content: '任务拆解可以迁移到自己的项目。',
      timestamp: 522,
      createdAt: 1,
    },
  ],
  exchanges: [
    {
      id: 'e1',
      question: '这一段值得看吗？',
      answer: '值得，进入了方法主体。',
      includedInReview: true,
      createdAt: 2,
    },
    {
      id: 'e2',
      question: '普通问答会进笔记吗？',
      answer: '不会。',
      createdAt: 3,
    },
  ],
  review: {
    coreSummary: '视频讲了如何拆任务。',
    keyIdeas: [{ title: '先拆任务', explanation: '把大任务拆成可执行步骤。' }],
    personalInsights: ['我加入了任务拆解方法。'],
    transferReflection: '我可以把任务拆解迁移到自己的项目启动流程里。',
    openQuestions: ['哪些场景不适合这种拆法？'],
    actionItems: ['用一个项目试一次。'],
    finalReflection: '这条视频的价值在于方法可以迁移。',
    generatedAt: 4,
    modelUsed: 'model',
  },
  createdAt: 1,
  updatedAt: 4,
};

function renderAnalysis(overrides: Partial<Parameters<typeof AnalysisTab>[0]> = {}) {
  const props: Parameters<typeof AnalysisTab>[0] = {
    session: SESSION,
    hasContentContext: true,
    isPreparing: false,
    isMutating: false,
    isGeneratingGuide: false,
    onStartAnalysis: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<AnalysisTab {...props} />);
  return props;
}

function renderNotes(overrides: Partial<Parameters<typeof NotesTab>[0]> = {}) {
  const props: Parameters<typeof NotesTab>[0] = {
    session: SESSION,
    hasContentContext: true,
    currentTime: 530,
    isPreparing: false,
    isMutating: false,
    isGenerating: false,
    isExporting: false,
    exportedFolderName: '',
    onPrepareContentContext: vi.fn(),
    onAddMoment: vi.fn().mockResolvedValue(SESSION),
    onUpdateMoment: vi.fn().mockResolvedValue(undefined),
    onRemoveMoment: vi.fn().mockResolvedValue(undefined),
    onToggleExchangeInReview: vi.fn().mockResolvedValue(undefined),
    onGenerateReview: vi.fn().mockResolvedValue(undefined),
    onExport: vi.fn().mockResolvedValue(undefined),
    onSeek: vi.fn(),
    ...overrides,
  };
  render(<NotesTab {...props} />);
  return props;
}

describe('AnalysisTab', () => {
  it('无内容底座时也只显示一次点击的快速分析入口', () => {
    const props = renderAnalysis({ session: null, hasContentContext: false });
    expect(screen.getByTestId('quick-start-guide')).toBeDefined();
    expect(screen.getAllByText('快速预览').length).toBeGreaterThan(0);
    expect(screen.getByText('先快速了解，再按需深入')).toBeDefined();
    expect(screen.getByText('提炼结论与观点、定位重点、围绕内容提问并整理笔记。')).toBeDefined();
    expect(screen.getByText('分析')).toBeDefined();
    expect(screen.getByText('预览结论、观点和内容精华。')).toBeDefined();
    expect(screen.getByText('导航')).toBeDefined();
    expect(screen.getByText('生成时间线，快速跳到重点。')).toBeDefined();
    expect(screen.getByText('提问')).toBeDefined();
    expect(screen.getByText('围绕当前片段或全片追问。')).toBeDefined();
    expect(screen.getByText('笔记')).toBeDefined();
    expect(screen.getByText('保存记录，导出 Markdown。')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '开始快速分析' }));
    expect(props.onStartAnalysis).toHaveBeenCalledTimes(1);
  });

  it('已有内容底座但未生成分析时，仍显示快速预览而不是空分析卡', () => {
    const props = renderAnalysis({ session: null, hasContentContext: true });

    expect(screen.getByTestId('quick-start-guide')).toBeDefined();
    expect(screen.getByText('先快速了解，再按需深入')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '开始快速分析' }));
    expect(props.onStartAnalysis).toHaveBeenCalledTimes(1);
  });

  it('生成分析时显示分析生成进度', () => {
    const onCancelGenerateGuide = vi.fn();
    renderAnalysis({
      session: null,
      isGeneratingGuide: true,
      generationStatus: '正在生成视频分析，遇到很长很长很长很长很长很长的解析状态也不能撑出侧栏...',
      onCancelGenerateGuide,
    });

    expect(screen.getByTestId('quick-start-guide').getAttribute('data-collapsed')).toBe('true');
    const progress = screen.getByTestId('analysis-generation-progress');
    expect(progress).toBeDefined();
    expect(screen.getByTestId('analysis-generation-flow')).toBeDefined();
    expect(screen.getByText('正在生成视频分析')).toBeDefined();
    expect(screen.getByText('快速预览已收起，正在生成分析')).toBeDefined();
    expect(screen.getByText('读取字幕和视频标题，建立内容底座')).toBeDefined();
    const status = screen.getByText(
      '正在生成视频分析，遇到很长很长很长很长很长很长的解析状态也不能撑出侧栏...',
    );
    expect(status.getAttribute('class')).toContain('break-words');
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    expect(onCancelGenerateGuide).toHaveBeenCalledTimes(1);
  });

  it('展示快速预览和辅助分析，不显示评分、观看等级或完整导航路线', () => {
    renderAnalysis();

    expect(screen.getByText('分析结果')).toBeDefined();
    expect(screen.getByText('快速预览')).toBeDefined();
    expect(screen.getByText('方法教程')).toBeDefined();
    expect(screen.getByText('这个视频主要讲如何把复杂任务拆成可执行步骤，适合节省试错时间。')).toBeDefined();
    expect(screen.getByText('观看建议')).toBeDefined();
    expect(screen.getByText('内容精华')).toBeDefined();
    expect(screen.getByText('核心观点')).toBeDefined();
    expect(screen.getByText('适合人群与查看方式')).toBeDefined();
    expect(screen.getByText('适合深入了解')).toBeDefined();
    expect(screen.getByText('可按需参考')).toBeDefined();
    expect(screen.getByText('信息边界')).toBeDefined();
    expect(screen.queryByText('综合评分')).toBeNull();
    expect(screen.queryByText('完整细看')).toBeNull();
    expect(screen.queryByText('86')).toBeNull();
    expect(screen.queryByText('观看路线')).toBeNull();
    expect(screen.queryByText('按时间预算')).toBeNull();
    expect(screen.queryByText('只有 10 分钟')).toBeNull();
    expect(screen.queryByText('最值得看')).toBeNull();
    expect(screen.queryByText('广告 / 可跳过')).toBeNull();
    expect(screen.queryByText('学习目标（可选）')).toBeNull();
    expect(screen.queryByRole('button', { name: /提示/ })).toBeNull();
    expect(screen.queryByText('陪看设置')).toBeNull();
    expect(screen.queryByText('边看边打点')).toBeNull();
  });

  it('英文界面使用快速分析语义', () => {
    localeMock.locale = 'en-US';
    renderAnalysis();

    expect(screen.getByText('Quick Preview')).toBeDefined();
    expect(screen.getByText('Viewing Suggestion')).toBeDefined();
    expect(screen.getByText('Content Highlights')).toBeDefined();
    expect(screen.getByText('Core Viewpoints')).toBeDefined();
    expect(screen.queryByText('Overall Score')).toBeNull();
  });

  it('适合深入了解和可按需参考保持双卡片并列展示', () => {
    renderAnalysis();

    const grid = screen.getByTestId('audience-fit-grid');
    expect(grid.getAttribute('class')).toContain('grid-cols-2');
    expect(grid.textContent).toContain('适合深入了解');
    expect(grid.textContent).toContain('可按需参考');
    expect(grid.textContent).toContain('想学习任务拆解方法的人');
    expect(grid.textContent).toContain('只想看娱乐内容的人');
  });

  it('快速预览展示内容类型和概括，不展示内部评分元数据', () => {
    renderAnalysis({
      session: {
        ...SESSION,
        guide: {
          ...SESSION.guide!,
          contentType: '观点评论',
          decision: {
            ...SESSION.guide!.decision,
            score: 62,
            verdict: '想了解罗斯凯利法美术设计的可以直接看，不需要专门腾出 8 分钟。',
            overallMeaning: '一条从业者视角对绝区零3.0新场景「罗斯凯利法」英伦风美术的锐评视频。',
          },
        },
      },
    });

    const contentTypePill = screen.getByText('观点评论');
    expect(contentTypePill.getAttribute('class')).toContain('bai-content-type-pill');
    expect(contentTypePill.getAttribute('class')).toContain('bg-primary');
    expect(
      screen.getByText('一条从业者视角对绝区零3.0新场景「罗斯凯利法」英伦风美术的锐评视频。'),
    ).toBeDefined();
    expect(screen.queryByText('62')).toBeNull();
    expect(screen.queryByText('综合评分')).toBeNull();
  });

  it('分析短列表最多显示 3 条，旧观看等级不再显示', () => {
    renderAnalysis({
      session: {
        ...SESSION,
        guide: {
          ...SESSION.guide!,
          decision: {
            ...SESSION.guide!.decision,
            rating: 'quick_browse',
            score: 42,
            verdict: '快速浏览即可。',
            worthReasons: ['理由 1', '理由 2', '理由 3', '理由 4'],
            notFor: ['不适合 1', '不适合 2', '不适合 3', '不适合 4'],
            reservations: ['保留 1', '保留 2', '保留 3', '保留 4'],
          },
        },
      },
    });

    expect(screen.queryByText('快速浏览')).toBeNull();
    expect(screen.getByText('理由 3')).toBeDefined();
    expect(screen.queryByText('理由 4')).toBeNull();
    expect(screen.getByText('不适合 3')).toBeDefined();
    expect(screen.queryByText('不适合 4')).toBeNull();
    expect(screen.getByText('保留 3')).toBeDefined();
    expect(screen.queryByText('保留 4')).toBeNull();
  });

  it('旧缓存的最低观看等级不会恢复为用户可见裁决', () => {
    renderAnalysis({
      session: {
        ...SESSION,
        guide: {
          ...SESSION.guide!,
          decision: {
            ...SESSION.guide!.decision,
            rating: 'skip',
            score: 18,
            verdict: '可以跳过。',
          },
        },
      },
    });

    expect(screen.queryByText('可以跳过')).toBeNull();
    expect(screen.queryByText('不建议看')).toBeNull();
  });
});

describe('NotesTab', () => {
  it('无内容底座时只显示笔记准备入口', () => {
    const props = renderNotes({ session: null, hasContentContext: false });
    fireEvent.click(screen.getByRole('button', { name: '开启笔记' }));
    expect(props.onPrepareContentContext).toHaveBeenCalledTimes(1);
  });

  it('加入笔记只保存当前记录，不显示旧问导师动作', async () => {
    const props = renderNotes();
    fireEvent.change(screen.getByTestId('learning-note-input'), {
      target: { value: '这里的方法值得之后复用' },
    });
    fireEvent.click(screen.getByRole('button', { name: '加入笔记' }));

    await waitFor(() => {
      expect(props.onAddMoment).toHaveBeenCalledWith({
        kind: 'note',
        content: '这里的方法值得之后复用',
        timestamp: 530,
      });
    });
    expect(screen.queryByRole('button', { name: '问导师' })).toBeNull();
    expect(screen.queryByRole('button', { name: '补充判断' })).toBeNull();
  });

  it('只展示已加入笔记的问答，并允许移出', () => {
    const props = renderNotes();
    expect(screen.getByText('已加入笔记的问答')).toBeDefined();
    expect(screen.getByText('1/8')).toBeDefined();
    expect(screen.getAllByText(/这一段值得看吗/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/普通问答会进笔记吗/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '移出笔记' }));
    expect(props.onToggleExchangeInReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      false,
    );
  });

  it('学习笔记按五块结构展示并允许导出', () => {
    const props = renderNotes();
    expect(screen.getByText('1. 视频讲了什么')).toBeDefined();
    expect(screen.getByText('2. 我得到了什么')).toBeDefined();
    expect(screen.getByText('我可以根据这个做什么')).toBeDefined();
    expect(screen.getByText('下一步怎么做')).toBeDefined();
    expect(screen.getByText('我可以把任务拆解迁移到自己的项目启动流程里。')).toBeDefined();
    expect(screen.getByText('3. 哪些观点值得参考')).toBeDefined();
    expect(screen.getByText('4. 哪些我需要保留判断')).toBeDefined();
    expect(screen.getByText('5. 我的记录')).toBeDefined();
    expect(screen.queryByText('2. 我加入的内容')).toBeNull();
    expect(screen.queryByText('如果要继续')).toBeNull();
    expect(screen.queryByText('可以尝试')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown 笔记' }));
    expect(props.onExport).toHaveBeenCalledTimes(1);
  });
});
