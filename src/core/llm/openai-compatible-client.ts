import {
  getLanguageModelProviderPreset,
  normalizeOpenAiCompatibleBaseUrl,
  type OpenAiCompatibleSettings,
} from '@shared/settings';
import {
  LanguageModelApiError,
  LanguageModelStreamUnsupportedError,
  type LanguageModelAuthTestResult,
  type LanguageModelChatMessage,
  type LanguageModelChatOptions,
  type LanguageModelChatResult,
  type LanguageModelClient,
  type LanguageModelStreamChunk,
  type LanguageModelStreamOptions,
} from './language-model-client';

export class OpenAiCompatibleClient implements LanguageModelClient {
  constructor(private readonly settings: OpenAiCompatibleSettings) {}

  async testAuth(signal?: AbortSignal): Promise<LanguageModelAuthTestResult> {
    const startedAt = Date.now();
    const options: LanguageModelChatOptions = signal ? { signal } : {};
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
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelChatOptions = {},
  ): Promise<LanguageModelChatResult> {
    const data = await this.requestChatCompletion(messages, options, false);
    const rawContent = readAssistantContent(data).trim();
    const reasoning = readReasoningContent(data);
    const content =
      reasoning && rawContent
        ? `<think>${reasoning}</think>\n${rawContent}`
        : rawContent || reasoning || '';

    if (!content.trim()) {
      const detail = stringifyDetail(data);
      throw new LanguageModelApiError(
        `${this.providerName} 返回了空内容：没有找到可用的 message.content / reasoning_content。响应片段：${truncateForError(detail, 500)}`,
        null,
        detail,
      );
    }

    return {
      content,
      model: readString(data, ['model']) ?? options.model ?? this.settings.model,
      rawResponse: data,
    };
  }

  async *streamChat(
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelStreamOptions = {},
  ): AsyncGenerator<LanguageModelStreamChunk, void, void> {
    const response = await this.requestStreamCompletion(messages, options);
    if (!response.body) {
      throw new LanguageModelStreamUnsupportedError(
        `${this.providerName} 流式响应没有 body`,
        '',
      );
    }

    const decoder = new TextDecoder('utf-8');
    const reader = response.body.getReader();
    let buffer = '';

    try {
      let finished = false;
      while (!finished) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          if (isAbortError(error)) {
            throw new LanguageModelApiError('请求已取消', null, '');
          }
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${this.providerName} 流式读取失败：${message}`);
        }

        if (readResult.done) {
          buffer += decoder.decode();
        } else {
          buffer += decoder.decode(readResult.value, { stream: true });
        }

        let eventBoundary = findSseEventBoundary(buffer);
        while (eventBoundary) {
          const rawEvent = buffer.slice(0, eventBoundary.index);
          buffer = buffer.slice(eventBoundary.index + eventBoundary.length);

          for (const event of parseOpenAiCompatibleSseEvent(rawEvent, this.providerName)) {
            if (event.kind === 'done') {
              finished = true;
              break;
            }
            if (event.reasoning) {
              yield { text: '', reasoning: event.reasoning, done: false };
            }
            if (event.text) {
              yield { text: event.text, done: false };
            }
          }

          if (finished) {
            break;
          }
          eventBoundary = findSseEventBoundary(buffer);
        }

        if (!finished && readResult.done) {
          const rawEvent = buffer;
          buffer = '';
          if (rawEvent.trim()) {
            for (const event of parseOpenAiCompatibleSseEvent(rawEvent, this.providerName)) {
              if (event.kind === 'done') {
                finished = true;
                break;
              }
              if (event.reasoning) {
                yield { text: '', reasoning: event.reasoning, done: false };
              }
              if (event.text) {
                yield { text: event.text, done: false };
              }
            }
          }
          finished = true;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 释放锁失败不影响主流程。
      }
    }

    yield { text: '', done: true };
  }

  private get providerName(): string {
    return getLanguageModelProviderPreset(this.settings.providerId).name;
  }

  private get chatEndpoint(): string {
    return `${normalizeOpenAiCompatibleBaseUrl(this.settings.baseUrl)}/chat/completions`;
  }

  private async requestChatCompletion(
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelChatOptions,
    stream: boolean,
  ): Promise<unknown> {
    const response = await this.requestCompletion(messages, options, stream, 'application/json');

    if (!response.ok) {
      const detail = await response.text();
      throw new LanguageModelApiError(
        createHttpErrorMessage(this.providerName, response.status, detail),
        response.status,
        detail,
      );
    }

    return (await response.json()) as unknown;
  }

  private async requestStreamCompletion(
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelStreamOptions,
  ): Promise<Response> {
    const response = await this.requestCompletion(messages, options, true, 'text/event-stream');

    if (!response.ok) {
      const detail = await response.text();
      throw new LanguageModelApiError(
        createHttpErrorMessage(this.providerName, response.status, detail),
        response.status,
        detail,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const body = response.body ? await safeReadBodyAsText(response.body) : '';
      throw new LanguageModelStreamUnsupportedError(
        `${this.providerName} 流式响应不是 SSE（content-type=${contentType || '<empty>'}）。body: ${truncateForError(body, 240)}`,
        body,
      );
    }

    return response;
  }

  private async requestCompletion(
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelChatOptions,
    stream: boolean,
    accept: string,
  ): Promise<Response> {
    if (!this.settings.apiKey.trim()) {
      throw new LanguageModelApiError(`${this.providerName} API Key 为空`, null, '');
    }
    if (!this.settings.model.trim()) {
      throw new LanguageModelApiError(`${this.providerName} 模型名称为空`, null, '');
    }
    if (!this.settings.baseUrl.trim()) {
      throw new LanguageModelApiError(`${this.providerName} Base URL 为空`, null, '');
    }

    const body: Record<string, unknown> = {
      model: options.model ?? this.settings.model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      stream,
    };
    if (this.settings.providerId !== 'kimi') {
      body.temperature = 0;
    }

    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
        Accept: accept,
      },
      body: JSON.stringify(body),
    };
    if (options.signal) {
      requestInit.signal = options.signal;
    }

    try {
      return await fetch(this.chatEndpoint, requestInit);
    } catch (error) {
      if (isAbortError(error)) {
        throw new LanguageModelApiError('请求已取消', null, '');
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${this.providerName} 请求失败：${message}。当前 Base URL：${normalizeOpenAiCompatibleBaseUrl(this.settings.baseUrl)}。`,
      );
    }
  }
}

type ParsedOpenAiCompatibleSseEvent =
  | { readonly kind: 'done' }
  | { readonly kind: 'data'; readonly text: string; readonly reasoning: string };

export function parseOpenAiCompatibleSseEvent(
  rawEvent: string,
  providerName = 'OpenAI-compatible Provider',
): readonly ParsedOpenAiCompatibleSseEvent[] {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  const events: ParsedOpenAiCompatibleSseEvent[] = [];
  for (const data of dataLines) {
    if (data === '[DONE]') {
      events.push({ kind: 'done' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${providerName} SSE 解析失败：${message}`);
    }

    events.push({
      kind: 'data',
      text: readSseDeltaContent(parsed),
      reasoning: readSseDeltaReasoning(parsed),
    });
  }
  return events;
}

function findSseEventBoundary(buffer: string): { readonly index: number; readonly length: number } | null {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');

  if (lfIndex < 0 && crlfIndex < 0) {
    return null;
  }
  if (lfIndex >= 0 && (crlfIndex < 0 || lfIndex < crlfIndex)) {
    return { index: lfIndex, length: 2 };
  }
  return { index: crlfIndex, length: 4 };
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
      if (Array.isArray(content)) {
        return content
          .map((part) =>
            isRecord(part) && typeof part.text === 'string'
              ? part.text
              : isRecord(part) && typeof part.content === 'string'
                ? part.content
                : '',
          )
          .join('');
      }
    }
  }
  return readString(data, ['content', 'reply', 'answer', 'text', 'output']) ?? '';
}

function readReasoningContent(data: unknown): string {
  if (!isRecord(data)) {
    return '';
  }
  const choices = data.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) && isRecord(first.message) ? first.message : {};
  return (
    readString(message, REASONING_FIELD_KEYS) ??
    readString(data, REASONING_FIELD_KEYS) ??
    ''
  );
}

function readSseDeltaContent(payload: unknown): string {
  const delta = readFirstChoiceDelta(payload);
  return readString(delta, ['content', 'text']) ?? '';
}

function readSseDeltaReasoning(payload: unknown): string {
  const delta = readFirstChoiceDelta(payload);
  return readString(delta, REASONING_FIELD_KEYS) ?? '';
}

const REASONING_FIELD_KEYS = [
  'reasoning_content',
  'reasoning',
  'thinking',
  'thought',
  'thoughts',
] as const;

function readFirstChoiceDelta(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return {};
  }
  const first = payload.choices[0];
  if (!isRecord(first)) {
    return {};
  }
  if (isRecord(first.delta)) {
    return first.delta;
  }
  if (isRecord(first.message)) {
    return first.message;
  }
  return {};
}

function readString(target: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(target)) {
    return undefined;
  }
  for (const key of keys) {
    const value = target[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

async function safeReadBodyAsText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      text += decoder.decode(read.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // noop
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function stringifyDetail(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function truncateForError(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…`;
}

function createHttpErrorMessage(providerName: string, status: number, detail: string): string {
  return `${providerName} 连接失败：HTTP ${status} ${truncateForError(detail, 800)}`;
}
