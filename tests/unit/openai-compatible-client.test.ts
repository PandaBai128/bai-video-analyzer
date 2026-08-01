import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageModelStreamUnsupportedError } from '@core/llm/language-model-client';
import {
  OpenAiCompatibleClient,
  parseOpenAiCompatibleSseEvent,
} from '@core/llm/openai-compatible-client';
import type { OpenAiCompatibleSettings } from '@shared/settings';

const SETTINGS: OpenAiCompatibleSettings = {
  providerId: 'qwen',
  apiKey: 'sk-test',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
  model: 'qwen-plus',
};

describe('OpenAiCompatibleClient', () => {
  let lastRequest: { url: string; init: RequestInit } | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
    lastRequest = null;
  });

  function stubJsonResponse(payload: unknown, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        lastRequest = {
          url: typeof input === 'string' ? input : input.toString(),
          init: init ?? {},
        };
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  }

  function requestBody(): Record<string, unknown> {
    expect(lastRequest).not.toBeNull();
    return JSON.parse(String(lastRequest?.init.body)) as Record<string, unknown>;
  }

  it('posts to baseUrl + /chat/completions without stripping provider-specific path', async () => {
    stubJsonResponse({
      model: 'qwen-plus',
      choices: [{ message: { content: '你好' } }],
    });

    const client = new OpenAiCompatibleClient(SETTINGS);
    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(lastRequest?.url).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(requestBody()).toMatchObject({
      model: 'qwen-plus',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toMatchObject({ content: '你好', model: 'qwen-plus' });
  });

  it('uses model override when provided', async () => {
    stubJsonResponse({
      model: 'override-model',
      choices: [{ message: { content: 'ok' } }],
    });

    const client = new OpenAiCompatibleClient(SETTINGS);
    await client.chat([{ role: 'user', content: 'hi' }], { model: 'override-model' });

    expect(requestBody().model).toBe('override-model');
  });

  it('passes maxTokens override to request body', async () => {
    stubJsonResponse({
      model: 'qwen-plus',
      choices: [{ message: { content: 'ok' } }],
    });

    const client = new OpenAiCompatibleClient(SETTINGS);
    await client.chat([{ role: 'user', content: 'hi' }], { maxTokens: 8192 });

    expect(requestBody().max_tokens).toBe(8192);
  });

  it('keeps the generic OpenAI-compatible request body minimal', async () => {
    stubJsonResponse({
      model: 'qwen-plus',
      choices: [{ message: { content: 'ok' } }],
    });

    const client = new OpenAiCompatibleClient(SETTINGS);
    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(requestBody()).toMatchObject({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      stream: false,
      temperature: 0,
    });
    expect(requestBody()).not.toHaveProperty('response_format');
    expect(requestBody()).not.toHaveProperty('thinking');
  });

  it('does not send temperature for Kimi because current Kimi models constrain that field', async () => {
    stubJsonResponse({
      model: 'kimi-k2.6',
      choices: [{ message: { content: 'ok' } }],
    });

    const client = new OpenAiCompatibleClient({
      ...SETTINGS,
      providerId: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2.6',
    });
    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(requestBody()).toMatchObject({
      model: 'kimi-k2.6',
      stream: false,
    });
    expect(requestBody()).not.toHaveProperty('temperature');
    expect(requestBody()).not.toHaveProperty('response_format');
  });

  it('combines separate reasoning content with final content for downstream stripping', async () => {
    stubJsonResponse({
      model: 'test-model',
      choices: [
        {
          message: {
            reasoning_content: '先想一下',
            content: '{"ok":true}',
          },
        },
      ],
    });

    const client = new OpenAiCompatibleClient(SETTINGS);
    const result = await client.chat([{ role: 'user', content: 'json' }]);

    expect(result.content).toBe('<think>先想一下</think>\n{"ok":true}');
  });

  it('treats thought fields as reasoning content', async () => {
    stubJsonResponse({
      model: 'test-model',
      choices: [
        {
          message: {
            thought: '本地兼容层的思考字段',
            content: '{"ok":true}',
          },
        },
      ],
    });

    const client = new OpenAiCompatibleClient(SETTINGS);
    const result = await client.chat([{ role: 'user', content: 'json' }]);

    expect(result.content).toBe('<think>本地兼容层的思考字段</think>\n{"ok":true}');
  });

  it('streams OpenAI-compatible SSE chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        lastRequest = {
          url: typeof input === 'string' ? input : input.toString(),
          init: init ?? {},
        };
        return new Response(
          [
            'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
            'data: [DONE]\n\n',
          ].join(''),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }),
    );

    const client = new OpenAiCompatibleClient(SETTINGS);
    const chunks = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(requestBody()).toMatchObject({ stream: true });
    expect(chunks).toEqual([
      { text: '', reasoning: '想', done: false },
      { text: '你', done: false },
      { text: '', done: true },
    ]);
  });

  it('streams thought fields as reasoning chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"thought":"先想"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"最终"}}]}\n\n',
            'data: [DONE]\n\n',
          ].join(''),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );

    const client = new OpenAiCompatibleClient(SETTINGS);
    const chunks = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { text: '', reasoning: '先想', done: false },
      { text: '最终', done: false },
      { text: '', done: true },
    ]);
  });

  it('passes maxTokens override to stream request body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        lastRequest = {
          url: typeof input === 'string' ? input : input.toString(),
          init: init ?? {},
        };
        return new Response('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const client = new OpenAiCompatibleClient(SETTINGS);
    const chunks = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { maxTokens: 8192 })) {
      chunks.push(chunk);
    }

    expect(requestBody().max_tokens).toBe(8192);
  });

  it('streams CRLF-delimited SSE chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n',
            'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n',
            'data: [DONE]\r\n\r\n',
          ].join(''),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );

    const client = new OpenAiCompatibleClient(SETTINGS);
    const chunks = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { text: '你', done: false },
      { text: '好', done: false },
      { text: '', done: true },
    ]);
  });

  it('flushes the final SSE event even without a trailing blank line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('data: {"choices":[{"delta":{"content":"最后一段"}}]}', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const client = new OpenAiCompatibleClient(SETTINGS);
    const chunks = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { text: '最后一段', done: false },
      { text: '', done: true },
    ]);
  });

  it('throws stream unsupported for HTTP 200 JSON body so controllers can fallback to chat()', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'not sse' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const client = new OpenAiCompatibleClient(SETTINGS);
    const consume = async (): Promise<void> => {
      for await (const _chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
        // consume
      }
    };

    await expect(consume()).rejects.toThrowError(LanguageModelStreamUnsupportedError);
  });
});

describe('parseOpenAiCompatibleSseEvent', () => {
  it('parses content, reasoning, and done events', () => {
    expect(
      parseOpenAiCompatibleSseEvent(
        [
          'data: {"choices":[{"delta":{"content":"A"}}]}',
          'data: {"choices":[{"delta":{"reasoning_content":"B"}}]}',
          'data: [DONE]',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'data', text: 'A', reasoning: '' },
      { kind: 'data', text: '', reasoning: 'B' },
      { kind: 'done' },
    ]);
  });
});
