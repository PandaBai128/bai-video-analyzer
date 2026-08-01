import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FollowupTab } from '@extension/sidepanel/FollowupTab';
import type { PlaybackState } from '@shared/playback-state';
import type { AnalysisMode } from '@shared/settings';
import {
  PLAYBACK,
  installChromePortStub,
  makeRequestIdFactory,
  uninstallChromePortStub,
  type FakePort,
} from './helpers/followup-test-harness';

/**
 * FollowupTab 页面组合测试（SG-04）。
 *
 * 本文件只覆盖 **页面组合 / no_context CTA / 错误 banner / root + scroll + composer
 * footer 结构 / 滚动策略**。Port 生命周期 / requestId / watchdog / intent 路由
 * / CHUNK / DONE / ERROR / disconnect / postMessage throw 已迁
 * tests/unit/use-followup-session.test.tsx。组件渲染（QuickQuestions / Messages /
 * Composer）的视觉 / 交互细节已迁 tests/unit/followup-components.test.tsx。
 *
 * 不在本文件重复上述断言，避免大型测试无意义膨胀。
 *
 * Source-contract：保留与原 followup-tab.test.tsx 等价的跨组件结构断言（root 布局 /
 * composer footer 末位 / scroll useLayoutEffect deps / 快捷问题 chip 化），但
 * 删除指向 FollowupTab.tsx 的实现位置断言（MAX_COMPOSER_ROWS / scrollHeight /
 * overflowY / useLayoutEffect / min-h-[36px]）—— 这些实现位置已迁到
 * followup/FollowupComposer.tsx，由 followup-components.test.tsx 覆盖。
 */

interface RenderHarness {
  port: FakePort;
}

function renderFollowupTab(options: {
  hasContentContext?: boolean;
  analysisMode?: AnalysisMode;
  contextKey?: string;
  requestIdFactory?: () => string;
  playbackState?: PlaybackState | null;
  selectedTimestamp?: number | null;
  initialDraft?: {
    readonly id: number;
    readonly text: string;
  };
} = {}): RenderHarness {
  const port = installChromePortStub();
  const props = {
    hasContentContext: options.hasContentContext ?? true,
    analysisMode: options.analysisMode ?? 'subtitle',
    playbackState: options.playbackState !== undefined ? options.playbackState : PLAYBACK,
    onPrepareContentContext: vi.fn(),
    contextKey: options.contextKey ?? 'ctx-1',
    ...(options.selectedTimestamp !== undefined ? { selectedTimestamp: options.selectedTimestamp } : {}),
    ...(options.requestIdFactory ? { requestIdFactory: options.requestIdFactory } : {}),
    ...(options.initialDraft ? { initialDraft: options.initialDraft } : {}),
  };
  render(<FollowupTab {...props} />);
  return { port };
}

beforeEach(() => {
  // 不用 fakeTimers：watchdog 等超时行为已迁 hook 测试。
});

afterEach(() => {
  uninstallChromePortStub();
  vi.restoreAllMocks();
});

/** 业务行匹配：跳过注释 / JSDoc。 */
function hasBusinessText(source: string, literal: string): boolean {
  const lines = source.split('\n');
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inBlockComment && trimmed.startsWith('//')) continue;
    if (inBlockComment) {
      const closeIdx = line.indexOf('*/');
      if (closeIdx >= 0) {
        inBlockComment = false;
        const after = line.slice(closeIdx + 2);
        if (after.includes(literal)) return true;
      }
      continue;
    }
    if (line.includes(literal)) {
      return true;
    }
  }
  return false;
}

const FOLLOWUP_TAB = resolve(__dirname, '../../src/extension/sidepanel/FollowupTab.tsx');

describe('FollowupTab 页面组合（Round 27 QA2 必修 A + Round 27 QA3 必修 A）', () => {
  it('root + scroll + composer 三个 testid 都存在', () => {
    renderFollowupTab();
    expect(document.querySelector('[data-testid="followup-tab-root"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="followup-tab-scroll"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="followup-composer-container"]')).not.toBeNull();
  });

  it('root 含 flex + flex-col（column layout）', () => {
    renderFollowupTab();
    const root = document.querySelector('[data-testid="followup-tab-root"]');
    const className = root?.getAttribute('class') ?? '';
    expect(className).toMatch(/\bflex\b/);
    expect(className).toMatch(/\bflex-col\b/);
  });

  it('root 含 h-full + min-h-0（填满父容器，不硬编码高度）', () => {
    renderFollowupTab();
    const root = document.querySelector('[data-testid="followup-tab-root"]');
    const className = root?.getAttribute('class') ?? '';
    expect(className).toMatch(/\bh-full\b/);
    expect(className).toMatch(/\bmin-h-0\b/);
  });

  it('FollowupTab.tsx 业务行不含 min-h-[400px] / max-h-[calc(100vh-260px)] 硬编码', () => {
    const src = readFileSync(FOLLOWUP_TAB, 'utf-8');
    expect(hasBusinessText(src, 'min-h-[400px]')).toBe(false);
    expect(hasBusinessText(src, 'max-h-[calc(100vh-260px)]')).toBe(false);
  });

  it('scroll 区 + composer container 是 root 的直接子节点，composer 在 scroll 之后', () => {
    renderFollowupTab();
    const root = document.querySelector('[data-testid="followup-tab-root"]');
    const scroll = document.querySelector('[data-testid="followup-tab-scroll"]');
    const composer = document.querySelector('[data-testid="followup-composer-container"]');
    expect(root).not.toBeNull();
    expect(scroll).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(scroll?.parentElement).toBe(root);
    expect(composer?.parentElement).toBe(root);
    if (root && scroll && composer) {
      const children = Array.from(root.children);
      expect(children.indexOf(scroll)).toBeLessThan(children.indexOf(composer));
    }
  });
});

describe('FollowupTab composer footer 结构（Round 27 QA3 必修 A + QA8/QA9/QA10/QA11）', () => {
  it('composer container 含 shrink-0 + border + border-border + bg-card + 主题圆角类', () => {
    renderFollowupTab();
    const composer = document.querySelector('[data-testid="followup-composer-container"]');
    const className = composer?.getAttribute('class') ?? '';
    const textareaClassName =
      document.querySelector('[data-testid="followup-composer-textarea"]')?.getAttribute('class') ?? '';
    const basisClassName =
      document.querySelector('[data-testid="followup-answer-basis"] [role="group"]')?.getAttribute('class') ?? '';
    const sendClassName =
      document.querySelector('[data-testid="followup-composer-send"]')?.getAttribute('class') ?? '';
    expect(className).toMatch(/\bshrink-0\b/);
    expect(className).toMatch(/\bborder\b/);
    expect(className).not.toMatch(/\bborder-t\b/);
    expect(className).toMatch(/\bborder-border\b/);
    expect(className).toMatch(/\bbg-card\b/);
    expect(className).toMatch(/\bbai-composer\b/);
    expect(textareaClassName).toMatch(/\bbai-composer-input\b/);
    expect(basisClassName).toMatch(/\bbai-answer-basis-group\b/);
    expect(sendClassName).toMatch(/\bbai-send-button\b/);
  });

  it('composer container 不再含 sticky / bottom-0（QA11 沿用 QA2 已弃 sticky 写法）', () => {
    renderFollowupTab();
    const composer = document.querySelector('[data-testid="followup-composer-container"]');
    const className = composer?.getAttribute('class') ?? '';
    expect(className).not.toMatch(/\bsticky\b/);
    expect(className).not.toMatch(/\bbottom-0\b/);
  });

  it('composer footer 含紧凑 padding，且不再用负 margin 抵消父级 padding 避免被底部入口裁切', () => {
    renderFollowupTab();
    const composer = document.querySelector('[data-testid="followup-composer-container"]');
    const className = composer?.getAttribute('class') ?? '';
    expect(className).toMatch(/\bp-2\b/);
    expect(className).toMatch(/\bmt-2\b/);
    expect(className).not.toMatch(/-mx-3\b/);
    expect(className).not.toMatch(/-mb-3\b/);
  });

  it('FollowupComposer 含 space-y-1 + 不含 relative', () => {
    renderFollowupTab();
    const composer = document.querySelector('[data-testid="followup-composer"]');
    const className = composer?.getAttribute('class') ?? '';
    expect(className).toMatch(/\bspace-y-1\b/);
    expect(className).not.toMatch(/\bspace-y-1\.5\b/);
    expect(className).not.toMatch(/\brelative\b/);
  });

  it('composer footer（同一父容器含回答依据 + 发送按钮）含 flex + items-center + flex-nowrap + 紧凑 gap-1，发送按钮 shrink-0（QA2 必修 3 压缩）', () => {
    renderFollowupTab();
    // footer 是 textarea 下方单一父容器，同时包含回答依据和发送按钮
    const footer = document.querySelector('[data-testid="followup-composer-footer"]');
    expect(footer).not.toBeNull();
    const footerClass = footer?.getAttribute('class') ?? '';
    expect(footerClass).toMatch(/\bflex\b/);
    expect(footerClass).toMatch(/\bitems-center\b/);
    expect(footerClass).toMatch(/\bflex-nowrap\b/);
    // QA2 必修 3：压缩 footer 间距 → gap-1（之前是 gap-2）。**不**允许用
    // overflow-hidden 静默裁掉控件；正常 sidepanel 宽度下应能单行展示。
    expect(footerClass).toMatch(/\bgap-1\b/);
    expect(footerClass).not.toMatch(/\boverflow-hidden\b/);
    // footer 必须同时含回答依据 + 发送按钮
    expect(footer?.contains(document.querySelector('[data-testid="followup-answer-basis"]'))).toBe(true);
    expect(footer?.contains(document.querySelector('[data-testid="followup-composer-send"]'))).toBe(true);
    // 发送按钮 shrink-0：避免被左侧挤压变形
    const sendButton = document.querySelector('[data-testid="followup-composer-send"]');
    const sendClass = sendButton?.getAttribute('class') ?? '';
    expect(sendClass).toMatch(/\bshrink-0\b/);
    expect(sendClass).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('send button 含 py-0.5 + leading-4 + px-2 + text-xs + bg-primary，不含 absolute（QA2 必修 3 紧凑 padding）', () => {
    renderFollowupTab();
    const sendButton = document.querySelector('[data-testid="followup-composer-send"]');
    const className = sendButton?.getAttribute('class') ?? '';
    expect(className).toMatch(/\bpy-0\.5\b/);
    expect(className).toMatch(/\bleading-4\b/);
    // QA2 必修 3：发送按钮 padding 由 px-2.5 压缩为 px-2，配合依据 segment
    // 正常 sidepanel 宽度下"回答依据 / 仅视频 / 通识 / 发送"单行可见；
    // 开启实验室联网后，组件测试覆盖三段依据仍能单行展示。
    expect(className).toMatch(/\bpx-2\b/);
    expect(className).toMatch(/\btext-xs\b/);
    expect(className).toMatch(/\bbg-primary\b/);
    expect(className).not.toMatch(/\babsolute\b/);
  });

  it('textarea 含 w-full + py-1 + resize-none + border-input + bg-background，不含 pr-/pb-', () => {
    renderFollowupTab();
    const textarea = document.querySelector('[data-testid="followup-composer-textarea"]');
    const className = textarea?.getAttribute('class') ?? '';
    expect(className).toMatch(/\bw-full\b/);
    expect(className).toMatch(/\bpy-1\b/);
    expect(className).toMatch(/\bresize-none\b/);
    expect(className).toMatch(/\bborder-input\b/);
    expect(className).toMatch(/\bbg-background\b/);
    expect(className).not.toMatch(/\bpr-[\d.]+\b/);
    expect(className).not.toMatch(/\bpb-[\d.]+\b/);
  });
});

describe('FollowupTab 快捷问题 chip 化（Round 27 QA8 必修 A）', () => {
  it('4 个 chip 都用 rounded-full + text-xs + py-1；不含 text-left / text-sm / py-1.5；页面不含 grid-cols-1', () => {
    renderFollowupTab();
    const panelClassName =
      document.querySelector('[data-testid="followup-quick-questions"]')?.getAttribute('class') ?? '';
    expect(panelClassName).toMatch(/\bbai-quick-question-panel\b/);
    expect(panelClassName).not.toMatch(/\bpt-1\.5\b/);
    const buttons = document.querySelectorAll('[data-quick-question-id]');
    expect(buttons.length).toBe(4);
    for (const button of Array.from(buttons)) {
      const className = button.getAttribute('class') ?? '';
      expect(className).toMatch(/\brounded-full\b/);
      expect(className).toMatch(/\btext-xs\b/);
      expect(className).toMatch(/\bpy-1\b/);
      expect(className).not.toMatch(/\btext-left\b/);
      expect(className).not.toMatch(/\btext-sm\b/);
      expect(className).not.toMatch(/\bpy-1\.5\b/);
    }
    expect(document.querySelector('.grid.grid-cols-1')).toBeNull();
  });

  it('无消息空态不再把快捷问题压到底部，减少上方空白', () => {
    renderFollowupTab();
    const scroll = document.querySelector('[data-testid="followup-tab-scroll"]');
    const className = scroll?.getAttribute('class') ?? '';
    expect(className).not.toMatch(/\bjustify-end\b/);
  });
});

describe('FollowupTab 滚动策略（Round 27 QA10 必修 B）', () => {
  it('FollowupTab.tsx 业务行：scroll useLayoutEffect 只 deps messages.length（不跟流式）', () => {
    const src = readFileSync(FOLLOWUP_TAB, 'utf-8');
    const businessLines = src.split('\n').filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
    // 1) 不再引用 lastAssistantContent（QA9 旧实现已撤回）
    expect(
      businessLines.some((line) => line.includes('lastAssistantContent')),
    ).toBe(false);
    // 2) useLayoutEffect 后面 200 字符内出现 `}, [state.messages.length])`
    const joined = businessLines.join('\n');
    const hasScrollEffect =
      /useLayoutEffect[\s\S]{0,200},\s*\[\s*state\.messages\.length\s*\]/u.test(joined);
    expect(hasScrollEffect).toBe(true);
  });
});

describe('FollowupTab no_context CTA（Round 29A 必修 C + 必修 F #1）', () => {
  it('no_context CTA 文案 = "开启提问"，isAnalyzing 时切"正在开启..."', () => {
    const { rerender } = render(
      <FollowupTab
        hasContentContext={false}
        playbackState={PLAYBACK}
        onPrepareContentContext={vi.fn()}
        contextKey="ctx-r29a-cta-text"
      />,
    );
    expect(screen.getByTestId('followup-no-context-cta').textContent).toBe('开启提问');

    rerender(
      <FollowupTab
        hasContentContext={false}
        playbackState={PLAYBACK}
        onPrepareContentContext={vi.fn()}
        isAnalyzing
        contextKey="ctx-r29a-cta-text"
      />,
    );
    expect(screen.getByTestId('followup-no-context-cta').textContent).toBe('正在开启...');
  });

  it('no_context CTA 点击调 onPrepareContentContext', () => {
    const onPrepareContentContext = vi.fn();
    render(
      <FollowupTab
        hasContentContext={false}
        playbackState={PLAYBACK}
        onPrepareContentContext={onPrepareContentContext}
        contextKey="ctx-r29a-cta-call"
      />,
    );
    fireEvent.click(screen.getByTestId('followup-no-context-cta'));
    expect(onPrepareContentContext).toHaveBeenCalledTimes(1);
  });

  it('hasContentContext=true 时不渲染 no_context 卡片', () => {
    renderFollowupTab();
    expect(screen.queryByTestId('followup-no-context')).toBeNull();
    expect(screen.queryByTestId('followup-no-context-cta')).toBeNull();
  });
});

describe('FollowupTab 外部预填问题', () => {
  it('initialDraft 变化时写入提问输入框', async () => {
    renderFollowupTab({
      contextKey: 'ctx-initial-draft',
      initialDraft: { id: 1, text: '你喜欢的是节奏还是反差？' },
    });
    await waitFor(() => {
      expect(
        (screen.getByTestId('followup-composer-textarea') as HTMLTextAreaElement)
          .value,
      ).toBe('你喜欢的是节奏还是反差？');
    });
  });
});

describe('FollowupTab 错误 banner（Round 29A 必修 F #3）', () => {
  it('非 MISSING_CURRENT_TIME 错误码显示 followup-error-banner + data-error-code', async () => {
    const { port } = renderFollowupTab({
      requestIdFactory: makeRequestIdFactory('req-r29a-banner'),
    });
    // 触发追问让 FollowupTab 切到 loading，background 推回 ERROR
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '整体讲什么？' }));
    });
    await waitFor(() => {
      expect(port.postMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const askCall = port.postMessage.mock.calls.find(
      (call) => (call[0] as { type?: string })?.type === 'ASK_VIDEO_QUESTION',
    );
    const askPayload = askCall?.[0] as Extract<{ type: 'ASK_VIDEO_QUESTION'; requestId: string }, { type: 'ASK_VIDEO_QUESTION' }>;
    await act(async () => {
      port.emitMessage({
        type: 'VIDEO_ANSWER_ERROR',
        requestId: askPayload.requestId,
        code: 'NO_CONTENT_CONTEXT',
        message: '当前视频没有可用的字幕或转写。',
      });
    });
    const banner = screen.getByTestId('followup-error-banner');
    expect(banner.getAttribute('data-error-code')).toBe('NO_CONTENT_CONTEXT');
    expect(banner.textContent).toContain('字幕');
  });

  it('MISSING_CURRENT_TIME 错误码走无 data-testid 的红 banner，不抢 followup-error-banner testid', () => {
    // 本地拦截路径：playbackState=null + "这段怎么理解？" 快捷问题。
    // 行为在 use-followup-session.test.tsx 覆盖；这里只断言页面层渲染分流正确。
    renderFollowupTab({ playbackState: null });
    // 触发本地拦截
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '这段怎么理解？' }));
    });
    expect(screen.queryByTestId('followup-error-banner')).toBeNull();
    expect(screen.getByText(/还没有拿到当前播放位置/)).toBeInTheDocument();
  });
});

describe('FollowupTab 集成 sanity（端到端串通）', () => {
  it('render FollowupTab → 点快捷问题 → background CHUNK + DONE → phase 回 idle + 按钮恢复可用', async () => {
    const { port } = renderFollowupTab({
      requestIdFactory: makeRequestIdFactory('req-e2e'),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '观点和保留？' }));
    });
    await waitFor(() => {
      expect(screen.getByText('正在回答...')).toBeInTheDocument();
    });
    const askCall = port.postMessage.mock.calls.find(
      (call) => (call[0] as { type?: string })?.type === 'ASK_VIDEO_QUESTION',
    );
    const askPayload = askCall?.[0] as { requestId: string };
    await act(async () => {
      port.emitMessage({
        type: 'VIDEO_ANSWER_CHUNK',
        requestId: askPayload.requestId,
        text: '一些回答',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('一些回答')).toBeInTheDocument();
    });
    await act(async () => {
      port.emitMessage({ type: 'VIDEO_ANSWER_DONE', requestId: askPayload.requestId });
    });
    await waitFor(() => {
      expect(screen.queryByText('正在回答...')).toBeNull();
    });
    // 再次点其他快捷问题 → 不卡 loading
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '整体讲什么？' }));
    });
    await waitFor(() => {
      expect(screen.getByText('正在回答...')).toBeInTheDocument();
    });
  });
});
