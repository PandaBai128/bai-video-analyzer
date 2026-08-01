import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FollowupQuickQuestions } from '@extension/sidepanel/followup/FollowupQuickQuestions';
import { FollowupMessages } from '@extension/sidepanel/followup/FollowupMessages';
import { FollowupComposer } from '@extension/sidepanel/followup/FollowupComposer';
import type { FollowupMessage, FollowupPhase } from '@extension/sidepanel/followup-state';
import { installChromePortStub, uninstallChromePortStub } from './helpers/followup-test-harness';

/**
 * FollowupTab 三个职责组件的行为测例。
 *
 * - FollowupQuickQuestions：chip 渲染 / disabled / onSubmit options 透传
 * - FollowupMessages：user / assistant 渲染 / Markdown / 流式 / 错误 / 继续追问 /
 *   时间点跳转
 * - FollowupComposer：textarea + 发送按钮 / Enter 提交 / 修饰键换行 / disabled /
 *   草稿为空按钮禁用
 *
 * 不依赖 FollowupTab；直接 render 各自组件 + 喂 props 即可。
 */

afterEach(() => {
  uninstallChromePortStub();
  vi.restoreAllMocks();
});

describe('FollowupQuickQuestions', () => {
  it('渲染 4 个学习追问 chip + labels 顺序不变', () => {
    const onSubmit = vi.fn();
    render(<FollowupQuickQuestions disabled={false} onSubmit={onSubmit} />);
    const panelClassName = screen.getByTestId('followup-quick-questions').getAttribute('class') ?? '';
    expect(panelClassName).toMatch(/\bbai-quick-question-panel\b/);
    expect(panelClassName).toMatch(/\bp-2\b/);
    const buttons = document.querySelectorAll('[data-quick-question-id]');
    expect(buttons.length).toBe(4);
    expect(buttons[0]?.getAttribute('data-quick-question-id')).toBe('video-summary');
    expect(buttons[1]?.getAttribute('data-quick-question-id')).toBe('current-segment');
    expect(buttons[2]?.getAttribute('data-quick-question-id')).toBe('next-focus');
    expect(buttons[3]?.getAttribute('data-quick-question-id')).toBe('key-ideas');
    expect(buttons[0]?.textContent).toBe('整体讲什么？');
    expect(buttons[1]?.textContent).toBe('这段怎么理解？');
    expect(buttons[2]?.textContent).toBe('后面重点看哪？');
    expect(buttons[3]?.textContent).toBe('观点和保留？');
  });

  it('disabled=true 时 4 个 chip 都 disabled', () => {
    const onSubmit = vi.fn();
    render(<FollowupQuickQuestions disabled onSubmit={onSubmit} />);
    const buttons = Array.from(document.querySelectorAll('[data-quick-question-id]'));
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('点击 video-summary chip → onSubmit 收到全局问题，不强制当前时间', () => {
    const onSubmit = vi.fn();
    render(<FollowupQuickQuestions disabled={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '整体讲什么？' }));
    expect(onSubmit).toHaveBeenCalledWith(
      '这个视频整体讲了什么内容？请用学习视角概括内容主线、关键概念和核心观点，不要照搬分析页模板，也不要输出观看路线。',
      undefined,
    );
  });

  it('点击 current-segment chip → onSubmit 收到 requiresCurrentTime + forceCurrentSegment', () => {
    const onSubmit = vi.fn();
    render(<FollowupQuickQuestions disabled={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '这段怎么理解？' }));
    expect(onSubmit).toHaveBeenCalledWith(
      '请解释当前片段在讲什么、它和前后内容的关系，以及这里需要抓住的关键细节。',
      {
        requiresCurrentTime: true,
        forceCurrentSegment: true,
      },
    );
  });

  it('点击 next-focus chip → onSubmit 收到 requiresCurrentTime，但不锁死当前片段', () => {
    const onSubmit = vi.fn();
    render(<FollowupQuickQuestions disabled={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '后面重点看哪？' }));
    expect(onSubmit).toHaveBeenCalledWith(
      '从当前播放位置往后，接下来内容会怎么展开？请按时间顺序说明后续主线、关键转折和需要留意的概念或观点。',
      {
        requiresCurrentTime: true,
      },
    );
  });
});

function makeUserMessage(id: string, content: string): FollowupMessage {
  return { id, role: 'user', content, createdAt: 0 };
}

function makeAssistantMessage(
  id: string,
  content: string,
  extras: Partial<FollowupMessage> = {},
): FollowupMessage {
  return { id, role: 'assistant', content, createdAt: 0, ...extras };
}

describe('FollowupMessages', () => {
  it('user 消息显示纯文本（whitespace-pre-wrap）', () => {
    render(
      <FollowupMessages
        messages={[makeUserMessage('u1', '用户问的内容')]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
      />,
    );
    expect(screen.getByText('用户问的内容')).toBeInTheDocument();
    expect(screen.getByText('你')).toBeInTheDocument();
    const bubble = screen.getByText('用户问的内容').closest('.bai-message-bubble');
    expect(bubble).not.toBeNull();
    expect(bubble?.className).toContain('bai-message-bubble-user');
  });

  it('assistant 错误消息显示"出错了：xxx (code)"', () => {
    render(
      <FollowupMessages
        messages={[
          makeAssistantMessage('a1', '半截回答', {
            error: { code: 'STREAM_TIMEOUT', message: '追问响应超时，请重试。' },
          }),
        ]}
        phase={{
          kind: 'error',
          requestId: 'r1',
          userMessageId: 'u1',
          assistantMessageId: 'a1',
          code: 'STREAM_TIMEOUT',
          message: '追问响应超时，请重试。',
        }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
      />,
    );
    expect(screen.getByText(/追问响应超时/)).toBeInTheDocument();
    expect(screen.getByText(/STREAM_TIMEOUT/)).toBeInTheDocument();
  });

  it('assistant 消息显示提交当时的回答依据标签', () => {
    render(
      <FollowupMessages
        messages={[
          makeAssistantMessage('a1', '', { answerBasis: 'video_only' }),
          makeAssistantMessage('a2', '', { answerBasis: 'video_plus_general' }),
          makeAssistantMessage('a3', '', { answerBasis: 'video_plus_web' }),
        ]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
      />,
    );
    expect(screen.getByText('仅视频')).toBeInTheDocument();
    expect(screen.getByText('通识')).toBeInTheDocument();
    expect(screen.getByText('联网')).toBeInTheDocument();
  });

  it('loading 阶段显示"正在回答..."，不渲染 Markdown', () => {
    render(
      <FollowupMessages
        messages={[makeAssistantMessage('a1', '', { streaming: true })]}
        phase={{ kind: 'loading', requestId: 'r1', userMessageId: 'u1', assistantMessageId: 'a1' }}
        suggestionDisabled
        onSubmitSuggestion={() => undefined}
      />,
    );
    expect(screen.getByText('正在回答...')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-message')).toBeNull();
  });

  it('streaming 阶段不提取"继续追问"建议（避免半截内容触发按钮）', () => {
    installChromePortStub();
    const streamingPhase: FollowupPhase = {
      kind: 'streaming',
      requestId: 'r1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      text: '可以继续问：\n- 为什么？',
      reasoning: '',
    };
    render(
      <FollowupMessages
        messages={[makeAssistantMessage('a1', '可以继续问：\n- 为什么？', { streaming: true })]}
        phase={streamingPhase}
        suggestionDisabled
        onSubmitSuggestion={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: '为什么？' })).toBeNull();
  });

  it('完成态 assistant 回答含"可以继续问"小节时，渲染建议按钮', () => {
    installChromePortStub();
    const fullContent = [
      '视频主要讲 BM25。',
      '',
      '可以继续问：',
      '- 为什么 BM25 优于 TF-IDF？',
      '- 向量召回怎么用？',
    ].join('\n');
    render(
      <FollowupMessages
        messages={[makeAssistantMessage('a1', fullContent)]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '为什么 BM25 优于 TF-IDF？' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '向量召回怎么用？' })).toBeInTheDocument();
  });

  it('加入笔记时传入剥离继续追问后的问答正文', () => {
    installChromePortStub();
    const onToggleExchangeInReview = vi.fn();
    const fullContent = [
      '视频主要讲 BM25。',
      '',
      '可以继续问：',
      '- 为什么 BM25 优于 TF-IDF？',
    ].join('\n');
    render(
      <FollowupMessages
        messages={[makeUserMessage('u1', 'BM25 是什么？'), makeAssistantMessage('a1', fullContent)]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
        onToggleExchangeInReview={onToggleExchangeInReview}
      />,
    );
    expect(onToggleExchangeInReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '加入笔记' }));
    expect(onToggleExchangeInReview).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'v2:0:u1:a1',
        question: 'BM25 是什么？',
        answer: '视频主要讲 BM25。',
      }),
      true,
    );
  });

  it('已加入笔记的问答在提问页可移出', () => {
    installChromePortStub();
    const onToggleExchangeInReview = vi.fn();
    render(
      <FollowupMessages
        messages={[makeUserMessage('u1', 'BM25 是什么？'), makeAssistantMessage('a1', '正文')]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
        includedExchangeIds={['v2:0:u1:a1']}
        includedExchangeCount={1}
        onToggleExchangeInReview={onToggleExchangeInReview}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '移出笔记' }));
    expect(onToggleExchangeInReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'v2:0:u1:a1' }),
      false,
    );
  });

  it('旧缓存里同名 message id 的问答不会误显示为已加入', () => {
    installChromePortStub();
    render(
      <FollowupMessages
        messages={[
          { ...makeUserMessage('u1', '新问题'), createdAt: 100 },
          { ...makeAssistantMessage('a1', '新回答'), createdAt: 100 },
        ]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
        includedExchangeIds={['u1:a1']}
        includedExchangeCount={1}
        onToggleExchangeInReview={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '加入笔记' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '移出笔记' })).toBeNull();
  });

  it('点击建议按钮 → onSubmitSuggestion 收到对应文本', () => {
    installChromePortStub();
    const fullContent = [
      '视频主要讲 BM25。',
      '',
      '可以继续问：',
      '- 为什么 BM25 优于 TF-IDF？',
    ].join('\n');
    const onSubmitSuggestion = vi.fn();
    render(
      <FollowupMessages
        messages={[makeAssistantMessage('a1', fullContent)]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={onSubmitSuggestion}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '为什么 BM25 优于 TF-IDF？' }));
    expect(onSubmitSuggestion).toHaveBeenCalledWith('为什么 BM25 优于 TF-IDF？');
  });

  it('完成态 suggestionDisabled=true 时建议按钮 disabled', () => {
    installChromePortStub();
    const fullContent = '可以继续问：\n- 为什么？';
    render(
      <FollowupMessages
        messages={[makeAssistantMessage('a1', fullContent)]}
        phase={{ kind: 'idle' }}
        suggestionDisabled
        onSubmitSuggestion={() => undefined}
      />,
    );
    const button = screen.getByRole('button', { name: '为什么？' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('完成态 assistant Markdown 内的 [mm:ss] 时间点渲染成可点击按钮，点击调 onSeekTimestamp', () => {
    installChromePortStub();
    const onSeekTimestamp = vi.fn();
    render(
      <FollowupMessages
        messages={[makeAssistantMessage('a1', '看 [03:20] 这段讲得最清楚。')]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    const button = document.querySelector('button[data-bai-seek-seconds="199"]');
    expect(button).not.toBeNull();
    const markdown = screen.getByTestId('markdown-message');
    expect(markdown.className).toContain('bai-markdown-message');
    expect(markdown.className).toContain('text-foreground');
    fireEvent.click(button as HTMLElement);
    expect(onSeekTimestamp).toHaveBeenCalledWith(199);
  });

  it('不传 onSeekTimestamp 时 [mm:ss] 退化为带下划线文本（不渲染为 button）', () => {
    installChromePortStub();
    render(
      <FollowupMessages
        messages={[makeAssistantMessage('a1', '看 [03:20] 这段讲得最清楚。')]}
        phase={{ kind: 'idle' }}
        suggestionDisabled={false}
        onSubmitSuggestion={() => undefined}
      />,
    );
    expect(document.querySelector('button[data-bai-seek-seconds="199"]')).toBeNull();
  });
});

describe('FollowupComposer', () => {
  it('textarea 占位文案为"快速提问..."', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(screen.getByPlaceholderText('快速提问...')).toBeInTheDocument();
  });

  it('draft 为空 + 按钮 disabled', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect((screen.getByTestId('followup-composer-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('draft 非空 + 按钮 enabled，点击触发 onSubmit', () => {
    const onSubmit = vi.fn();
    render(
      <FollowupComposer
        draft="草稿"
        disabled={false}
        onChange={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByTestId('followup-composer-send').textContent).toBe('发送');
    fireEvent.click(screen.getByTestId('followup-composer-send'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('textarea 受控：输入触发 onChange', () => {
    const onChange = vi.fn();
    render(
      <FollowupComposer draft="" disabled={false} onChange={onChange} onSubmit={() => undefined} />,
    );
    fireEvent.change(screen.getByTestId('followup-composer-textarea'), {
      target: { value: '新内容' },
    });
    expect(onChange).toHaveBeenCalledWith('新内容');
  });

  it('Enter + draft 非空 → onSubmit；Enter 但 draft 为空 → 不提交', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <FollowupComposer
        draft="草稿"
        disabled={false}
        onChange={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('followup-composer-textarea'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    onSubmit.mockClear();
    rerender(
      <FollowupComposer draft="" disabled={false} onChange={() => undefined} onSubmit={onSubmit} />,
    );
    fireEvent.keyDown(screen.getByTestId('followup-composer-textarea'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it('Shift + Enter / Ctrl + Enter / Meta + Enter 不提交（修饰键走换行）', () => {
    const onSubmit = vi.fn();
    render(
      <FollowupComposer
        draft="草稿"
        disabled={false}
        onChange={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    const textarea = screen.getByTestId('followup-composer-textarea');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it('disabled=true 时 textarea + 按钮都 disabled', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<FollowupComposer draft="草稿" disabled onChange={onChange} onSubmit={onSubmit} />);
    expect((screen.getByTestId('followup-composer-textarea') as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('followup-composer-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('followup-composer-send'));
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it('textarea 自适应高度：useLayoutEffect 同步 element.style.height', async () => {
    installChromePortStub();
    const { rerender } = render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    const textarea = screen.getByTestId('followup-composer-textarea') as HTMLTextAreaElement;
    // jsdom 里 scrollHeight 默认 0，effect 跑完后 height 应是 min(0, max) = 0px
    await waitFor(() => {
      expect(textarea.style.height).not.toBe('');
    });
    // 长 draft：scrollHeight 仍 0 但 effect 不抛错
    rerender(
      <FollowupComposer
        draft="长文本\n第二行\n第三行"
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(textarea.style.height).not.toBe('');
  });
});

describe('FollowupComposer 回答依据 answerBasis UI', () => {
  // 关键不变量（QA1 必修 2 + 必修 3）：
  // - DOM 顺序：textarea → 回答依据控件 → 发送按钮（用户在 textarea 下面选依据）
  // - 默认只显示"仅视频 / 通识"；设置页开启联网搜索后才显示"联网"；
  //   当前项 aria-pressed=true
  // - "通识"**不**跟随 composer busy 禁用 —— 任务单要求流式期间允许切换通识，
  //   已发请求使用提交瞬间快照，新选择只影响下一次提交。
  // - 不传 answerBasis 时不渲染依据行（老调用方兼容）
  // - 不传 onChangeAnswerBasis 时依据按钮 disabled（避免 onClick 触发空回调）

  it('不传 answerBasis 时不渲染依据行', () => {
    render(
      <FollowupComposer
        draft="草稿"
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(screen.queryByTestId('followup-answer-basis')).toBeNull();
  });

  it('DOM 顺序：textarea 在上；底栏包含依据控件 + 发送按钮，二者同一父容器并左右布局', () => {
    const { container } = render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_only"
        onChangeAnswerBasis={() => undefined}
        webSearchAvailable
      />,
    );
    const composer = container.querySelector('[data-testid="followup-composer"]');
    expect(composer).not.toBeNull();
    const children = Array.from(composer!.children);
    // children: [textarea, footer(basis + send)]
    expect(children.length).toBe(2);
    expect(children[0]?.contains(screen.getByTestId('followup-composer-textarea'))).toBe(true);
    // 第二个子节点是 footer，包含回答依据 + 发送按钮（同行布局）
    const footer = children[1];
    expect(footer).not.toBeUndefined();
    expect(footer?.contains(screen.getByTestId('followup-answer-basis'))).toBe(true);
    expect(footer?.contains(screen.getByTestId('followup-composer-send'))).toBe(true);
    // footer 同一父容器：basis 和 send 都是 footer 的直接子节点
    const footerChildren = Array.from(footer!.children);
    expect(
      footerChildren.some((c) => c.contains(screen.getByTestId('followup-answer-basis'))),
    ).toBe(true);
    expect(
      footerChildren.some((c) => c.contains(screen.getByTestId('followup-composer-send'))),
    ).toBe(true);
  });

  it('QA2 必修 3：底栏严格单行 — flex-nowrap / 不含 overflow-hidden / 发送按钮 shrink-0 / 各 chip whitespace-nowrap', () => {
    const { container } = render(
      <FollowupComposer
        draft="草稿"
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_only"
        onChangeAnswerBasis={() => undefined}
        webSearchAvailable
      />,
    );
    const footer = container.querySelector('[data-testid="followup-composer-footer"]');
    const basis = container.querySelector('[data-testid="followup-answer-basis"]');
    const send = container.querySelector('[data-testid="followup-composer-send"]');
    expect(footer).not.toBeNull();
    expect(basis).not.toBeNull();
    expect(send).not.toBeNull();
    const footerCls = footer!.className;
    const basisCls = basis!.className;
    const sendCls = send!.className;
    // 单行约束：flex-nowrap 必须存在
    expect(footerCls).toMatch(/\bflex-nowrap\b/);
    expect(basisCls).toMatch(/\bflex-nowrap\b/);
    // **不**允许 overflow-hidden：静默裁控件是禁止行为
    expect(footerCls).not.toMatch(/\boverflow-hidden\b/);
    expect(basisCls).not.toMatch(/\boverflow-hidden\b/);
    // 发送按钮保留宽度
    expect(sendCls).toMatch(/\bshrink-0\b/);
    expect(sendCls).toMatch(/\bwhitespace-nowrap\b/);
    // 开启联网后，三个依据 segment（仅视频 / 通识 / 联网）都 whitespace-nowrap，**不**允许按钮文字换行
    const basisButtons = basis!.querySelectorAll('button');
    expect(basisButtons).toHaveLength(3);
    basisButtons.forEach((btn) => {
      expect(btn.className).toMatch(/\bwhitespace-nowrap\b/);
    });
    // 文案完整：三段单选 / 发送都保留（不能被裁掉）；控件名称保留在 aria-label。
    expect(screen.getByRole('group', { name: '回答依据' })).toBeInTheDocument();
    expect(basis!.textContent).toContain('✓ 仅视频');
    expect(basis!.textContent).toContain('通识');
    expect(basis!.textContent).toContain('联网');
    expect(send!.textContent).toContain('发送');
  });

  it('answerBasis=video_only 且 webSearchAvailable=true 时：仅视频 aria-pressed=true；通识和联网都可点击', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_only"
        onChangeAnswerBasis={() => undefined}
        webSearchAvailable
      />,
    );
    expect(screen.getByTestId('followup-answer-basis')).toBeInTheDocument();
    const videoBtn = screen.getByRole('button', { name: /仅视频/ });
    expect((videoBtn as HTMLButtonElement).disabled).toBe(false);
    expect(videoBtn.getAttribute('aria-pressed')).toBe('true');
    expect(videoBtn.textContent).toContain('✓');

    const generalBtn = screen.getByRole('button', { name: '通识' });
    expect((generalBtn as HTMLButtonElement).disabled).toBe(false);
    expect(generalBtn.getAttribute('aria-pressed')).toBe('false');

    const webBtn = screen.getByRole('button', { name: /联网/ });
    expect((webBtn as HTMLButtonElement).disabled).toBe(false);
    expect(webBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('webSearchAvailable=false 时：不渲染联网按钮，且提问区不提示 Key', () => {
    const onChangeAnswerBasis = vi.fn();
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_only"
        onChangeAnswerBasis={onChangeAnswerBasis}
        webSearchAvailable={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /联网/ })).toBeNull();
    expect(onChangeAnswerBasis).not.toHaveBeenCalledWith('video_plus_web');
    expect(screen.queryByText(/Key|API Key/)).toBeNull();
  });

  it('不传 webSearchAvailable 时：按未配置处理，不渲染联网按钮', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_only"
        onChangeAnswerBasis={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: /仅视频/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通识' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /联网/ })).toBeNull();
  });

  it('webSearchAvailable=false 且旧状态为联网时：视觉回退到仅视频，不显示联网提示', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_plus_web"
        onChangeAnswerBasis={() => undefined}
        webSearchAvailable={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /联网/ })).toBeNull();
    expect(screen.getByRole('button', { name: /仅视频/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByText(/适合查和当前视频紧密相关的事实与来源/)).toBeNull();
  });

  it('answerBasis=video_plus_web 时：通过 title 提示搜索依据，不提示 Key', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_plus_web"
        onChangeAnswerBasis={() => undefined}
        webSearchAvailable
      />,
    );

    expect(screen.getByRole('button', { name: /联网/ }).getAttribute('title')).toContain(
      '先调用 MiniMax 联网搜索',
    );
    expect(screen.queryByText(/Key|API Key/)).toBeNull();
  });

  it('answerBasis=video_plus_general 时：通识按钮 aria-pressed=true 且文本含 "✓ 通识"', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_plus_general"
        onChangeAnswerBasis={() => undefined}
      />,
    );
    const generalBtn = screen.getByRole('button', { name: /通识/ });
    expect(generalBtn.getAttribute('aria-pressed')).toBe('true');
    expect(generalBtn.textContent).toContain('✓');
  });

  it('点击通识按钮（video_only 状态）→ onChangeAnswerBasis 收到 video_plus_general', () => {
    const onChangeAnswerBasis = vi.fn();
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_only"
        onChangeAnswerBasis={onChangeAnswerBasis}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '通识' }));
    expect(onChangeAnswerBasis).toHaveBeenCalledWith('video_plus_general');
  });

  it('点击仅视频按钮（video_plus_general 状态）→ onChangeAnswerBasis 收到 video_only', () => {
    const onChangeAnswerBasis = vi.fn();
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_plus_general"
        onChangeAnswerBasis={onChangeAnswerBasis}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /仅视频/ }));
    expect(onChangeAnswerBasis).toHaveBeenCalledWith('video_only');
  });

  it('composer busy 时 textarea disabled，发送按钮变为停止且通识按钮仍可切换（QA1 必修 3）', () => {
    const onChangeAnswerBasis = vi.fn();
    const onCancel = vi.fn();
    render(
      <FollowupComposer
        draft="草稿"
        disabled
        isBusy
        onChange={() => undefined}
        onSubmit={() => undefined}
        onCancel={onCancel}
        answerBasis="video_only"
        onChangeAnswerBasis={onChangeAnswerBasis}
      />,
    );
    // textarea 跟随 composer busy 禁用，按钮保留为主动停止入口
    expect((screen.getByTestId('followup-composer-textarea') as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    const sendButton = screen.getByTestId('followup-composer-send') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    expect(sendButton.textContent).toBe('停止');
    fireEvent.click(sendButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
    // 通识按钮**不**跟随 busy —— 流式期间允许切换
    const generalBtn = screen.getByRole('button', { name: '通识' });
    expect((generalBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(generalBtn);
    expect(onChangeAnswerBasis).toHaveBeenCalledWith('video_plus_general');
  });

  it('不传 onChangeAnswerBasis 时通识按钮 disabled（避免 onClick 触发空回调）', () => {
    render(
      <FollowupComposer
        draft=""
        disabled={false}
        onChange={() => undefined}
        onSubmit={() => undefined}
        answerBasis="video_only"
      />,
    );
    const generalBtn = screen.getByRole('button', { name: '通识' });
    expect((generalBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
