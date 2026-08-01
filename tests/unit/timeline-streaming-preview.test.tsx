import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  TimelineStreamingPreview,
  type TimelineStreamingChapterDraft,
} from '@extension/sidepanel/TimelineStreamingPreview';

const SAMPLE_CHAPTERS: readonly TimelineStreamingChapterDraft[] = [
  {
    id: 'c1',
    title: '开场与问题提出',
    summary: '引出本视频要讨论的核心问题。',
    segments: [
      { title: '提出问题', summary: '先抛出 3 个疑问。' },
      { title: '补充背景', summary: '简要交代研究背景。' },
    ],
  },
  {
    id: 'c2',
    title: '核心论证',
    summary: '从 3 个角度展开分析。',
    segments: [],
  },
];

describe('TimelineStreamingPreview (Round 24 QA2 必修 A+C: 不展示原始 JSON)', () => {
  it('isStreaming=false 时不渲染任何 DOM', () => {
    const { container } = render(
      <TimelineStreamingPreview
        isStreaming={false}
        status=""
        characterCount={0}
        overviewDraft={null}
        chaptersDraft={[]}
        chapterCount={0}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/正在生成导航/)).toBeNull();
  });

  it('isStreaming=true + 字符计数 0 时 summary 只显示"正在生成导航"（无误导性字数）', () => {
    // Round 24 QA2 必修 A + 必修 C：默认 UI 不显示"已接收 N 字"
    // 当 characterCount=0 时 —— 因为早期 partial 还没到，不要让
    // 用户以为"已接收 0 字 = 没开始"。
    render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={0}
        overviewDraft={null}
        chaptersDraft={[]}
        chapterCount={0}
      />,
    );
    expect(screen.getByText(/正在生成导航/)).toBeInTheDocument();
    expect(screen.getByText(/正在识别导航/)).toBeInTheDocument();
    expect(screen.queryByText(/正在识别时间线/)).toBeNull();
    // characterCount=0 时不显示"已接收 N 字"
    expect(screen.queryByText(/已接收 0 字/)).toBeNull();
  });

  it('isStreaming=true 时顶部显示停止按钮，点击触发取消生成', () => {
    const onCancel = vi.fn();
    render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={0}
        overviewDraft={null}
        chaptersDraft={[]}
        chapterCount={0}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '停止生成导航' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('isStreaming=true + characterCount=N 时 summary 显示"已接收 N 字"', () => {
    render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={1234}
        overviewDraft={null}
        chaptersDraft={[]}
        chapterCount={0}
      />,
    );
    expect(screen.getByText(/已接收 1234 字/)).toBeInTheDocument();
  });

  it('isStreaming=true + chapterCount=N 时 summary 显示"已识别 N 章"', () => {
    render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={100}
        overviewDraft={null}
        chaptersDraft={SAMPLE_CHAPTERS}
        chapterCount={2}
      />,
    );
    expect(screen.getByText(/已识别 2 章/)).toBeInTheDocument();
  });

  it('overviewDraft 非空时渲染"视频核心"块（共用 TimelineDisplay）', () => {
    render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={200}
        overviewDraft="这个视频主要讲时间管理。"
        chaptersDraft={[]}
        chapterCount={0}
      />,
    );
    // 必修 AQA3 必修 A：流式 / 最终复用 TimelineDisplay，所以"视频核心"块
    // 在流式态**也**有；区别是 mode=streaming 时显示"生成中…"占位 +
    // 草稿徽章
    expect(screen.getByText(/这个视频主要讲时间管理/)).toBeInTheDocument();
    // Round 24 QA5 必修 E：流式态**不**再显示独立"草稿"圆角 badge
    expect(screen.queryByText('草稿')).toBeNull();
  });

  it('chaptersDraft 非空时渲染 chapter 卡片（segments 默认折叠）', () => {
    // 必修 AQA3 必修 C + 必修 D：草稿态章节展示和最终态**同结构**
    // （左侧主色线 / 编号 / 时间 / 标题 / 摘要两行）；segments 默认
    // 折叠（按 handoff §6 "保持现有'一个章节展开'的交互即可"）。
    render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={500}
        overviewDraft={null}
        chaptersDraft={SAMPLE_CHAPTERS}
        chapterCount={2}
      />,
    );
    // 章节标题（必须显示）
    expect(screen.getByText('开场与问题提出')).toBeInTheDocument();
    expect(screen.getByText('核心论证')).toBeInTheDocument();
    // 章节 summary
    expect(screen.getByText(/引出本视频要讨论的核心问题/)).toBeInTheDocument();
    // 章节编号（必修 C：草稿态"01 / 02"等编号也存在）
    const numbers = screen.getAllByTestId('timeline-chapter-number');
    expect(numbers.length).toBe(2);
    // segments 默认不展开 → "提出问题" 文本不应出现
    expect(screen.queryByText('提出问题')).toBeNull();
  });

  it('必修 A：默认 UI（主 details 区）不展示任何原始 JSON 文本', () => {
    // handoff §3 必修 A：禁止默认展示原始 JSON。
    // 验证手段：调试 details 默认**关闭**（不带 open 属性），且 summary
    //   文案不暴露 JSON 特征。rawLinesForDebug 在调试 details 关闭时
    //   不会渲染到默认 UI。
    const { container } = render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={1000}
        overviewDraft="这个视频主要讲 AI 学习。"
        chaptersDraft={SAMPLE_CHAPTERS}
        chapterCount={2}
        rawLinesForDebug={[
          '{"type":"overview","text":"这个视频主要讲 AI 学习。"}',
          '{"type":"chapter","id":"c1","title":"开场"}',
        ]}
      />,
    );
    // 主区是 data-testid="timeline-streaming-preview" 的 details（默认 open）
    const mainDetailsElement = container.querySelector(
      '[data-testid="timeline-streaming-preview"]',
    ) as HTMLElement | null;
    expect(mainDetailsElement).not.toBeNull();
    // 验证：调试 details 默认**关闭**（不展开）—— 不带 [open] 属性
    const allDetails = Array.from(
      container.querySelectorAll('details'),
    ) as HTMLElement[];
    // 主 details（带 open）vs 调试 details（不带 open）
    const closedDetails = allDetails.filter((d) => !d.hasAttribute('open'));
    expect(closedDetails.length).toBeGreaterThanOrEqual(1);
    // 调试 details 应包含 rawLinesForDebug 拼接的 <pre> 文字
    const debugText = closedDetails[0]!.textContent ?? '';
    expect(debugText).toContain('调试输出');
    expect(debugText).toContain('{"type"'); // rawLinesForDebug 里有

    // 验证：用户能看到的主区（主 details 内的 summary + 兄弟节点）
    // 文字不暴露 JSON 特征
    const mainDetailsClone = mainDetailsElement!.cloneNode(true) as HTMLElement;
    // 拿主 details 的**直接子** text node + summary 文字（不算嵌套
    // details / pre）—— 用 cloneNode 移除嵌套 details 测 textContent
    mainDetailsClone.querySelectorAll('details').forEach((d) => d.remove());
    const mainVisibleText = mainDetailsClone.textContent ?? '';
    // 主区可见文字不暴露 JSON 特征（嵌套 details 移除后）
    expect(mainVisibleText).not.toContain('{"type"');
    expect(mainVisibleText).not.toContain('"chapters"');
    // 章节标题是结构化渲染（不是 JSON 文本）
    expect(mainVisibleText).toContain('开场与问题提出');
    expect(mainVisibleText).toContain('核心论证');
  });

  it('rawLinesForDebug 非空 + 默认调试折叠项关闭时调试输出不展开', () => {
    const { container } = render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={1000}
        overviewDraft={null}
        chaptersDraft={[]}
        chapterCount={0}
        rawLinesForDebug={['{"type":"chapter","id":"c1","title":"开场"}']}
      />,
    );
    // 调试 details 默认**不**带 open 属性
    const detailsNodes = container.querySelectorAll('details');
    // 有两个 details：外层主 details（open）+ 内层调试 details（默认关闭）
    // 用 :not([open]) 找调试 details
    const closedDetails = Array.from(detailsNodes).filter((d) => !d.hasAttribute('open'));
    expect(closedDetails.length).toBeGreaterThanOrEqual(1);
    // 调试 details 文字应是 rawLinesForDebug 拼接
    const debugDetails = closedDetails[0]!;
    const debugText = debugDetails.textContent ?? '';
    expect(debugText).toContain('调试输出');
    expect(debugText).toContain('chapter');
  });

  it('不依赖 analysisResult 入参（只接 isStreaming / status / characterCount / overviewDraft / chaptersDraft / chapterCount）', () => {
    // 验收：harness 不需要 PageContext / analysisResult / chrome.runtime。
    const { rerender } = render(
      <TimelineStreamingPreview
        isStreaming={true}
        status="正在识别时间线"
        characterCount={500}
        overviewDraft="视频核心"
        chaptersDraft={SAMPLE_CHAPTERS}
        chapterCount={2}
      />,
    );
    expect(screen.getByText(/正在生成导航/)).toBeInTheDocument();
    // isStreaming 翻 false → 立刻不渲染
    rerender(
      <TimelineStreamingPreview
        isStreaming={false}
        status=""
        characterCount={0}
        overviewDraft={null}
        chaptersDraft={[]}
        chapterCount={0}
      />,
    );
    expect(screen.queryByText(/正在生成导航/)).toBeNull();
  });
});
