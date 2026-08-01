import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { MarkdownMessage } from '@extension/sidepanel/MarkdownMessage';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MarkdownMessage (Round 14 必修 1)', () => {
  it('测试 1：assistant Markdown **加粗** 不显示原始星号，表格渲染为 <table>', () => {
    const { container } = render(
      <MarkdownMessage
        content={
          '**重点**结论：\n\n' +
          '| 维度 | 评分 |\n' +
          '| ---- | ---- |\n' +
          '| 清晰 | 9 |\n' +
          '| 完整 | 8 |\n'
        }
      />,
    );

    // 1. 原始星号不能出现在文本里
    expect(container.textContent).not.toMatch(/\*\*/);
    // 2. 表格必须真的渲染成 <table>
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    // 3. 表格外层包了横向滚动容器（验收点 #3）
    const scrollWrap = table?.parentElement;
    expect(scrollWrap?.className).toMatch(/overflow-x-auto/);
    // 4. 加粗的"重点"在 strong 标签里
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('重点');
  });

  it('测试 2：原始 HTML 不被当成 HTML 执行或插入', () => {
    const { container } = render(
      <MarkdownMessage
        content={
          '段落 1\n\n' +
          '<script>window.__mdXss = true;</script>\n\n' +
          '段落 2 <img src=x onerror="window.__mdImgXss = true"> 段落 3'
        }
      />,
    );

    // 1. 危险 side-effect 不能跑
    expect((window as unknown as { __mdXss?: boolean }).__mdXss).toBeUndefined();
    expect((window as unknown as { __mdImgXss?: boolean }).__mdImgXss).toBeUndefined();
    // 2. 不应有 <script> 节点注入到 DOM
    expect(container.querySelector('script')).toBeNull();
    // 3. 不应有 <img> 节点（raw HTML 被 skipHtml 丢弃）
    expect(container.querySelector('img')).toBeNull();
    // 4. 文本节点里没有 <script> 这种原始标签被当作文本渲染（避免和真实 markdown 段落混在一起引起视觉混淆）
    //    注意：react-markdown 的 skipHtml 行为是直接丢弃 raw HTML 节点（包括它的 inner text）。
    //    段落 1 / 段落 2 ... 段落 3 三个纯文本段仍能渲染。
    expect(container.textContent).toContain('段落 1');
    expect(container.textContent).toContain('段落 3');
    expect(container.textContent).not.toContain('<script>');
  });

  it('测试 2.5：javascript: 协议链接被 urlTransform 过滤', () => {
    const { container } = render(
      <MarkdownMessage
        content={'[坏链接](javascript:alert(1)) 和 [好链接](https://example.com)'}
      />,
    );
    const links = Array.from(container.querySelectorAll('a'));
    // 坏链接要么被过滤（href=""）要么被移除
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      expect(href.toLowerCase()).not.toMatch(/^javascript:/);
    }
  });

  it('测试 1.5：空 content 不渲染任何节点（防御 0-length）', () => {
    const { container } = render(<MarkdownMessage content="" />);
    // 防御：0-length content 不进 react-markdown（避免空 <p></p> 等奇怪节点）
    expect(container.firstChild).toBeNull();
  });

  it('测试 1.6：isStreaming=true 时末尾追加 ▍ 光标', () => {
    const { container, rerender } = render(
      <MarkdownMessage content="hello" isStreaming={false} />,
    );
    expect(container.textContent).not.toMatch(/▍/);
    rerender(<MarkdownMessage content="hello" isStreaming={true} />);
    expect(container.textContent).toMatch(/▍/);
  });

  it('测试 1.7：fenced code block 不被撑爆侧边栏（pre 上 overflow-x-auto）', () => {
    const { container } = render(
      <MarkdownMessage
        content={
          '```js\n' +
          'const aVeryLongLine = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";\n' +
          '```\n'
        }
      />,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.className).toMatch(/overflow-x-auto/);
  });

  // 防御 React strict mode 下 act 警告
  it('act 包裹：单测自身在 act 内执行', () => {
    act(() => {
      render(<MarkdownMessage content="hi" />);
    });
  });
});

describe('MarkdownMessage (Round 16 必修 3 可点击时间点)', () => {
  it('渲染 [03:20] 为可点击 button，点击时向前预留 1 秒', () => {
    const onSeekTimestamp = vi.fn();
    const { container } = render(
      <MarkdownMessage
        content="在 [03:20] 这段视频讲过 BM25"
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    const button = container.querySelector('button[data-bai-seek-seconds="199"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('03:20');
    act(() => {
      fireEvent.click(button as HTMLElement);
    });
    expect(onSeekTimestamp).toHaveBeenCalledWith(199);
  });

  it('[03:20-04:10] 点击传开始时间向前 1 秒', () => {
    const onSeekTimestamp = vi.fn();
    const { container } = render(
      <MarkdownMessage
        content="看 [03:20-04:10] 这段"
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    const button = container.querySelector('button[data-bai-seek-seconds="199"]');
    expect(button).not.toBeNull();
    act(() => {
      fireEvent.click(button as HTMLElement);
    });
    expect(onSeekTimestamp).toHaveBeenCalledWith(199);
  });

  it('[1:02:11] 点击传 3730（开始时间向前 1 秒）', () => {
    const onSeekTimestamp = vi.fn();
    const { container } = render(
      <MarkdownMessage
        content="看 [1:02:11] 这段"
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    const button = container.querySelector('button[data-bai-seek-seconds="3730"]');
    expect(button).not.toBeNull();
    act(() => {
      fireEvent.click(button as HTMLElement);
    });
    expect(onSeekTimestamp).toHaveBeenCalledWith(3730);
  });

  it('普通外链仍走 _blank rel=noopener', () => {
    const { container } = render(
      <MarkdownMessage content="看 [外链](https://example.com) 这段" />,
    );
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toMatch(/noopener/);
  });

  it('javascript: 仍被 urlTransform 过滤（不变成可点击的 bAI 链接）', () => {
    const onSeekTimestamp = vi.fn();
    const { container } = render(
      <MarkdownMessage
        content="[坏](javascript:alert(1)) 链接"
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    // 不应有 bai-seek 链接
    expect(container.querySelector('button[data-bai-seek-seconds]')).toBeNull();
    // 不应有 javascript: href
    const anchors = Array.from(container.querySelectorAll('a'));
    for (const a of anchors) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
  });

  it('代码块内的时间点不被改写', () => {
    const onSeekTimestamp = vi.fn();
    const { container } = render(
      <MarkdownMessage
        content={'```js\nconst t = "[03:20]";\n```\n真正的时间点：[05:40]'}
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    // 只应该有一个 bai-seek button（对应 [05:40]，点击向前预留 1 秒）
    const buttons = container.querySelectorAll('button[data-bai-seek-seconds]');
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.getAttribute('data-bai-seek-seconds')).toBe('339');
  });

  it('没传 onSeekTimestamp 时 bAI 链接渲染为 span 不报错', () => {
    const { container } = render(
      <MarkdownMessage content="看 [03:20] 这段" />,
    );
    // 不应有 button
    expect(container.querySelector('button[data-bai-seek-seconds]')).toBeNull();
    // 应有 span 包含 03:20 文本
    expect(container.textContent).toContain('03:20');
  });
});
