import {
  DEFAULT_MINIMAX_BASE_URL,
  normalizeMinimaxBaseUrl,
  type TextProviderSettings,
} from '@shared/settings';
import {
  LanguageModelStreamUnsupportedError,
  type LanguageModelAuthTestResult,
  type LanguageModelClient,
} from './language-model-client';

export type MinimaxMessageContent = string;

export interface MinimaxChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: MinimaxMessageContent;
}

export interface MinimaxChatResult {
  readonly content: string;
  readonly model: string;
  readonly timings?: readonly {
    readonly label: string;
    readonly durationMs: number;
  }[];
  /** 完整响应 JSON。下游解析失败时用于诊断字段名错位。 */
  readonly rawResponse?: unknown;
}

export interface MinimaxChatOptions {
  /** 覆盖默认模型；不传则用 settings.model（旧字段）或调用方传进来的 fastModel。 */
  model?: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

export class MinimaxApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'MinimaxApiError';
  }
}

/**
 * 追问答流式 chunk。每个 chunk 都是一段 delta 文本，可能是单 token 也可能是多 token，
 * 调用方负责按到达顺序 append。`reasoning` 字段只在服务端把思考内容与最终回答分开
 * 推送时才出现（M3 开启 thinking 时常见）。
 */
export interface MinimaxStreamChunk {
  readonly text: string;
  /** 服务端单独推送的思考/推理内容；与 text 互斥（同时只有一个非空）。 */
  readonly reasoning?: string;
  /** 流是否已结束。结束时可能仍带最后一段 text / reasoning。 */
  readonly done: boolean;
}

/**
 * 追问流式选项。`signal` 允许调用方取消（主动停止 / 关闭 side panel / 再次提问）。
 */
export interface MinimaxStreamOptions extends MinimaxChatOptions {
  signal?: AbortSignal;
  /**
   * 服务端协议不支持真正的流式（SSE）时是否回退到非流式：先把整段 chat() 拿到，
   * 再用单个 chunk 推出去。开启后会**走 chat()**，拿到完整内容再 yield 一次。
   * 默认 true——任何接口差异（v2 协议、SSE、chunked JSON）的 fallback 都不会让
   * 流式调用挂死或无响应。
 */
 fallbackToNonStream?: boolean;
 /**
 * Round12:收到第一个字节后 N毫秒内没解析出任何 SSE事件，就抛
 * `MinimaxStreamUnsupportedError` 让 controller fallback。默认20秒。
 */
 idleTimeoutMs?: number;
}

export class MinimaxClient implements LanguageModelClient {
  constructor(private readonly settings: TextProviderSettings) {}

  async testAuth(signal?: AbortSignal): Promise<LanguageModelAuthTestResult> {
    const startedAt = Date.now();

    // 连接测试必须走快速模型（用户当前在 settings 选的 fastModel），避免无谓触发 M3 慢响应。
    // signal 合并到同一个 options 对象。
    const options: MinimaxChatOptions = { model: this.settings.fastModel };
    if (signal) {
      options.signal = signal;
    }

    const result = await this.chat(
      [
        {
          role: 'system',
          content: '你是 bAI 视频分析助手的连接测试服务。请只返回 OK。',
        },
        {
          role: 'user',
          content: '请回复 OK',
        },
      ],
      options,
    );

    return {
      message: result.content || 'OK',
      latencyMs: Date.now() - startedAt,
    };
  }

  async chat(
    messages: readonly MinimaxChatMessage[],
    options: MinimaxChatOptions = {},
  ): Promise<MinimaxChatResult> {
    const data = await this.requestChatCompletion(messages, options);
    const rawContent = readAssistantContent(data).trim();
    const reasoning =
      readReasoningContent(data.choices?.[0]?.message) ??
      // 服务端字段名差异兜底：v2 协议可能用 reasoning_content / reasoning / thinking
      readFieldByName(data, ['reasoning_content', 'reasoning', 'thinking']);

    if (import.meta.env.DEV && reasoning && !rawContent.includes(reasoning)) {
      console.warn(
        '[minimax] response includes separate reasoning content. ' +
          'If you see this in production, the field name may have changed.',
        { rawContentLength: rawContent.length, reasoningLength: reasoning.length },
      );
    }

    // content 非空时，把 thinking 内容用 <think> 标签包起来拼到 content 前面，
    // 让下游 stripJsonFence 自动剥掉，保持 schema 解析逻辑不变。
    // MiniMax M2.7 在复杂 JSON 任务上偶尔会出现 content 为空、reasoning_content
    // 才包含实际 JSON 的情况；此时不能再包 <think>，否则 parser 会把唯一内容剥掉。
    const content =
      reasoning && rawContent
        ? `<think>${reasoning}</think>\n${rawContent}`
        : rawContent || reasoning || '';

    if (!content.trim()) {
      const detail = stringifyDetail(data);
      throw new MinimaxApiError(
        `MiniMax 返回了空内容：没有找到可用的 message.content / reasoning_content。响应片段：${truncateForError(detail, 500)}`,
        null,
        detail,
      );
    }

    return {
      content,
      model: data.model ?? options.model ?? this.settings.model,
      rawResponse: data,
    };
  }

  /**
   * 流式追问。v2 协议 `/v1/text/chatcompletion_v2` 支持 SSE（`stream: true`），
   * 每行 `data: {json}` 是增量。`reasoning_content` 单独推送（M3 thinking）。
   *
   * 行为：
   * - 正常路径：发起 stream=true 的 fetch，按行解析 SSE，把 delta 文本 yield 给调用方
   * - 协议不可流式（服务端 4xx/5xx 不接 SSE）：抛 `MinimaxStreamUnsupportedError`；
   *   调用方拿到这个错误可选择回退到 `chat()` + 单 chunk 推送
   * - 解析失败：抛 `MinimaxStreamParseError` 带上原始 chunk
   * - 正常结束：最后一个 chunk `done: true`
   * - 调用方取消（`AbortSignal`）：抛 `MinimaxApiError`(`code='ABORTED'`)，
   *   上游应能识别并停止写入 UI
   *
   * 不会破坏 `chat()` 的现有行为。
   */
  async *streamChat(
    messages: readonly MinimaxChatMessage[],
    options: MinimaxStreamOptions = {},
  ): AsyncGenerator<MinimaxStreamChunk, void, void> {
    const baseUrl = normalizeMinimaxBaseUrl(this.settings.baseUrl);
 // Round12:追问默认走 fastModel（M2.7-highspeed），避免 M3跑追问导致
 // 首字节延迟高 + thinking触发。允许 options.model override。
 const streamModel = options.model ?? this.settings.fastModel ?? this.settings.model;
 const body = {
 model: streamModel,
 messages,
 max_tokens: options.maxTokens ?? 4096,
 stream: true,
 ...buildThinkingFieldForRequest({
 model: streamModel,
 thinkingMode: this.settings.thinkingMode,
 }),
 temperature:0,
 };
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    };
    if (options.signal) {
      requestInit.signal = options.signal;
    }

    const requestStreamEndpoint = async (targetBaseUrl: string): Promise<Response> => {
      let response: Response;
      try {
        response = await fetch(`${targetBaseUrl}/v1/text/chatcompletion_v2`, requestInit);
      } catch (error) {
        if (isAbortError(error)) {
          throw new MinimaxApiError('追问请求已取消', null, '');
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(createMiniMaxFetchFailureMessage('MiniMax 流式请求失败', message, targetBaseUrl));
      }

      if (!response.ok) {
        const detail = await response.text();
        // 4xx/5xx 一律走 chat() 等价错误路径；调用方若设置了 fallbackToNonStream
        // 应在拿到这个错误后自行决定是否回退到 chat()
        throw new MinimaxApiError(
          createMiniMaxHttpErrorMessage(response.status, detail),
          response.status,
          detail,
        );
      }
      return response;
    };

    let activeBaseUrl = baseUrl;
    let response = await requestStreamEndpoint(activeBaseUrl);

 // Round12: v2协议在鉴权失败 /余额不足 / 参数错误等场景下，即便
 // 请求里 stream=true，也仍返回 application/json + HTTP200 +
 // base_resp.status_code !=0。SSE解析器解析这种 body 会因没有 \n\n
 // 分隔符而 silently走完循环 yield0 个 chunk —— 用户看到「永远正在
 //回答」。这里先用 content-type探测，把这种情况转成
 // MinimaxStreamUnsupportedError，让 controller fallback。
    const readValidatedStreamBody = async (): Promise<ReadableStream<Uint8Array>> => {
      if (!response.body) {
        throw new MinimaxStreamParseError('MiniMax 流式响应没有 body', '');
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.toLowerCase().includes('text/event-stream')) {
        return response.body;
      }

      const jsonBody = await safeReadBodyAsText(response.body);
      if (shouldRetryInvalidKeyOnDefaultBaseUrl(parseJsonBodyOrText(jsonBody), activeBaseUrl)) {
        activeBaseUrl = DEFAULT_MINIMAX_BASE_URL;
        response = await requestStreamEndpoint(activeBaseUrl);
        if (!response.body) {
          throw new MinimaxStreamParseError('MiniMax 流式响应没有 body', '');
        }
        const retryContentType = response.headers.get('content-type') ?? '';
        if (retryContentType.toLowerCase().includes('text/event-stream')) {
          return response.body;
        }
        const retryBody = await safeReadBodyAsText(response.body);
        throw new MinimaxStreamUnsupportedError(
          `MiniMax 流式响应不是 SSE（content-type=${retryContentType || '<empty>'}），` +
            '可能鉴权失败 /余额不足 / 服务端不接受 stream:true。' +
            `body: ${truncateForError(retryBody, 240)}`,
          retryBody,
        );
      }

      throw new MinimaxStreamUnsupportedError(
        `MiniMax 流式响应不是 SSE（content-type=${contentType || '<empty>'}），` +
          '可能鉴权失败 /余额不足 / 服务端不接受 stream:true。' +
          `body: ${truncateForError(jsonBody, 240)}`,
        jsonBody,
      );
    };

    const streamBody = await readValidatedStreamBody();

 // 进入 SSE解析循环
 const decoder = new TextDecoder('utf-8');
 const reader = streamBody.getReader();
 let buffer = '';
 let finished = false;
 // Round12: silent hang防御。服务端有时返回 text/event-stream 但
 //长时间不发 \n\n（TCP 半开 / 网关缓冲），idleTimeoutMs 后抛
 // MinimaxStreamUnsupportedError 让 controller fallback。
 let sawAnyEvent = false;
 const idleTimeoutMs = options.idleTimeoutMs ??20_000;
 let firstReadAt: number | null = null;

 try {
 while (!finished) {
 let readResult: ReadableStreamReadResult<Uint8Array>;
 try {
 readResult = await raceReaderRead(reader, idleTimeoutMs, () => ({
 buffer,
 sawAnyEvent,
 firstReadAt,
 }));
 } catch (error) {
 if (isAbortError(error)) {
 throw new MinimaxApiError('追问请求已取消', null, '');
 }
 if (error instanceof MinimaxStreamUnsupportedError) {
 throw error;
 }
 const message = error instanceof Error ? error.message : String(error);
 throw new MinimaxStreamParseError(`MiniMax 流式读取失败：${message}`, buffer);
 }

 if (readResult.done) {
 // 流被服务端断开；但可能最后一次 read 同时返回了 value（最后一段没处理）。
 // 先把 value 加到 buffer，再退出，让外层解析循环处理。
 if (readResult.value) {
 buffer += decoder.decode(readResult.value, { stream: false });
 if (firstReadAt === null) {
 firstReadAt = Date.now();
 }
 }
 finished = true;
 break;
 }

        buffer += decoder.decode(readResult.value, { stream: true });

 if (firstReadAt === null) {
 firstReadAt = Date.now();
 }

        // 按 \n\n 分块（标准 SSE 事件分隔符）；最后一段不一定是 \n\n 结尾
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          for (const parsedEvent of parseSseEvent(rawEvent)) {
            if (parsedEvent.kind === 'done') {
              // Round13: [DONE] 终止符也算"收到过事件"，避免 idle guard 误判 silent hang
              sawAnyEvent = true;
              finished = true;
              break;
            }
            if (parsedEvent.kind === 'data') {
              // Round13: 标准 SSE data 解析到就算"收到过事件"，让 raceReaderRead 不再走 idle guard。
              sawAnyEvent = true;
              // 服务端通常把 reasoning delta 与 text delta 拆开推送；但真实
              // MiniMax 偶发会在同一个 SSE event 同时带两者。不能因为有
              // reasoning 就丢掉 content，否则时间线 JSON 会变成空正文。
              if (parsedEvent.reasoning) {
                yield { text: '', reasoning: parsedEvent.reasoning, done: false };
              }
              if (parsedEvent.text) {
                yield { text: parsedEvent.text, done: false };
              }
            }
          }

          if (finished) {
            break;
          }
          separatorIndex = buffer.indexOf('\n\n');
 }

 // Round12: 单 \n 分隔的 SSE也能解析（兜底，避免 silent hang）
 if (!sawAnyEvent && /data:\s/.test(buffer) && !buffer.includes('\n\n')) {
 while (!sawAnyEvent || buffer.length >0) {
 if (!buffer) break;
 if (buffer.includes('\n\n')) break;
 const lines = buffer.split('\n');
 const leftover = [];
 let consumedAny = false;
 for (const line of lines) {
 if (line.startsWith('data:') || line.startsWith(':') || line === '') {
 try {
 for (const parsedEvent of parseSseEvent(line)) {
 if (parsedEvent.kind === 'done') { finished = true; break; }
 if (parsedEvent.kind === 'data') {
 sawAnyEvent = true;
 consumedAny = true;
 if (parsedEvent.reasoning) {
 yield { text: '', reasoning: parsedEvent.reasoning, done: false };
 }
 if (parsedEvent.text) {
 yield { text: parsedEvent.text, done: false };
 }
 }
 }
 } catch { /* ignore */ }
 } else {
 leftover.push(line);
 }
 }
 if (!consumedAny) break;
 buffer = leftover.join('\n');
 if (!buffer || finished) break;
 }
 }
 }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 释放锁失败不影响主流程
      }
    }

    // 流结束的尾部信号：done=true。调用方会拿这个标记把状态从 streaming 切回 idle
    yield { text: '', done: true };
  }

  private async requestChatCompletion(
    messages: readonly MinimaxChatMessage[],
    options: MinimaxChatOptions,
  ): Promise<{
    readonly model?: string;
    readonly choices?: Array<{ readonly message?: { readonly content?: string } }>;
  }> {
    const baseUrl = normalizeMinimaxBaseUrl(this.settings.baseUrl);
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model ?? this.settings.model,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        ...buildThinkingFieldForRequest({
          model: options.model ?? this.settings.model,
          thinkingMode: this.settings.thinkingMode,
        }),
        temperature: 0,
      }),
    };

    if (options.signal) {
      requestInit.signal = options.signal;
    }

    const requestEndpoint = async (targetBaseUrl: string): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetch(`${targetBaseUrl}/v1/text/chatcompletion_v2`, requestInit);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(createMiniMaxFetchFailureMessage('MiniMax 请求失败', message, targetBaseUrl));
      }

      if (!response.ok) {
        const detail = await response.text();
        throw new MinimaxApiError(
          createMiniMaxHttpErrorMessage(response.status, detail),
          response.status,
          detail,
        );
      }

      return (await response.json()) as unknown;
    };

    let data = await requestEndpoint(baseUrl);
    if (shouldRetryInvalidKeyOnDefaultBaseUrl(data, baseUrl)) {
      data = await requestEndpoint(DEFAULT_MINIMAX_BASE_URL);
    }
    assertChatBusinessOk(data);
    return data as {
      readonly model?: string;
      readonly choices?: Array<{ readonly message?: { readonly content?: string } }>;
    };
  }
}

function shouldRetryInvalidKeyOnDefaultBaseUrl(data: unknown, baseUrl: string): boolean {
  return baseUrl !== DEFAULT_MINIMAX_BASE_URL && readMiniMaxBusinessStatusCode(data) === '2049';
}

function assertChatBusinessOk(data: unknown): void {
  const rawStatusCode = readMiniMaxBusinessStatusCode(data);
  if (!rawStatusCode) {
    return;
  }
  if (rawStatusCode === '0') {
    return;
  }

  const root = isRecord(data) ? data : {};
  const baseResp = isRecord(root.base_resp) ? root.base_resp : {};

  const statusMessage =
    readString(baseResp, ['status_msg', 'statusMessage', 'message', 'msg']) ??
    readString(root, ['message', 'msg', 'error']) ??
    '未知错误';
  const detail = stringifyDetail(data);
  throw new MinimaxApiError(
    `MiniMax 业务错误：${rawStatusCode} ${statusMessage}。响应片段：${truncateForError(detail, 500)}`,
    null,
    detail,
  );
}

function readMiniMaxBusinessStatusCode(data: unknown): string | null {
  const root = isRecord(data) ? data : {};
  const baseResp = isRecord(root.base_resp) ? root.base_resp : null;
  if (!baseResp) {
    return null;
  }

  const rawStatusCode = baseResp.status_code ?? baseResp.statusCode ?? baseResp.code;
  if (rawStatusCode === undefined || rawStatusCode === null) {
    return null;
  }

  const normalizedStatusCode =
    typeof rawStatusCode === 'number'
      ? rawStatusCode
      : typeof rawStatusCode === 'string'
        ? Number(rawStatusCode.trim())
        : Number.NaN;
  if (Number.isFinite(normalizedStatusCode)) {
    return String(normalizedStatusCode);
  }

  const statusCodeText = String(rawStatusCode).trim();
  return statusCodeText || null;
}

function readAssistantContent(data: unknown): string {
  if (!isRecord(data)) {
    return '';
  }
  const choices = data.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const message = (choices[0] as Record<string, unknown>).message;
    if (isRecord(message)) {
      const content = message.content;
      if (typeof content === 'string') {
        return content;
      }
    }
  }

  return (
    readString(data, ['content', 'reply', 'answer', 'text', 'output']) ??
    readString(isRecord(data.data) ? data.data : {}, ['content', 'reply', 'answer', 'text', 'output']) ??
    ''
  );
}

function createMiniMaxFetchFailureMessage(prefix: string, message: string, baseUrl: string): string {
  return (
    `${prefix}：${message}。` +
    `当前 Base URL：${baseUrl}。` +
    '如果终端 curl 能访问但 Chrome 扩展仍失败，请在 chrome://extensions 重新加载 bAI，' +
    '并确认扩展的“站点访问权限”未被限制；manifest 需要允许 api.minimax.io / api.minimaxi.com 的 host_permissions 与 connect-src。'
  );
}

function createMiniMaxHttpErrorMessage(status: number, detail: string): string {
  return `MiniMax 连接失败：HTTP ${status} ${detail}`;
}

/**
 * 思考模式控制字段（按模型分支）：
 *
 * 官方文档说明（https://platform.minimaxi.com/docs/api-reference/text-anthropic-api）：
 *   - `MiniMax-M3`：默认开启 thinking，**可以关闭**。v2 协议 `/v1/text/chatcompletion_v2`
 *     下 `thinking.type` 只接受 `adaptive`（开启）和 `disabled`（关闭）两个值——
 *     **不接受 `enabled`**，传了会返回 2013 invalid params。
 *   - M2.x 系列（含 M2.7 / M2.7-highspeed）：**thinking 无法关闭**，传 disabled 也保持开启。
 *
 * 所以本函数：
 *   - 对 M2.x 系列：忽略用户设置，永远不发 thinking 字段（让服务端按默认行为；服务端始终带 thinking）
 *   - 对 M3：把用户意图的 `enabled` 翻译成 v2 协议接受的 `adaptive`；`disabled` 直接发
 *     - 用户开启 → 发 `{ type: 'adaptive' }`，M3 进入 thinking 模式
 *     - 用户关闭 → 发 `{ type: 'disabled' }`，M3 走 non-thinking 模式
 *
 * 返回的字段会 spread 到请求体里，类型为 `Record<string, unknown>` 避免 TS 推断失败。
 */
function buildThinkingFieldForRequest(input: {
  readonly model: string;
  readonly thinkingMode: 'disabled' | 'enabled';
}): Record<string, unknown> {
  if (!isM3Model(input.model)) {
    // M2.x 系列：服务端始终带 thinking，前端无法控制
    return {};
  }

  // v2 协议只接受 adaptive / disabled；用户开启 → adaptive（等同开启 thinking）
  const v2Type = input.thinkingMode === 'enabled' ? 'adaptive' : 'disabled';
  return { thinking: { type: v2Type } };
}

function isM3Model(model: string): boolean {
  return model === 'MiniMax-M3';
}

/**
 * 把单条 SSE event（多个 `data:` 行，注释行 / 心跳行可选）解析成结构化结果。
 *
 * 支持的协议细节：
 * - `data: [DONE]` → 终止信号
 * - `data: {json}` → 尝试 JSON.parse，失败抛 `MinimaxStreamParseError`
 * - 注释行（`:` 开头）和空行跳过
 * - 多个 `data:` 行会按 \n 拼接后再 parse（OpenAI / MiniMax v2 都不会发这种）
 * - 任何状态码、错误体格式都视为 data 载荷；上层不区分
 */
export type ParsedSseEvent =
  | { readonly kind: 'done' }
  | {
      readonly kind: 'data';
      readonly text: string;
      readonly reasoning: string;
    };

export function parseSseEvent(rawEvent: string): readonly ParsedSseEvent[] {
  const lines = rawEvent.split('\n');
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line) {
      continue;
    }
    // SSE 注释行（heartbeat）
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length).trimStart();
      dataLines.push(value);
    }
    // 其它字段（event:、id:、retry:）本场景下忽略
  }

  if (dataLines.length === 0) {
    return [];
  }

  const results: ParsedSseEvent[] = [];
  for (const data of dataLines) {
    if (data === '[DONE]') {
      results.push({ kind: 'done' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MinimaxStreamParseError(
        `MiniMax SSE 解析失败：${message}`,
        data,
      );
    }

    const text = readSseDeltaContent(parsed);
    const reasoning = readSseDeltaReasoning(parsed);
    results.push({ kind: 'data', text, reasoning });
  }

  return results;
}

function readSseDeltaContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const choices = (payload as { readonly choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const first = choices[0];
  if (!first || typeof first !== 'object') {
    return '';
  }
  const delta = (first as { readonly delta?: unknown }).delta;
  if (!delta || typeof delta !== 'object') {
    return '';
  }
  const content = (delta as { readonly content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

function readSseDeltaReasoning(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const choices = (payload as { readonly choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const first = choices[0];
  if (!first || typeof first !== 'object') {
    return '';
  }
  const delta = (first as { readonly delta?: unknown }).delta;
  if (!delta || typeof delta !== 'object') {
    return '';
  }
  const messageRecord = delta as Record<string, unknown>;
  for (const name of ['reasoning_content', 'reasoning', 'thinking']) {
    const value = messageRecord[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { readonly name?: unknown }).name;
  if (name === 'AbortError') {
    return true;
  }
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === 'string' && /aborted/i.test(message);
}

/**
 * 流式解析过程中遇到不可恢复的协议/数据错误时抛出。`rawChunk` 保留出错时的
 * 原始 SSE 文本，便于排错（行号、字段名错位等）。
 */
export class MinimaxStreamParseError extends Error {
 constructor(message: string, readonly rawChunk: string) {
 super(message);
 this.name = 'MinimaxStreamParseError';
 }
}

/**
 * Round12: 流式不被服务端支持时抛出。
 * - content-type 不是 text/event-stream（鉴权失败 /余额不足 / 参数错误）
 * -收到首个字节后 N秒内没解析出任何 SSE事件（silent hang）
 *
 * 调用方拿到这个错误**应该**回退到 chat() + 单 chunk推送，避免 side panel
 *永远卡在「正在回答…」。
 */
export class MinimaxStreamUnsupportedError extends LanguageModelStreamUnsupportedError {
 constructor(message: string, readonly body: string) {
 super(message, body);
 this.name = 'MinimaxStreamUnsupportedError';
 }
}

/**
 * Round12: 包一层 idle timeout，超过 N毫秒 reader.read() 没返回就抛
 * MinimaxStreamUnsupportedError。
 */
async function raceReaderRead(
 reader: ReadableStreamDefaultReader<Uint8Array>,
 idleTimeoutMs: number,
 getSnapshot: () => {
 readonly buffer: string;
 readonly sawAnyEvent: boolean;
 readonly firstReadAt: number | null;
 },
): Promise<ReadableStreamReadResult<Uint8Array>> {
 const snapshot = getSnapshot();
 // 已经收到首个字节但还没解析出任何事件 → 真 silent hang，需要 guard
 const needGuard = snapshot.firstReadAt !== null && !snapshot.sawAnyEvent;
 if (!needGuard) {
 return await reader.read();
 }
 return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
 const timer = setTimeout(() => {
 reject(
 new MinimaxStreamUnsupportedError(
 `MiniMax 流式响应 idle 超时（${idleTimeoutMs}ms 内未解析出任何 SSE事件）。` +
 '可能是服务端临时不支持流式 / 网络中间层缓冲。controller 应该 fallback 到 chat()。' +
 `当前 buffer（${snapshot.buffer.length}字符）: ${truncateForError(snapshot.buffer,200)}`,
 snapshot.buffer,
 ),
 );
 }, idleTimeoutMs);
 reader.read().then(
 (result) => {
 clearTimeout(timer);
 resolve(result);
 },
 (err) => {
 clearTimeout(timer);
 reject(err);
 },
 );
 });
}

/**
 * Round12: 流式读 body拿到完整字符串（SSE content-type探测失败时用于错误详情）。
 */
async function safeReadBodyAsText(body: ReadableStream<Uint8Array>): Promise<string> {
 const reader = body.getReader();
 const decoder = new TextDecoder('utf-8');
 let text = '';
 try {
 while (true) {
 const { done, value } = await reader.read();
 if (done) break;
 text += decoder.decode(value, { stream: true });
 }
 } finally {
 try {
 reader.releaseLock();
 } catch {
 //忽略
 }
 }
 return text;
}

function truncateForError(text: string, max: number): string {
 if (text.length <= max) return text;
 return text.slice(0, max) + `…(共 ${text.length}字符)`;
}

/**
 * v2 协议下，开启 thinking 时服务端可能把思考内容放在 `reasoning_content` 字段
 * （或类似命名 `reasoning` / `thinking`），`message.content` 反而只含最终答案。
 *
 * 这里统一从 message 对象上读 reasoning 字段。最终 content 非空时会用
 * `<think>...</think>` 保留 reasoning；最终 content 为空时直接把 reasoning 当兜底正文，
 * 避免 JSON 任务被剥成空字符串。
 */
function readReasoningContent(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const value = (message as Record<string, unknown>).reasoning_content;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readFieldByName(data: unknown, names: readonly string[]): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const root = data as Record<string, unknown>;
  for (const name of names) {
    const direct = root[name];
    if (typeof direct === 'string' && direct.trim().length > 0) {
      return direct.trim();
    }
  }
  const choices = root.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const message = (choices[0] as Record<string, unknown>).message;
    if (message && typeof message === 'object') {
      for (const name of names) {
        const value = (message as Record<string, unknown>)[name];
        if (typeof value === 'string' && value.trim().length > 0) {
          return value.trim();
        }
      }
    }
  }
  return undefined;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringifyDetail(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function parseJsonBodyOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
