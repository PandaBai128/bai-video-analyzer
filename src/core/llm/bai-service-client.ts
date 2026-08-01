import {
  normalizeBaiServiceUrl,
  type BaiServiceQuotaSnapshot,
  type BaiServiceSettings,
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

export class BaiServiceClient implements LanguageModelClient {
  private accessToken: string;
  private tokenExpiresAtMs: number | null;

  constructor(private readonly settings: BaiServiceSettings) {
    this.accessToken = settings.accessToken.trim();
    this.tokenExpiresAtMs = parseExpiresAt(settings.tokenExpiresAt);
  }

  async testAuth(signal?: AbortSignal): Promise<LanguageModelAuthTestResult> {
    const startedAt = Date.now();
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
      signal
        ? { signal, maxTokens: 32, usageFeature: 'test' }
        : { maxTokens: 32, usageFeature: 'test' },
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
    const data = await this.requestChat(messages, options, false);
    const content = stripThinkSections(readAssistantContent(data)).trim();
    if (!content) {
      const detail = stringifyDetail(data);
      throw new LanguageModelApiError(
        `bAI 服务返回了空内容：响应片段：${truncateForError(detail, 500)}`,
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
    const response = await this.requestStream(messages, options);
    if (!response.body) {
      throw new LanguageModelStreamUnsupportedError('bAI 服务流式响应没有 body', '');
    }

    const decoder = new TextDecoder('utf-8');
    const reader = response.body.getReader();
    let buffer = '';
    const thinkFilter = createThinkTagContentFilter();

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
          throw new Error(`bAI 服务流式读取失败：${message}`);
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
          const parsed = parseBaiServiceSseEvent(rawEvent);
          if (parsed.done) {
            finished = true;
            break;
          }
          if (parsed.text) {
            const text = thinkFilter.push(parsed.text);
            if (text) {
              yield { text, done: false };
            }
          }
          eventBoundary = findSseEventBoundary(buffer);
        }

        if (!finished && readResult.done) {
          const rawEvent = buffer;
          buffer = '';
          if (rawEvent.trim()) {
            const parsed = parseBaiServiceSseEvent(rawEvent);
            if (parsed.text) {
              const text = thinkFilter.push(parsed.text);
              if (text) {
                yield { text, done: false };
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

    const tail = thinkFilter.flush();
    if (tail) {
      yield { text: tail, done: false };
    }
    yield { text: '', done: true };
  }

  async getQuota(signal?: AbortSignal): Promise<BaiServiceQuotaSnapshot> {
    const token = await this.ensureToken(signal);
    const requestInit: RequestInit = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    };
    if (signal) {
      requestInit.signal = signal;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/me/quota`, requestInit);
    } catch (error) {
      if (isAbortError(error)) {
        throw new LanguageModelApiError('请求已取消', null, '');
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`bAI 免费服务额度查询失败：${message}。`);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new LanguageModelApiError(
        createHttpErrorMessage(response.status, detail),
        response.status,
        detail,
      );
    }

    return (await response.json()) as BaiServiceQuotaSnapshot;
  }

  private get baseUrl(): string {
    return normalizeBaiServiceUrl(this.settings.serviceUrl);
  }

  private async requestChat(
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelChatOptions,
    stream: boolean,
  ): Promise<unknown> {
    const response = await this.requestChatResponse(messages, options, stream, 'application/json');

    if (!response.ok) {
      const detail = await response.text();
      throw new LanguageModelApiError(
        createHttpErrorMessage(response.status, detail),
        response.status,
        detail,
      );
    }

    return (await response.json()) as unknown;
  }

  private async requestStream(
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelStreamOptions,
  ): Promise<Response> {
    const response = await this.requestChatResponse(messages, options, true, 'text/event-stream');

    if (!response.ok) {
      const detail = await response.text();
      throw new LanguageModelApiError(
        createHttpErrorMessage(response.status, detail),
        response.status,
        detail,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const body = response.body ? await safeReadBodyAsText(response.body) : '';
      throw new LanguageModelStreamUnsupportedError(
        `bAI 服务流式响应不是 SSE（content-type=${contentType || '<empty>'}）。body: ${truncateForError(body, 240)}`,
        body,
      );
    }

    return response;
  }

  private async requestChatResponse(
    messages: readonly LanguageModelChatMessage[],
    options: LanguageModelChatOptions,
    stream: boolean,
    accept: string,
  ): Promise<Response> {
    if (!this.settings.serviceUrl.trim()) {
      throw new LanguageModelApiError('bAI 服务地址为空', null, '');
    }
    if (!this.settings.model.trim()) {
      throw new LanguageModelApiError('bAI 服务模型名称为空', null, '');
    }

    const token = await this.ensureToken(options.signal);
    const body = {
      model: options.model ?? this.settings.model,
      messages,
      maxTokens: options.maxTokens ?? 4096,
      stream,
      feature: options.usageFeature ?? 'followup',
    };

    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: accept,
      },
      body: JSON.stringify(body),
    };
    if (options.signal) {
      requestInit.signal = options.signal;
    }

    try {
      return await fetch(`${this.baseUrl}/chat`, requestInit);
    } catch (error) {
      if (isAbortError(error)) {
        throw new LanguageModelApiError('请求已取消', null, '');
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`bAI 免费服务请求失败：${message}。`);
    }
  }

  private async ensureToken(signal?: AbortSignal): Promise<string> {
    if (this.accessToken && !isExpiredSoon(this.tokenExpiresAtMs)) {
      return this.accessToken;
    }
    if (!this.settings.inviteCode.trim()) {
      throw new LanguageModelApiError('bAI 服务邀请码为空', null, '');
    }

    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ code: this.settings.inviteCode.trim() }),
    };
    if (signal) {
      requestInit.signal = signal;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/auth/invite`, requestInit);
    } catch (error) {
      if (isAbortError(error)) {
        throw new LanguageModelApiError('请求已取消', null, '');
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`bAI 服务邀请码验证失败：${message}。`);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new LanguageModelApiError(
        createHttpErrorMessage(response.status, detail),
        response.status,
        detail,
      );
    }

    const data = (await response.json()) as unknown;
    const token = readString(data, ['token']);
    if (!token) {
      const detail = stringifyDetail(data);
      throw new LanguageModelApiError(
        `bAI 服务没有返回访问 token：${truncateForError(detail, 300)}`,
        null,
        detail,
      );
    }

    this.accessToken = token;
    this.tokenExpiresAtMs = parseExpiresAt(readString(data, ['expiresAt']) ?? undefined);
    return this.accessToken;
  }
}

export function parseBaiServiceSseEvent(rawEvent: string): {
  readonly done: boolean;
  readonly text: string;
} {
  const lines = rawEvent.split(/\r?\n/);
  let eventName = '';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (eventName === 'done') {
    return { done: true, text: '' };
  }

  let text = '';
  for (const data of dataLines) {
    if (data === '[DONE]') {
      return { done: true, text };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`bAI 服务 SSE 解析失败：${message}`);
    }
    text += readSseContent(parsed);
  }

  return { done: false, text };
}

function readAssistantContent(data: unknown): string {
  const directContent = readString(data, ['content']);
  if (directContent !== null) {
    return directContent;
  }

  const choices = readArray(data, ['choices']);
  const first = choices[0];
  return (
    readString(first, ['message', 'content']) ??
    readString(first, ['delta', 'content']) ??
    readString(first, ['text']) ??
    ''
  );
}

function readSseContent(data: unknown): string {
  const directContent = readString(data, ['content']);
  if (directContent !== null) {
    return directContent;
  }
  const choices = readArray(data, ['choices']);
  const first = choices[0];
  return (
    readString(first, ['delta', 'content']) ??
    readString(first, ['message', 'content']) ??
    readString(first, ['text']) ??
    ''
  );
}

export function stripThinkSections(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '')
    .trimStart();
}

function createThinkTagContentFilter(): {
  readonly push: (text: string) => string;
  readonly flush: () => string;
} {
  let buffer = '';
  let insideThink = false;

  function drain(final: boolean): string {
    let text = buffer;
    buffer = '';
    let output = '';

    while (text) {
      const lower = text.toLowerCase();
      if (insideThink) {
        const closeIndex = lower.indexOf('</think>');
        if (closeIndex < 0) {
          buffer = final ? '' : keepPotentialTagSuffix(text, '</think>');
          return output;
        }
        text = text.slice(closeIndex + '</think>'.length);
        insideThink = false;
        continue;
      }

      const openMatch = /<think\b[^>]*>/i.exec(text);
      if (!openMatch) {
        const danglingOpenIndex = lower.lastIndexOf('<think');
        if (!final && danglingOpenIndex >= 0 && !text.slice(danglingOpenIndex).includes('>')) {
          output += text.slice(0, danglingOpenIndex);
          buffer = text.slice(danglingOpenIndex);
          return output;
        }
        if (final) {
          output += text;
          return output;
        }
        const keepLength = getPotentialOpenTagPrefixLength(text);
        output += text.slice(0, text.length - keepLength);
        buffer = text.slice(text.length - keepLength);
        return output;
      }

      output += text.slice(0, openMatch.index);
      text = text.slice(openMatch.index + openMatch[0].length);
      insideThink = true;
    }

    return output;
  }

  return {
    push(text: string): string {
      buffer += text;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}

function getPotentialOpenTagPrefixLength(text: string): number {
  const lower = text.toLowerCase();
  const token = '<think';
  const maxLength = Math.min(token.length - 1, lower.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (token.startsWith(lower.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function keepPotentialTagSuffix(text: string, token: string): string {
  const lower = text.toLowerCase();
  const maxLength = Math.min(token.length - 1, lower.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (token.startsWith(lower.slice(-length))) {
      return text.slice(-length);
    }
  }
  return '';
}

function readArray(value: unknown, path: readonly string[]): readonly unknown[] {
  const found = readPath(value, path);
  return Array.isArray(found) ? found : [];
}

function readString(value: unknown, path: readonly string[]): string | null {
  const found = readPath(value, path);
  return typeof found === 'string' ? found : null;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseExpiresAt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExpiredSoon(expiresAtMs: number | null): boolean {
  if (expiresAtMs === null) {
    return false;
  }
  return expiresAtMs - Date.now() < 30_000;
}

function createHttpErrorMessage(status: number, detail: string): string {
  const parsed = tryParseJson(detail);
  const message =
    readString(parsed, ['message']) ??
    readString(parsed, ['error', 'message']) ??
    readString(parsed, ['error']) ??
    detail;
  return `bAI 服务请求失败（HTTP ${status}）：${truncateForError(message, 240)}`;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function safeReadBodyAsText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let output = '';
  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      output += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 忽略释放失败。
    }
  }
  return output;
}

function findSseEventBoundary(
  buffer: string,
): { readonly index: number; readonly length: number } | null {
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

function stringifyDetail(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateForError(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
