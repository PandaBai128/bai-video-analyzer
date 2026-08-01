import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  TimelineDisplay,
  TimelineOverviewBlock,
  TimelineChapterBlock,
  TimelineSegmentList,
  mapVideoChaptersToDisplay,
  mapDraftChaptersToDisplay,
  type TimelineDisplayChapterView,
} from '@extension/sidepanel/TimelineDisplay';
import type { VideoChapter } from '@core/types';

const SAMPLE_CHAPTERS: TimelineDisplayChapterView[] = [
  {
    id: 'c1',
    title: '开场与问题提出',
    summary: '引出本视频要讨论的核心问题。',
    timestamp: 0,
    endTimestamp: 60,
    importance: 'must-watch',
    watchGuide: '先看这里确认视频是否回答你的问题。',
    reflectionPrompt: '判断这个问题是不是你要解决的。',
    segments: [
      {
        id: 'c1-s1',
        title: '提出问题',
        summary: '先抛出 3 个疑问。',
        timestamp: 0,
        endTimestamp: 20,
        importance: 'must-watch',
        reasoning: '这里定义了后面判断的目标。',
        watchPrompt: '认真看，确认问题是否与你相关。',
      },
      {
        id: 'c1-s2',
        title: '补充背景',
        summary: '简要交代研究背景。',
        timestamp: 20,
        endTimestamp: 60,
      },
    ],
  },
  {
    id: 'c2',
    title: '核心论证',
    summary: '从 3 个角度展开分析。',
    timestamp: 60,
    endTimestamp: 180,
    segments: [],
  },
];

describe('TimelineDisplay (Round 24 QA3 必修 A 共享展示组件)', () => {
  describe('mode=final', () => {
    it('渲染 overview + chapter 卡片 + 编号（最终态层级清晰）', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="这个视频主要讲测试主题"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      expect(screen.getByTestId('timeline-display')).toHaveAttribute('data-mode', 'final');
      // overview
      expect(screen.getByText('这个视频主要讲测试主题')).toBeInTheDocument();
      // 章节标题
      expect(screen.getByText('开场与问题提出')).toBeInTheDocument();
      expect(screen.getByText('核心论证')).toBeInTheDocument();
      // 章节编号（"01 / 02"）
      const numbers = screen.getAllByTestId('timeline-chapter-number');
      expect(numbers).toHaveLength(2);
      expect(numbers[0]).toHaveTextContent('01');
      expect(numbers[1]).toHaveTextContent('02');
      // 章节时间 badge
      expect(screen.getByText('0:00-1:00')).toBeInTheDocument();
      expect(screen.getByText('1:00-3:00')).toBeInTheDocument();
      expect(screen.getAllByTestId('timeline-value-tag')[0]).toHaveTextContent('重点');
    });

    it('展开章节时轻量展示原因和操作，但不提供时间线加入笔记', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="这个视频主要讲测试主题"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={0}
          expandedChapterIndex={0}
          activeSegmentIndex={0}
        />,
      );

      expect(screen.getByTestId('timeline-chapter-decision')).toHaveTextContent(
        '先看这里确认视频是否回答你的问题。',
      );
      expect(screen.getByTestId('timeline-segment-decision')).toHaveTextContent(
        '这里定义了后面判断的目标。',
      );
      expect(screen.getByTestId('timeline-segment-decision')).toHaveTextContent(
        '认真看，确认问题是否与你相关。',
      );
      expect(screen.queryByRole('button', { name: '加入笔记' })).toBeNull();
    });

    it('小节详情有独立展开 / 收起按钮和真实高度动画容器', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="这个视频主要讲测试主题"
          chapters={[
            {
              id: 'c1',
              title: '开场与问题提出',
              summary: '引出本视频要讨论的核心问题。',
              timestamp: 0,
              segments: [
                {
                  id: 'c1-s1',
                  title: '提出问题',
                  summary: '先抛出 3 个疑问。',
                  timestamp: 0,
                  importance: 'recommended',
                  reasoning: '这里定义了后面判断的目标。',
                  watchPrompt: '认真看，确认问题是否与你相关。',
                },
              ],
            },
          ]}
          activeChapterIndex={-1}
          expandedChapterIndex={0}
          activeSegmentIndex={-1}
          onSeekSegment={vi.fn()}
        />,
      );

      const segmentToggle = screen.getByTestId('timeline-segment-toggle');
      expect(segmentToggle).toHaveTextContent('展开');
      expect(segmentToggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('timeline-segment-expanded-region')).toBeNull();

      fireEvent.click(segmentToggle);

      expect(segmentToggle).toHaveTextContent('收起');
      expect(segmentToggle).toHaveAttribute('aria-expanded', 'true');
      const expandedRegion = screen.getByTestId('timeline-segment-expanded-region');
      expect(expandedRegion.className).toContain('grid');
      expect(expandedRegion.className).toContain('transition-[grid-template-rows,opacity,transform]');
      expect(screen.getByTestId('timeline-segment-decision')).toHaveTextContent(
        '这里定义了后面判断的目标。',
      );

      fireEvent.click(segmentToggle);

      expect(segmentToggle).toHaveTextContent('展开');
      expect(segmentToggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByTestId('timeline-segment-expanded-region')).toHaveAttribute(
        'data-open',
        'false',
      );
    });

    it('优先级和内容类型分开显示，默认可看不显示优先级标签', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={[
            {
              id: 'method-chapter',
              title: '方法演示章节',
              summary: '这一章演示完整流程。',
              timestamp: 0,
              importance: 'recommended',
              contentTag: 'method',
              watchGuide: '建议看这一章，关注它和前后内容的关系。',
              segments: [
                {
                  id: 'method-segment',
                  title: '自动生成设计稿',
                  summary: '讲具体步骤。',
                  timestamp: 0,
                  importance: 'recommended',
                  contentTag: 'demo',
                },
              ],
            },
          ]}
          expandedChapterIndex={0}
        />,
      );

      expect(screen.queryByTestId('timeline-value-tag')).toBeNull();
      expect(screen.getByTestId('timeline-content-tag')).toHaveTextContent('方法');
      expect(screen.getByTestId('timeline-segment-content-tag')).toHaveTextContent('演示');
      expect(screen.queryByTestId('timeline-segment-value-tag')).toBeNull();
      expect(screen.queryByTestId('timeline-chapter-decision')).toBeNull();
      expect(screen.queryByTestId('timeline-segment-decision')).toBeNull();
    });

    it('攻略类旧缓存纠正高置信误标，并把 optional 显示为选看', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={[
            {
              id: 'operation',
              title: '后台C与操作要点',
              summary: '说明输出循环和操作技巧。',
              timestamp: 0,
              importance: 'optional',
              contentTag: 'experience',
              segments: [],
            },
            {
              id: 'build',
              title: '专武与影画提升',
              summary: '解析专武、装备与影画配置。',
              timestamp: 60,
              importance: 'recommended',
              contentTag: 'tool',
              segments: [],
            },
            {
              id: 'combat',
              title: '实战演示与结尾',
              summary: '展示完整实战过程并在最后收尾。',
              timestamp: 120,
              importance: 'recommended',
              contentTag: 'transition',
              segments: [],
            },
            {
              id: 'experience',
              title: '作者实战心得',
              summary: '分享长期使用后的个人体会。',
              timestamp: 180,
              importance: 'recommended',
              contentTag: 'experience',
              segments: [],
            },
            {
              id: 'tool',
              title: '伤害计算工具介绍',
              summary: '介绍外部网站的计算功能。',
              timestamp: 240,
              importance: 'recommended',
              contentTag: 'tool',
              segments: [],
            },
            {
              id: 'transition',
              title: '过渡到下一部分',
              summary: '简短引出后续内容。',
              timestamp: 300,
              importance: 'recommended',
              contentTag: 'transition',
              segments: [],
            },
          ]}
        />,
      );

      expect(screen.getByText('选看')).toBeDefined();
      expect(screen.getByText('方法')).toBeDefined();
      expect(screen.getByText('配置')).toBeDefined();
      expect(screen.getByText('演示')).toBeDefined();
      expect(screen.getByText('经验')).toBeDefined();
      expect(screen.getByText('工具')).toBeDefined();
      expect(screen.getByText('过渡')).toBeDefined();
      expect(screen.queryByText('轻放')).toBeNull();
      expect(screen.queryByText('分享')).toBeNull();
      expect(screen.queryByText('铺垫')).toBeNull();
    });

    it('章节编号 ≥10 仍正常显示（不自适应补 0）', () => {
      const chapters: TimelineDisplayChapterView[] = Array.from(
        { length: 12 },
        (_, i) => ({
          id: `c${i + 1}`,
          title: `第 ${i + 1} 章`,
          summary: `summary ${i + 1}`,
          timestamp: i * 60,
          endTimestamp: (i + 1) * 60,
          segments: [],
        }),
      );
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={chapters}
        />,
      );
      const numbers = screen.getAllByTestId('timeline-chapter-number');
      // 10 / 11 / 12 不加 0
      expect(numbers[9]).toHaveTextContent('10');
      expect(numbers[10]).toHaveTextContent('11');
      expect(numbers[11]).toHaveTextContent('12');
    });

    it('估计时间线提示不要误认为字幕级精确跳转', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          timeAccuracy="estimated"
        />,
      );

      expect(screen.getByTestId('timeline-estimated-time-notice')).toHaveTextContent(
        '当前时间点来自旧缓存的模型估计',
      );
      expect(screen.getByText('约 0:00-1:00')).toBeInTheDocument();
      expect(screen.getByText('约 1:00-3:00')).toBeInTheDocument();
    });

    it('onSeekChapter 回调在 chapter 点击时触发（含 timestamp）', () => {
      const onSeekChapter = vi.fn();
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
          onSeekChapter={onSeekChapter}
        />,
      );
      // 点击第一个章节 meta button（章节 seek 触发点；QA5 必修 A 第一行左侧）
      const seekButtons = screen.getAllByTestId('timeline-chapter-seek');
      fireEvent.click(seekButtons[0]!);
      expect(onSeekChapter).toHaveBeenCalledTimes(1);
      const called = onSeekChapter.mock.calls[0]!;
      expect(called[0]?.title).toBe('开场与问题提出');
      expect(called[1]).toBe(0);
    });

    it('onToggleChapter 切换 expandedChapterIndex', () => {
      const onToggle = vi.fn();
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={0}
          activeSegmentIndex={-1}
          onToggleChapter={onToggle}
        />,
      );
      const toggleButton = screen.getAllByTestId('timeline-chapter-toggle')[0]!;
      fireEvent.click(toggleButton);
      expect(onToggle).toHaveBeenCalledWith(0);
    });

    it('展开章节时渲染 segment 列表（编号 1.1 / 1.2 / 时间 / 标题 / 摘要两行）', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={0}
          activeSegmentIndex={-1}
        />,
      );
      // 第 0 章展开 → 显示其 segments
      const segItems = screen.getAllByTestId('timeline-segment-item');
      expect(segItems).toHaveLength(2);
      // segment 编号 1.1 / 1.2
      const segNumbers = screen.getAllByTestId('timeline-segment-number');
      expect(segNumbers[0]).toHaveTextContent('1.1');
      expect(segNumbers[1]).toHaveTextContent('1.2');
      // segment 时间 badge
      expect(screen.getByText('0:00-0:20')).toBeInTheDocument();
      expect(screen.getByText('0:20-1:00')).toBeInTheDocument();
      // segment 标题 / 摘要分两行
      expect(screen.getByText('提出问题')).toBeInTheDocument();
      expect(screen.getByText('先抛出 3 个疑问。')).toBeInTheDocument();
      // 第 1 章不展开 → 不显示其 segments（segments: []）
      const segItemsAfter1 = screen.getAllByTestId('timeline-segment-item');
      expect(segItemsAfter1).toHaveLength(2);
    });

    it('活跃章节用状态条高亮，不再叠外圈 ring', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={0}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      const chapterBlocks = screen.getAllByTestId('timeline-chapter-block');
      const chapterSeeks = screen.getAllByTestId('timeline-chapter-seek');
      expect(chapterBlocks[0]).toHaveAttribute('data-active', 'true');
      expect(chapterBlocks[0]?.getAttribute('class')).toContain('bai-timeline-chapter-active');
      expect(chapterBlocks[0]?.getAttribute('class')).not.toContain('ring-1');
      expect(chapterSeeks[0]?.getAttribute('class')).toContain('bai-timeline-chapter-seek');
      expect(chapterBlocks[1]).toHaveAttribute('data-active', 'false');
    });

    it('活跃小节加状态类和左侧高亮', () => {
      render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={0}
          expandedChapterIndex={0}
          activeSegmentIndex={0}
        />,
      );
      const segItems = screen.getAllByTestId('timeline-segment-item');
      const segSeeks = screen.getAllByTestId('timeline-segment-seek');
      expect(segItems[0]).toHaveAttribute('data-active', 'true');
      expect(segItems[0]?.getAttribute('class')).toContain('bai-timeline-segment-active');
      expect(segSeeks[0]?.getAttribute('class')).toContain('bai-timeline-segment-seek');
      expect(segItems[1]).toHaveAttribute('data-active', 'false');
    });
  });

  describe('mode=streaming', () => {
    it('流式态：弱化点击（disabled / cursor-default）', () => {
      const onSeekChapter = vi.fn();
      render(
        <TimelineDisplay
          mode="streaming"
          overview="草稿主题"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
          onSeekChapter={onSeekChapter}
        />,
      );
      expect(screen.getByTestId('timeline-display')).toHaveAttribute('data-mode', 'streaming');
      // 流式态章节不可点击（disabled）
      const seekButtons = screen.getAllByTestId('timeline-chapter-seek');
      expect(seekButtons[0]).toBeDisabled();
      // 弱化点击**不**触发 onSeekChapter 回调
      fireEvent.click(seekButtons[0]!);
      expect(onSeekChapter).not.toHaveBeenCalled();
    });

    it('流式态**不**渲染展开按钮（避免流式态点击 toggle 误操作）', () => {
      const onToggle = vi.fn();
      render(
        <TimelineDisplay
          mode="streaming"
          overview="草稿"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
          onToggleChapter={onToggle}
        />,
      );
      expect(screen.queryByTestId('timeline-chapter-toggle')).toBeNull();
    });

    it('流式态默认不展开 segments（segments 不可见）', () => {
      render(
        <TimelineDisplay
          mode="streaming"
          overview="草稿"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      expect(screen.queryByTestId('timeline-segment-item')).toBeNull();
    });

    it('流式态未到达的章节显示占位（"暂无章节" / "正在识别章节…"）', () => {
      render(
        <TimelineDisplay
          mode="streaming"
          overview={null}
          chapters={[]}
        />,
      );
      // 空状态显示"正在识别章节…"
      expect(screen.getByTestId('timeline-empty-state')).toHaveTextContent('正在识别章节');
    });

    it('placeholderSegmentCount 渲染占位（最后章节 + streaming mode）', () => {
      render(
        <TimelineDisplay
          mode="streaming"
          overview="草稿"
          chapters={[SAMPLE_CHAPTERS[0]!]}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
          placeholderSegmentCount={3}
        />,
      );
      // 最后一个章节的占位
      const placeholders = screen.getAllByTestId('timeline-segment-placeholder');
      expect(placeholders).toHaveLength(1);
      expect(placeholders[0]).toHaveTextContent('继续生成中');
    });
  });

  describe('空状态', () => {
    it('mode=final + 0 章 → 显示"暂无章节"', () => {
      render(<TimelineDisplay mode="final" overview="x" chapters={[]} />);
      expect(screen.getByTestId('timeline-empty-state')).toHaveTextContent('暂无章节');
    });

    it('overview=null + mode=final → 显示"（无内容）"', () => {
      render(<TimelineDisplay mode="final" overview={null} chapters={[]} />);
      expect(screen.getByText(/无内容/)).toBeInTheDocument();
    });

    it('overview=null + mode=streaming → 显示"正在生成视频核心…"（**不**再有"草稿"字样）', () => {
      render(<TimelineDisplay mode="streaming" overview={null} chapters={[]} />);
      expect(screen.getByText(/正在生成视频核心/)).toBeInTheDocument();
      // 反向断言：**不**再有"草稿生成中" / "（草稿生成中）"
      expect(screen.queryByText(/草稿生成中/)).toBeNull();
    });
  });

  describe('必修 A 验收', () => {
    it('流式 / 最终 / 任何模式下都不出现 <pre> 原始 JSON', () => {
      const { container: c1 } = render(
        <TimelineDisplay mode="streaming" overview="草稿" chapters={SAMPLE_CHAPTERS} />,
      );
      const { container: c2 } = render(
        <TimelineDisplay mode="final" overview="x" chapters={SAMPLE_CHAPTERS} />,
      );
      for (const c of [c1, c2]) {
        // 抽所有 <pre> 元素 + 文本，**不**含 `{"type"` / `"chapters"` 特征
        const allText = c.textContent ?? '';
        expect(allText).not.toContain('{"type"');
        expect(allText).not.toContain('"chapters"');
      }
    });
  });
});

describe('mapVideoChaptersToDisplay (Round 24 QA3 必修 A 共享转换 helper)', () => {
  it('VideoChapter[] → TimelineDisplayChapterView[]（含 timestamp + 嵌套 segments）', () => {
    const chapters: VideoChapter[] = [
      {
        timestamp: 0,
        endTimestamp: 60,
        title: 'C1',
        summary: 'S1',
        importance: 'recommended',
        watchGuide: '',
        segments: [
          {
            timestamp: 0,
            endTimestamp: 30,
            title: 'seg1',
            summary: 'seg summary',
            importance: 'recommended',
          },
        ],
      },
    ];
    const result = mapVideoChaptersToDisplay(chapters);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('C1');
    expect(result[0]?.timestamp).toBe(0);
    expect(result[0]?.endTimestamp).toBe(60);
    expect(result[0]?.segments).toHaveLength(1);
    expect(result[0]?.segments[0]?.title).toBe('seg1');
    expect(result[0]?.segments[0]?.timestamp).toBe(0);
  });

  it('endTimestamp 缺省时不写到 view（exactOptionalPropertyTypes 兼容）', () => {
    const chapters: VideoChapter[] = [
      {
        timestamp: 0,
        // endTimestamp 缺省
        title: 'C1',
        summary: 'S1',
        importance: 'recommended',
        watchGuide: '',
        segments: [],
      },
    ];
    const result = mapVideoChaptersToDisplay(chapters);
    expect(result[0]?.endTimestamp).toBeUndefined();
    expect('endTimestamp' in result[0]!).toBe(false);
  });
});

describe('mapDraftChaptersToDisplay (Round 24 QA3 必修 A 流式草稿 helper)', () => {
  it('TimelineStreamingChapterDraft[] → TimelineDisplayChapterView[]', () => {
    const drafts = [
      {
        id: 'c1',
        title: 'draft 1',
        summary: 'draft summary 1',
        importance: 'recommended' as const,
        contentTag: 'method' as const,
        segments: [
          { title: 'seg1', summary: 'seg summary', contentTag: 'demo' as const },
        ],
      },
    ];
    const result = mapDraftChaptersToDisplay(drafts);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
    expect(result[0]?.title).toBe('draft 1');
    expect(result[0]?.contentTag).toBe('method');
    expect(result[0]?.segments).toHaveLength(1);
    expect(result[0]?.segments[0]?.contentTag).toBe('demo');
  });
});

describe('TimelineOverviewBlock (独立测)', () => {
  it('overview 非空 → 显示文本', () => {
    render(<TimelineOverviewBlock overview="视频核心文本" mode="final" isComplete={true} />);
    expect(screen.getByText('视频核心文本')).toBeInTheDocument();
  });
});

describe('TimelineChapterBlock (独立测)', () => {
  it('mode=streaming + 草稿块不显示展开按钮（onToggleChapter 不传时不显示）', () => {
    render(
      <TimelineChapterBlock
        chapter={SAMPLE_CHAPTERS[0]!}
        chapterNumber={1}
        totalChapters={2}
        mode="streaming"
        isActive={false}
        isExpanded={false}
        activeSegmentIndex={-1}
        onSeekChapter={undefined}
        onToggleChapter={undefined}
        onSeekSegment={undefined}
        placeholderSegmentCount={0}
      />,
    );
    expect(screen.queryByTestId('timeline-chapter-toggle')).toBeNull();
  });
});

describe('TimelineSegmentList (独立测)', () => {
  it('segments 为空时渲染空 ol', () => {
    const { container } = render(
      <TimelineSegmentList
        segments={[]}
        chapterNumber={1}
        activeSegmentIndex={-1}
        onSeekSegment={undefined}
      />,
    );
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect(ol?.querySelectorAll('li')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round 24 QA4 必修 E：紧凑化约束（窄侧边栏）+ Round 24 QA5 必修 F：定稿
// ---------------------------------------------------------------------------

describe('Round 24 QA4 必修 C 紧凑化 (muted meta) + Round 24 QA5 必修 C 有效利用空间', () => {
  describe('小节紧凑化（muted meta 文本）', () => {
    it('小节编号 + 时间合成一个 muted meta 文本（timeline-segment-meta）', () => {
      // 验收：muted meta 文本**不**再分两个独立 badge
      //   旧版：两个 span 各带 `inline-flex shrink-0 items-center rounded-md ...`
      //   新版：单一 `p` 标签 + `font-mono text-[11px] text-muted-foreground`
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={0}
          activeSegmentIndex={-1}
        />,
      );
      const metaElements = container.querySelectorAll(
        '[data-testid="timeline-segment-meta"]',
      );
      expect(metaElements.length).toBe(2);
      // 第一个 segment 的 meta 文本：`1.1 · 0:00-0:20`
      expect(metaElements[0]?.textContent?.trim()).toBe('1.1 · 0:00-0:20');
      // meta 元素**不**再有 badge 风格（没有 inline-flex / rounded-md / bg-background）
      metaElements.forEach((meta) => {
        expect(meta.className).not.toMatch(/inline-flex/);
        expect(meta.className).not.toMatch(/rounded-md/);
        expect(meta.className).not.toMatch(/bg-background/);
      });
    });

    it('小节 list 去卡片化（去掉 bg-muted/30 背景 + 减小 padding）', () => {
      // 验收：list 容器**不**再有 `bg-muted/30 p-3`（紧凑化）
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={0}
          activeSegmentIndex={-1}
        />,
      );
      const list = container.querySelector('[data-testid="timeline-segment-list"]');
      expect(list).not.toBeNull();
      // **不**再 bg-muted/30
      expect(list?.className).not.toMatch(/bg-muted\/30/);
      // **不**再 p-3
      expect(list?.className).not.toMatch(/\bp-3\b/);
      // **不**再叠 border-l-2 + pl-3 + 内层 px-2（紧凑化后只有 border-l-2 pl-2）
    });
  });

  describe('必修 D：流式态不显示小节', () => {
    it('mode=streaming 渲染时 segments 不可见（即使是 chaptersDraft 含 segments）', () => {
      // 验收：handoff QA4 §7 可接受分支"流式态只显示章节，不显示小节"
      const draftChapters: TimelineDisplayChapterView[] = [
        {
          id: 'c1',
          title: '草稿章节 1',
          summary: '草稿 summary',
          segments: [
            {
              id: 'c1-s1',
              title: '草稿 segment',
              summary: '草稿 segment summary',
            },
          ],
        },
      ];
      render(
        <TimelineDisplay
          mode="streaming"
          overview="草稿"
          chapters={draftChapters}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      // 草稿态**不**渲染 segment 列表
      expect(screen.queryByTestId('timeline-segment-list')).toBeNull();
      expect(screen.queryByTestId('timeline-segment-item')).toBeNull();
      // 章节本身仍然渲染
      expect(screen.getByText('草稿章节 1')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Round 24 QA5 必修 F：定稿测试（覆盖 QA4 必修 A/B + 必修 A/B/C/D/E 全部）
// ---------------------------------------------------------------------------

describe('Round 24 QA5 必修 F: 章节布局定稿', () => {
  describe('必修 A：章节固定三段结构（Round 26B QA2 修订）', () => {
    it('QA2-A: 主 seek button 包含 meta / 标题 / 摘要（**不**再有 content-seek / title-seek / summary-seek 独立 button）', () => {
      // 验收：QA2 §3 主 seek button 覆盖编号 + 时间 + 标题 + 摘要
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      // 每个章节**唯一**一个主 seek button
      const mainSeeks = container.querySelectorAll(
        '[data-testid="timeline-chapter-seek"]',
      );
      expect(mainSeeks).toHaveLength(2);
      mainSeeks.forEach((btn) => {
        // 主 button **包含**编号 + 时间 + 标题 + 摘要（4 部分都在主 button 内）
        expect(btn.querySelector('[data-testid="timeline-chapter-number"]')).not.toBeNull();
        expect(btn.querySelector('[data-testid="timeline-chapter-time"]')).not.toBeNull();
        expect(btn.querySelector('[data-testid="timeline-chapter-title-row"]')).not.toBeNull();
        expect(btn.querySelector('[data-testid="timeline-chapter-summary-row"]')).not.toBeNull();
      });
      // **不**再有 content-seek / title-seek / summary-seek 独立 seek button
      expect(
        container.querySelector('[data-testid="timeline-chapter-content-seek"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="timeline-chapter-title-seek"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="timeline-chapter-summary-seek"]'),
      ).toBeNull();
    });

    it('QA2-A: 标题 / 摘要 / meta 是主 seek button 的子元素（**不**再是独立 row）', () => {
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      const mainSeeks = container.querySelectorAll(
        '[data-testid="timeline-chapter-seek"]',
      );
      // title / summary / number / time **全部**是主 button 的子元素
      mainSeeks.forEach((btn) => {
        const title = btn.querySelector(
          '[data-testid="timeline-chapter-title-row"]',
        );
        const summary = btn.querySelector(
          '[data-testid="timeline-chapter-summary-row"]',
        );
        const number = btn.querySelector(
          '[data-testid="timeline-chapter-number"]',
        );
        const time = btn.querySelector('[data-testid="timeline-chapter-time"]');
        expect(title).not.toBeNull();
        expect(summary).not.toBeNull();
        expect(number).not.toBeNull();
        expect(time).not.toBeNull();
      });
    });

    it('QA2-A: 主 seek button **不**含 toggle button（toggle 是兄弟节点**不**嵌套）', () => {
      // 验收：QA2 §3 展开按钮必须**不**嵌套在主 button 内
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
          onToggleChapter={vi.fn()}
        />,
      );
      const mainSeeks = container.querySelectorAll(
        '[data-testid="timeline-chapter-seek"]',
      );
      mainSeeks.forEach((btn) => {
        // 主 button 内**不**含 toggle button
        expect(
          btn.querySelector('[data-testid="timeline-chapter-toggle"]'),
        ).toBeNull();
      });
    });

    it('QA2-A: 章节容器 padding 控制在 px-2.5 py-2 左右', () => {
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      const chapterBlocks = container.querySelectorAll(
        '[data-testid="timeline-chapter-block"]',
      );
      chapterBlocks.forEach((block) => {
        const inner = block.firstElementChild as HTMLElement;
        expect(inner.className).toMatch(/\bpx-2\.5\b/);
        expect(inner.className).toMatch(/\bpy-2\b/);
      });
    });
  });

  describe('必修 B：展开按钮是"展开 / 收起"文本按钮（**不**是孤立 + / -）', () => {
    it('toggle 按钮文字是"展开" / "收起"（**不**是 + / -）', () => {
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={0} // 第 0 章展开
          activeSegmentIndex={-1}
          onToggleChapter={vi.fn()}
        />,
      );
      const toggleButtons = container.querySelectorAll(
        '[data-testid="timeline-chapter-toggle"]',
      );
      expect(toggleButtons.length).toBe(2);
      toggleButtons.forEach((btn, idx) => {
        // 第 0 章已展开 → 显示 "收起"；第 1 章折叠 → 显示 "展开"
        const expected = idx === 0 ? '收起' : '展开';
        expect(btn.textContent?.trim()).toBe(expected);
        // **不**是孤立 + / -
        expect(btn.textContent).not.toMatch(/^[+−-]$/);
      });
    });

    it('toggle 按钮**不**是 h-7 w-7 小图标（**不**是孤立右列）', () => {
      // 验收：QA5 §5 "去掉孤立 + / - 按钮" + §6 "不要继续显示孤立的 + / -"
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={0}
          activeSegmentIndex={-1}
          onToggleChapter={vi.fn()}
        />,
      );
      const toggleButtons = container.querySelectorAll(
        '[data-testid="timeline-chapter-toggle"]',
      );
      toggleButtons.forEach((btn) => {
        // **不**带 h-7 w-7（QA4 的小图标按钮）
        expect(btn.className).not.toMatch(/\bh-7\b/);
        expect(btn.className).not.toMatch(/\bw-7\b/);
        // 文字按钮样式（QA5 §5 推荐 className）：`shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent`
        expect(btn.className).toMatch(/\bshrink-0\b/);
        expect(btn.className).toMatch(/\btext-xs\b/);
        expect(btn.className).toMatch(/\btext-muted-foreground\b/);
      });
    });

    it('toggle 按钮**只**在第一行右侧（不缩窄标题行 / 摘要行）', () => {
      // 验收：QA5 §4 "展开控制只能占第一行"
      // 标题行 / 摘要行的父是章节内容容器（**不**和 toggle button 共享容器）
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={0}
          activeSegmentIndex={-1}
          onToggleChapter={vi.fn()}
        />,
      );
      const titleRows = container.querySelectorAll(
        '[data-testid="timeline-chapter-title-row"]',
      );
      titleRows.forEach((title) => {
        // 标题的最近容器**不**是 toggle button
        expect(title.closest('[data-testid="timeline-chapter-toggle"]')).toBeNull();
        // 标题的**直接**父容器**不**带 flex items-center justify-between
        // （标题行是 block 满宽，**不**和 toggle 同行）
        const parent = title.parentElement;
        expect(parent?.className).not.toMatch(/justify-between/);
      });
    });
  });

  describe('必修 D：导航头部**不**再有"草稿 / 已生成"徽章 + "N / N 章"计数', () => {
    it('导航头部**只**显示"导航" 标题（**不**再有 mode badge）', () => {
      // 验收：导航头部只保留入口名
      const { container } = render(
        <TimelineDisplay
          mode="final"
          overview="x"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      // **不**再有 timeline-mode-badge 元素
      expect(container.querySelector('[data-testid="timeline-mode-badge"]')).toBeNull();
      // **不**再有"N / N 章" 或 "N 章" 计数文本
      expect(container.textContent).not.toMatch(/\d+\s*\/\s*\d+\s*章/);
      expect(container.textContent).not.toMatch(/\d+\s*章/);
      // 头部**只**有"导航" h2
      const header = container.querySelector('[data-testid="timeline-header-title"]');
      expect(header).not.toBeNull();
      expect(header?.textContent).toBe('导航');
    });

    it('流式态头部**也**只显示"导航"（**不**再有 mode badge / 计数）', () => {
      const { container } = render(
        <TimelineDisplay
          mode="streaming"
          overview="草稿"
          chapters={SAMPLE_CHAPTERS}
          activeChapterIndex={-1}
          expandedChapterIndex={-1}
          activeSegmentIndex={-1}
        />,
      );
      // **不**再有 timeline-mode-badge
      expect(container.querySelector('[data-testid="timeline-mode-badge"]')).toBeNull();
      // 头部仍是"导航"
      const header = container.querySelector('[data-testid="timeline-header-title"]');
      expect(header?.textContent).toBe('导航');
    });
  });

  describe('必修 E：视频核心块**不**再出现"（草稿生成中）" / "草稿" 文本', () => {
    it('overview=null + mode=streaming → "正在生成视频核心…"（**不**是"草稿生成中"）', () => {
      // 验收：QA5 §7 "overview=null 时也不要显示"（草稿生成中）""
      const { container } = render(
        <TimelineDisplay
          mode="streaming"
          overview={null}
          chapters={[]}
        />,
      );
      expect(screen.getByText(/正在生成视频核心/)).toBeInTheDocument();
      // 反向断言：**不**再有"草稿生成中" 文本
      expect(container.textContent).not.toMatch(/草稿生成中/);
    });

    it('任何模式下**不**再出现独立"草稿" badge 文本', () => {
      const { container: c1 } = render(
        <TimelineDisplay mode="streaming" overview="草稿" chapters={SAMPLE_CHAPTERS} />,
      );
      const { container: c2 } = render(
        <TimelineDisplay mode="final" overview="x" chapters={SAMPLE_CHAPTERS} />,
      );
      for (const c of [c1, c2]) {
        // **不**再有 timeline-mode-badge 元素
        expect(c.querySelector('[data-testid="timeline-mode-badge"]')).toBeNull();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Round 26B QA2 返修：合**一个**主 seek button + 不自动展开 + 流式不重复
// ---------------------------------------------------------------------------

describe('Round 26B QA2 返修: 一个主 seek button + 不自动展开 + 流式不重复', () => {
  it('QA2-1: 每个章节最终态**只有**一个主 seek button', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
      />,
    );
    const mainSeeks = container.querySelectorAll(
      '[data-testid="timeline-chapter-seek"]',
    );
    expect(mainSeeks).toHaveLength(2);
    // **不**再有 content-seek / title-seek / summary-seek 任何第二层 seek
    expect(
      container.querySelector('[data-testid="timeline-chapter-content-seek"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="timeline-chapter-title-seek"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="timeline-chapter-summary-seek"]'),
    ).toBeNull();
  });

  it('QA2-2: 主 seek button 包含 meta（编号 + 时间）+ 标题 + 摘要', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
      />,
    );
    const mainSeeks = container.querySelectorAll(
      '[data-testid="timeline-chapter-seek"]',
    );
    mainSeeks.forEach((btn) => {
      expect(btn.querySelector('[data-testid="timeline-chapter-number"]')).not.toBeNull();
      expect(btn.querySelector('[data-testid="timeline-chapter-time"]')).not.toBeNull();
      expect(btn.querySelector('[data-testid="timeline-chapter-title-row"]')).not.toBeNull();
      expect(btn.querySelector('[data-testid="timeline-chapter-summary-row"]')).not.toBeNull();
    });
  });

  it('QA2-3: 主 seek button **不**含 toggle（toggle 是兄弟节点绝对定位）', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={vi.fn()}
      />,
    );
    const mainSeeks = container.querySelectorAll(
      '[data-testid="timeline-chapter-seek"]',
    );
    mainSeeks.forEach((btn) => {
      expect(
        btn.querySelector('[data-testid="timeline-chapter-toggle"]'),
      ).toBeNull();
    });
  });

  it('QA2-4: 主 seek button **不**含小节列表 / item', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={0} // 第 0 章展开
        activeSegmentIndex={-1}
      />,
    );
    const mainSeeks = container.querySelectorAll(
      '[data-testid="timeline-chapter-seek"]',
    );
    mainSeeks.forEach((btn) => {
      expect(btn.querySelector('[data-testid="timeline-segment-list"]')).toBeNull();
      expect(btn.querySelector('[data-testid="timeline-segment-item"]')).toBeNull();
    });
  });

  it('QA2-5: 主 seek button **不**含 h1-h6 / p（HTML 合法）', () => {
    // Round 26B 第一版用了 button 包 h3 / p（HTML 非法 + 自相矛盾）；
    // 改用 span + block class 替代。
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
      />,
    );
    const mainSeeks = container.querySelectorAll(
      '[data-testid="timeline-chapter-seek"]',
    );
    mainSeeks.forEach((btn) => {
      expect(btn.querySelector('h1, h2, h3, h4, h5, h6, p')).toBeNull();
    });
  });

  it('QA2-6: 点击主 seek button 触发 onSeekChapter（**不**带 source 参数）', () => {
    const onSeekChapter = vi.fn();
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onSeekChapter={onSeekChapter}
      />,
    );
    const mainSeeks = getAllByTestId('timeline-chapter-seek');
    fireEvent.click(mainSeeks[0]!);
    expect(onSeekChapter).toHaveBeenCalledTimes(1);
    const called = onSeekChapter.mock.calls[0]!;
    expect(called[0]?.title).toBe('开场与问题提出');
    expect(called[1]).toBe(0);
    // **不**传 source 参数（Round 26B QA2 删 source 分支）
    expect(called[2]).toBeUndefined();
  });

  it('QA2-7: 点击主 seek button 不会调 onToggleChapter（兄弟节点隔离）', () => {
    const onToggle = vi.fn();
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={onToggle}
      />,
    );
    const mainSeeks = getAllByTestId('timeline-chapter-seek');
    fireEvent.click(mainSeeks[0]!);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('QA2-8: 点击 toggle **不**触发 onSeekChapter（事件 stopPropagation 隔离）', () => {
    const onSeekChapter = vi.fn();
    const onToggle = vi.fn();
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onSeekChapter={onSeekChapter}
        onToggleChapter={onToggle}
      />,
    );
    const toggle = getAllByTestId('timeline-chapter-toggle')[0]!;
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(0);
    expect(onSeekChapter).not.toHaveBeenCalled();
  });

  it('QA2-9: 点击小节触发 onSeekSegment，**不**触发 onSeekChapter', () => {
    const onSeekChapter = vi.fn();
    const onSeekSegment = vi.fn();
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={0}
        activeSegmentIndex={-1}
        onSeekChapter={onSeekChapter}
        onSeekSegment={onSeekSegment}
      />,
    );
    const segmentSeeks = getAllByTestId('timeline-segment-seek');
    fireEvent.click(segmentSeeks[0]!);
    expect(onSeekSegment).toHaveBeenCalledTimes(1);
    expect(onSeekChapter).not.toHaveBeenCalled();
  });

  it('QA2-10: 流式态主 seek button disabled', () => {
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="streaming"
        overview="草稿"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
      />,
    );
    const mainSeeks = getAllByTestId('timeline-chapter-seek');
    expect(mainSeeks[0]).toBeDisabled();
    // 流式态 toggle **不**渲染
    expect(screen.queryByTestId('timeline-chapter-toggle')).toBeNull();
  });

  it('QA2-11: mode=final + 无 onSeekChapter 时主 seek button disabled', () => {
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
      />,
    );
    const mainSeeks = getAllByTestId('timeline-chapter-seek');
    expect(mainSeeks[0]).toBeDisabled();
  });

  it('QA2-12: toggle 按钮绝对定位在右上角（absolute right-2 top-2）', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={vi.fn()}
      />,
    );
    const toggles = container.querySelectorAll(
      '[data-testid="timeline-chapter-toggle"]',
    );
    toggles.forEach((btn) => {
      // **绝对定位**（不**和**主 button 同行 / 不用 flex 容器）
      expect(btn.className).toMatch(/\babsolute\b/);
      expect(btn.className).toMatch(/\bright-2\b/);
      expect(btn.className).toMatch(/\btop-2\b/);
    });
  });

  it('QA2-13: 章节容器**有** relative 定位（让 toggle absolute 相对容器）', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
      />,
    );
    // 章节块内**第一**个 div 是 relative 容器
    const chapterBlocks = container.querySelectorAll(
      '[data-testid="timeline-chapter-block"]',
    );
    chapterBlocks.forEach((block) => {
      const inner = block.firstElementChild as HTMLElement;
      expect(inner.className).toMatch(/\brelative\b/);
    });
  });
});

// ---------------------------------------------------------------------------
// Round 29A QA2 返修：主 button **不**带整体 pr-*（让标题/摘要用卡片完整宽度）
// 防止再以"缩 pr-14 → pr-12 → pr-10"冒充修复。
// ---------------------------------------------------------------------------

describe('Round 29A QA2 返修: 主 seek button 不带整体 pr-*（标题/摘要用卡片完整宽度）', () => {
  it('QA2-Fix-1: 主 seek button className **不**带 pr-*（整体 padding 已移除）', () => {
    // 验收：Round 29A QA2 必修 A — 不允许 pr-14 / pr-12 / pr-10 / 任何 pr-*
    // 让标题 / 摘要被压到左侧。
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={vi.fn()}
      />,
    );
    const mainSeeks = container.querySelectorAll(
      '[data-testid="timeline-chapter-seek"]',
    );
    expect(mainSeeks.length).toBeGreaterThan(0);
    mainSeeks.forEach((btn) => {
      const cls = btn.className;
      // **任何** pr-* 都不允许（包括历史 pr-14 / pr-12 / pr-10 等）
      expect(cls).not.toMatch(/\bpr-\d+\b/);
    });
  });

  it('QA2-Fix-2: 标题行 className **不**带 pr-*（用卡片剩余完整宽度）', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={vi.fn()}
      />,
    );
    const titleRows = container.querySelectorAll(
      '[data-testid="timeline-chapter-title-row"]',
    );
    expect(titleRows.length).toBeGreaterThan(0);
    titleRows.forEach((row) => {
      expect(row.className).not.toMatch(/\bpr-\d+\b/);
    });
  });

  it('QA2-Fix-3: 摘要行 className **不**带 pr-*（用卡片剩余完整宽度）', () => {
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={vi.fn()}
      />,
    );
    const summaryRows = container.querySelectorAll(
      '[data-testid="timeline-chapter-summary-row"]',
    );
    expect(summaryRows.length).toBeGreaterThan(0);
    summaryRows.forEach((row) => {
      expect(row.className).not.toMatch(/\bpr-\d+\b/);
    });
  });

  it('QA2-Fix-4: 第一行 meta 行（避开 toggle）必须带 pr-12', () => {
    // 验收：QA2-Fix 让 meta 行单独让出右侧空间（toggle 占用 ~48px），
    // 标题/摘要因此可以无 pr-* 使用完整宽度。
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={vi.fn()}
      />,
    );
    const metaRows = container.querySelectorAll(
      '[data-testid="timeline-chapter-meta-row"]',
    );
    expect(metaRows.length).toBeGreaterThan(0);
    metaRows.forEach((row) => {
      // meta 行必须 pr-12（避开右上角 toggle 按钮 ~32px + right-2 8px）
      expect(row.className).toMatch(/\bpr-12\b/);
    });
  });

  it('QA2-Fix-5: toggle 按钮仍是 absolute right-2 top-2（位置不变）', () => {
    // 验收：QA2-12 硬要求 toggle 绝对定位不变；本轮只是把 pr-* 从主
    // button 移到 meta 行，**不**改 toggle 位置。
    const { container } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onToggleChapter={vi.fn()}
      />,
    );
    const toggles = container.querySelectorAll(
      '[data-testid="timeline-chapter-toggle"]',
    );
    toggles.forEach((btn) => {
      expect(btn.className).toMatch(/\babsolute\b/);
      expect(btn.className).toMatch(/\bright-2\b/);
      expect(btn.className).toMatch(/\btop-2\b/);
    });
  });

  it('QA2-Fix-6: 点击主体仍触发 seek（click 语义不变）', () => {
    const onSeekChapter = vi.fn();
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onSeekChapter={onSeekChapter}
        onToggleChapter={vi.fn()}
      />,
    );
    const mainSeeks = getAllByTestId('timeline-chapter-seek');
    fireEvent.click(mainSeeks[0]!);
    expect(onSeekChapter).toHaveBeenCalledTimes(1);
  });

  it('QA2-Fix-7: 点击 toggle 仍只触发 toggle（**不**触发 seek）', () => {
    const onSeekChapter = vi.fn();
    const onToggle = vi.fn();
    const { getAllByTestId } = render(
      <TimelineDisplay
        mode="final"
        overview="x"
        chapters={SAMPLE_CHAPTERS}
        activeChapterIndex={-1}
        expandedChapterIndex={-1}
        activeSegmentIndex={-1}
        onSeekChapter={onSeekChapter}
        onToggleChapter={onToggle}
      />,
    );
    const toggle = getAllByTestId('timeline-chapter-toggle')[0]!;
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(0);
    expect(onSeekChapter).not.toHaveBeenCalled();
  });
});
