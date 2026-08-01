import { useMemo, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { extractTimestampReferences, parseSeekSeconds } from '@core/followup/followup-timestamps';

/**
 * 追问回答的 Markdown 渲染器。
 *
 * 渲染标准 Markdown + GFM，不渲染 raw HTML；表格和代码块可横向滚动。
 * `[03:20]` 这类裸时间点会改写成内部跳转链接，普通外链仍在新标签打开。
 * 不在浏览器里跑 rehype-raw，避免引入额外的 hast-util-from-html 解析路径。
 * 用户消息继续走 `whitespace-pre-wrap` 纯文本（见 FollowupMessageBubble），
 * 这里只负责 assistant 的可信任 Markdown。
 */
export interface MarkdownMessageProps {
  readonly content: string;
  /** 自定义 className，覆盖默认 prose 容器。 */
  readonly className?: string;
  /** 流式未完成：显示尾部光标 ▍。 */
  readonly isStreaming?: boolean;
  /** 点击内部 `bai-seek://{seconds}` 链接时调用；未传时显示为普通强调文本。 */
  readonly onSeekTimestamp?: (seconds: number) => void;
}

const BAI_SEEK_PROTOCOL = 'bai-seek://';
const SEEK_PREROLL_SECONDS = 1;

const proseContainerClass = [
  'bai-markdown-message prose prose-sm max-w-none break-words text-foreground',
  'prose-headings:font-semibold prose-headings:leading-snug',
  'prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground',
  'prose-strong:text-foreground prose-th:text-foreground prose-td:text-foreground',
  'prose-p:my-1.5 prose-p:leading-6',
  'prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5',
  'prose-strong:font-semibold',
  'prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none',
  'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em]',
  'prose-pre:my-2 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:bg-muted prose-pre:p-2',
  'prose-blockquote:my-2 prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:text-muted-foreground',
  'prose-a:text-primary prose-a:underline',
].join(' ');

export function MarkdownMessage(props: MarkdownMessageProps): ReactNode {
  const { content, className, isStreaming = false, onSeekTimestamp } = props;
  // 先把裸 bracket 时间点改写成 markdown link；代码块内的时间点会被跳过。
  const transformed = useMemo(() => rewriteTimestampsToInternalLinks(content), [content]);

  // 表格用横向滚动包裹，避免列数多时撑爆侧边栏（<360px 宽）。
  const components = useMemo<Components>(
    () => ({
      table: ({ children, node: _node, ...rest }) => (
        <div className="my-2 max-w-full overflow-x-auto rounded-md border border-border">
          <table
            // react-markdown 把 remark-gfm 的 table 转成 hast table，列由 thead/tr/th 表达。
            // 容器已经限制 max-width + overflow-x-auto，这里只要把表格宽度交还内容即可。
            className="w-full text-xs"
            {...rest}
          >
            {children}
          </table>
        </div>
      ),
      thead: ({ children, node: _node, ...rest }) => (
        <thead className="bg-muted text-left" {...rest}>
          {children}
        </thead>
      ),
      th: ({ children, node: _node, ...rest }) => (
        <th className="whitespace-nowrap px-2 py-1 font-medium" {...rest}>
          {children}
        </th>
      ),
      td: ({ children, node: _node, ...rest }) => (
        <td className="border-t border-border px-2 py-1 align-top" {...rest}>
          {children}
        </td>
      ),
      pre: ({ children, node: _node, ...rest }) => (
        <pre className="max-w-full overflow-x-auto" {...rest}>
          {children}
        </pre>
      ),
      code: ({ className: codeClass, children, node: _node, ...rest }) => {
        // remark-gfm 不会改 inline code；react-markdown 在 fenced code 里会把
        // language 塞进 className（`language-xxx`）。这里简单区分 block vs inline：
        // 含 `language-` → block（在 <pre> 里）；纯文本 → inline code。
        const isBlock = typeof codeClass === 'string' && codeClass.includes('language-');
        if (isBlock) {
          return (
            <code className={codeClass} {...rest}>
              {children}
            </code>
          );
        }
        return (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...rest}>
            {children}
          </code>
        );
      },
      a: ({ children, href, node: _node, ...rest }) => {
        if (typeof href === 'string' && href.startsWith(BAI_SEEK_PROTOCOL)) {
          // 内部跳转：点击 → 阻止默认 + 调 onSeekTimestamp（如果 caller 提供了）。
          // 渲染成 button 样式保持视觉一致；不用 <a href="#"> 避免 hash 变更。
          const seconds = parseSeekSeconds(href.slice(BAI_SEEK_PROTOCOL.length));
          if (seconds === null) {
            // 解析失败：退回纯文本（避免 href 暴露成恶意链接）
            return <span className="text-primary underline">{children}</span>;
          }
          if (!onSeekTimestamp) {
            // caller 没接 onSeekTimestamp：标 primary 让用户知道这是可点击
            return <span className="text-primary underline">{children}</span>;
          }
          return (
            <button
              type="button"
              className="cursor-pointer text-primary underline"
              onClick={(event) => {
                event.preventDefault();
                onSeekTimestamp(seconds);
              }}
              data-bai-seek-seconds={seconds}
            >
              {children}
            </button>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
            {children}
          </a>
        );
      },
    }),
    [onSeekTimestamp],
  );

  // 防御：content 为空时直接显示占位，不进 react-markdown（避免 0-length 节点）。
  if (!content) {
    return null;
  }

  return (
    <div
      className={className ?? proseContainerClass}
      // 内容是 LLM 输出，可信度有限；靠 skipHtml 在解析阶段就丢 raw HTML。
      data-testid="markdown-message"
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        // 链接做更严格的过滤：defaultUrlTransform 默认只允许 https?/ircs/mailto/xmpp，
        // 我们额外白名单 `bai-seek://` 给时间跳转用；同时**显式拒绝** javascript: / data: /
        // vbscript: 防止 LLM 写出恶意链接。
        urlTransform={(value) => {
          const lower = value.trim().toLowerCase();
          if (
            lower.startsWith('javascript:') ||
            lower.startsWith('data:') ||
            lower.startsWith('vbscript:')
          ) {
            return '';
          }
          if (lower.startsWith(BAI_SEEK_PROTOCOL)) {
            // 校验 seconds 可解析，避免被 `[坏](bai-seek://abc)` 之类带过奇怪内容
            const seconds = parseSeekSeconds(value.slice(BAI_SEEK_PROTOCOL.length));
            if (seconds === null) {
              return '';
            }
            return value;
          }
          return value;
        }}
        components={components}
      >
        {transformed}
      </Markdown>
      {isStreaming ? <span className="ml-0.5 text-muted-foreground">▍</span> : null}
    </div>
  );
}

/**
 * 把 markdown 里的非代码块 bracket 时间点改写成内部跳转链接。
 * 示例：
 *   `[03:20]`         → `[03:20](bai-seek://200)`
 *   `[03:20-04:10]`   → `[03:20-04:10](bai-seek://200)`
 *   `` `[03:20]` ``   → 不改（inline code 跳过）
 *   ``` ```\n[03:20]\n``` ``` → 不改（fenced code 跳过）
 */
function rewriteTimestampsToInternalLinks(markdown: string): string {
  if (!markdown) {
    return markdown;
  }
  const refs = extractTimestampReferences(markdown);
  if (refs.length === 0) {
    return markdown;
  }
  // refs 已按 index 升序（matchAll 保证），从后往前替换避免 index 错位
  let result = markdown;
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const ref = refs[i]!;
    const start = ref.index;
    const end = ref.index + ref.raw.length;
    const label = ref.raw.slice(1, -1); // 去 [ 和 ]
    const seekStart = Math.max(0, ref.start - SEEK_PREROLL_SECONDS);
    const replacement = `${ref.raw}(${BAI_SEEK_PROTOCOL}${seekStart})`;
    // 把裸 bracket 改写成 markdown link，label 仍是原文本
    const replaced = result.slice(0, start) + replacement + result.slice(end);
    // 防御：万一 regex 把 label 偷吃了，确认我们用的是 raw 整体
    if (!replaced.includes(replacement)) {
      // 理论上不会发生；保险用 raw 重新替换
      result = result.replace(ref.raw, replacement);
    } else {
      result = replaced;
    }
    void label;
  }
  return result;
}
