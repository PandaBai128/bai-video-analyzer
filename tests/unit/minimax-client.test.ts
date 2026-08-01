import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MinimaxApiError,
  MinimaxClient,
  MinimaxStreamParseError,
  parseSseEvent,
  type MinimaxStreamChunk,
} from '@core/llm/minimax-client';
import { createDefaultTextProviderSettings } from '@shared/settings';

const TEST_SETTINGS = {
  ...createDefaultTextProviderSettings(),
  apiKey: 'sk-test',
};

describe('MinimaxClient error attribution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 模拟快速分析（chat 路径）调用时服务端返回 400 + 错误体里碰巧含 "status 412" 字样。
   * 这是用户报的 bug 触发场景：开启思考 + 切到 M3，快速分析时碰到的 4xx 错误体。
   *
   * 修复预期：chat 路径只返回通用 HTTP 错误，不出现已移除的视频 URL 分支文案。
   */
  it('reports a generic 400 error in chat()', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              code: 'invalid_request',
              message: 'thinking budget too large; status 412 in pipeline',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const client = new MinimaxClient(TEST_SETTINGS);

    await expect(
      client.chat([
        {
          role: 'user',
          content: '请基于字幕输出时间线',
        },
      ]),
    ).rejects.toThrowError(MinimaxApiError);

    try {
      await client.chat([{ role: 'user', content: 'test' }]);
    } catch (error) {
      expect((error as Error).message).not.toContain('精准分析');
      expect((error as Error).message).toMatch(/HTTP 400/);
    }
  });

  it('treats HTTP 200 + base_resp non-zero in chat() as MiniMax business error, not empty content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            base_resp: {
              status_code: 1004,
              status_msg: 'login fail: Please carry the API secret key',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const client = new MinimaxClient(TEST_SETTINGS);

    await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
      /MiniMax 业务错误：1004 login fail/,
    );
  });

  it('reports raw response snippet when chat() gets HTTP 200 but no content fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 'empty-response', choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const client = new MinimaxClient(TEST_SETTINGS);

    await expect(client.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
      /MiniMax 返回了空内容.*empty-response/,
    );
  });
});

describe('MinimaxClient request body (v2 endpoint + thinking per model)', () => {
  let lastRequest: { url: string; init: RequestInit } | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
    lastRequest = null;
  });

  function captureFetchAndReturn(content: string): void {
    lastRequest = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        lastRequest = {
          url: typeof input === 'string' ? input : input.toString(),
          init: init ?? {},
        };
        return new Response(
          JSON.stringify({
            id: 'test',
            choices: [{ message: { role: 'assistant', content } }],
            model: 'test',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
  }

  function getRequestBody(): Record<string, unknown> {
    expect(lastRequest).not.toBeNull();
    const init = lastRequest?.init;
    expect(init?.body).toBeDefined();
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  }

  it('POSTs to the v2 endpoint /v1/text/chatcompletion_v2 and preserves the configured domain', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      baseUrl: 'https://api.minimaxi.com/',
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(lastRequest?.url).toBe('https://api.minimaxi.com/v1/text/chatcompletion_v2');
  });

  it('treats OpenAI-compatible /v1 base URL as origin for native v2 chat endpoint', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      baseUrl: 'https://api.minimaxi.com/v1',
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(lastRequest?.url).toBe('https://api.minimaxi.com/v1/text/chatcompletion_v2');
  });

  it('normalizes legacy .io domain before chat posts to the verified .com endpoint', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        urls.push(url);
        return new Response(
          JSON.stringify({
            id: 'normalized-ok',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            model: 'test',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      baseUrl: 'https://api.minimax.io',
    });

    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result.content).toBe('ok');
    expect(urls).toEqual(['https://api.minimaxi.com/v1/text/chatcompletion_v2']);
  });

  it('sends thinking: { type: adaptive } for MiniMax-M3 when thinkingMode is enabled', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M3',
      thinkingMode: 'enabled',
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    // v2 协议只接受 adaptive/disabled，不接受 enabled——传 enabled 会返回 2013
    expect(getRequestBody().thinking).toEqual({ type: 'adaptive' });
  });

  it('sends thinking: { type: disabled } for MiniMax-M3 when thinkingMode is disabled', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M3',
      thinkingMode: 'disabled',
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(getRequestBody().thinking).toEqual({ type: 'disabled' });
  });

  it('omits thinking field for MiniMax-M2.7-highspeed regardless of thinkingMode (服务端强制带 thinking)', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M2.7-highspeed',
      thinkingMode: 'disabled', // 用户关掉，但服务端依然会带
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(getRequestBody().thinking).toBeUndefined();
  });

  it('omits thinking field for MiniMax-M2.7 even when user enables it (服务端无法开启/关闭)', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M2.7',
      thinkingMode: 'enabled',
    });

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(getRequestBody().thinking).toBeUndefined();
  });

  it('passes through the model override from chat() options', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M2.7-highspeed', // 默认
    });

    await client.chat([{ role: 'user', content: 'hi' }], { model: 'MiniMax-M3' });

    expect(getRequestBody().model).toBe('MiniMax-M3');
    // override 之后按 M3 走，所以 thinking 字段会按 M3 + 设置走
    expect(getRequestBody().thinking).toEqual({ type: 'disabled' });
  });

  it('passes maxTokens override to chat request body', async () => {
    captureFetchAndReturn('hi');
    const client = new MinimaxClient(TEST_SETTINGS);

    await client.chat([{ role: 'user', content: 'hi' }], { maxTokens: 8192 });

    expect(getRequestBody().max_tokens).toBe(8192);
  });
});

describe('MinimaxClient response normalization (reasoning_content)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchReturning(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  }

  it('returns raw content when no reasoning_content is present', async () => {
    stubFetchReturning({
      choices: [{ message: { role: 'assistant', content: '{"overview":"hi"}' } }],
      model: 'MiniMax-M3',
    });
    const client = new MinimaxClient({ ...TEST_SETTINGS, model: 'MiniMax-M3' });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('{"overview":"hi"}');
  });

  it('wraps reasoning_content in <think> tags and prepends to content (M3 thinking)', async () => {
    stubFetchReturning({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '{"overview":"final answer"}',
            reasoning_content: '逐步推理过程...',
          },
        },
      ],
      model: 'MiniMax-M3',
    });
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M3',
      thinkingMode: 'enabled',
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    // reasoning 应该在前面包在 <think> 标签里
    expect(result.content).toMatch(/^<think>[\s\S]*?逐步推理过程\.\.\.[\s\S]*?<\/think>\n/);
    expect(result.content).toContain('{"overview":"final answer"}');
  });

  it('uses reasoning_content directly when content is empty, so JSON tasks do not parse as blank', async () => {
    // MiniMax 可能在复杂 JSON 任务上 content 为空、reasoning_content 才含实际 JSON。
    // 此时不能包 <think>，否则下游 stripJsonFence 会把唯一内容剥掉。
    stubFetchReturning({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: '{"ok":true}',
          },
        },
      ],
      model: 'MiniMax-M3',
    });
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M3',
      thinkingMode: 'enabled',
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result.content).toBe('{"ok":true}');
  });

  it('falls back to "reasoning" field name if reasoning_content is missing', async () => {
    stubFetchReturning({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'final',
            reasoning: 'reasoning via reasoning field',
          },
        },
      ],
      model: 'MiniMax-M3',
    });
    const client = new MinimaxClient({ ...TEST_SETTINGS, model: 'MiniMax-M3' });
    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result.content).toContain('reasoning via reasoning field');
  });
});

describe('MinimaxClient.testAuth (connects via fast model)', () => {
  let lastRequest: { url: string; init: RequestInit } | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
    lastRequest = null;
  });

  function captureFetch(): void {
    lastRequest = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        lastRequest = {
          url: typeof input === 'string' ? input : input.toString(),
          init: init ?? {},
        };
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  }

  it('uses settings.fastModel for the auth test (not settings.model)', async () => {
    captureFetch();
    // settings.model 是历史占位字段（M3），但 fastModel 是 M2.7-highspeed。
    // 连接测试必须用 fastModel，避免触发 M3 慢响应。
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M3',
      fastModel: 'MiniMax-M2.7-highspeed',
    });

    await client.testAuth();

    const body = JSON.parse(String(lastRequest?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('MiniMax-M2.7-highspeed');
  });

  it('uses settings.fastModel=M3 when user configured M3 in settings', async () => {
    captureFetch();
    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      model: 'MiniMax-M2.7-highspeed', // 历史占位
      fastModel: 'MiniMax-M3', // 用户显式选 M3
    });

    await client.testAuth();

    const body = JSON.parse(String(lastRequest?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('MiniMax-M3');
  });
});

describe('MinimaxChatResult.rawResponse (parse-failure diagnosis)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chat() returns rawResponse: the full response JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], customField: 'X' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const client = new MinimaxClient(TEST_SETTINGS);
    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result.rawResponse).toBeDefined();
    expect((result.rawResponse as { customField?: string }).customField).toBe('X');
  });

});

// ---------------------------------------------------------------------------
// 任务 0：流式 spike（streamChat + parseSseEvent）
// ---------------------------------------------------------------------------

/**
 * 构造一个 ReadableStream<Uint8Array>，模拟服务端 SSE 响应。
 * 输入是按 \n\n 划分的事件字符串数组；可以包含 [DONE]、JSON chunk。
 */
function sseResponse(events: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('parseSseEvent (纯函数)', () => {
  it('parses a single data: JSON chunk into text delta', () => {
    const event = `data: {"id":"x","choices":[{"index":0,"delta":{"content":"你好"}}]}`;

    const parsed = parseSseEvent(event);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ kind: 'data', text: '你好', reasoning: '' });
  });

  it('treats data: [DONE] as the done terminator', () => {
    const parsed = parseSseEvent('data: [DONE]');
    expect(parsed).toEqual([{ kind: 'done' }]);
  });

  it('extracts reasoning_content from delta (M3 thinking)', () => {
    const event = `data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}`;
    const parsed = parseSseEvent(event);
    expect(parsed[0]).toEqual({ kind: 'data', text: '', reasoning: 'thinking...' });
  });

  it('falls back to delta.reasoning field name when reasoning_content is absent', () => {
    const event = `data: {"choices":[{"delta":{"reasoning":"via reasoning field"}}]}`;
    const parsed = parseSseEvent(event);
    expect(parsed[0]).toEqual({
      kind: 'data',
      text: '',
      reasoning: 'via reasoning field',
    });
  });

  it('skips comment lines and event/id/retry lines', () => {
    const event = [
      ': heartbeat',
      'event: message',
      'id: 1',
      'retry: 1000',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
    ].join('\n');
    const parsed = parseSseEvent(event);
    expect(parsed).toEqual([{ kind: 'data', text: 'hi', reasoning: '' }]);
  });

  it('returns empty array for events with no data lines', () => {
    expect(parseSseEvent(': heartbeat only\n\n')).toEqual([]);
  });

  it('throws MinimaxStreamParseError with raw chunk when JSON is invalid', () => {
    const event = 'data: {not json';
    expect(() => parseSseEvent(event)).toThrowError(MinimaxStreamParseError);
    try {
      parseSseEvent(event);
    } catch (error) {
      expect((error as MinimaxStreamParseError).rawChunk).toBe('{not json');
    }
  });

  it('handles missing choices / delta gracefully (returns empty text)', () => {
    const event = 'data: {"id":"x","choices":[]}';
    const parsed = parseSseEvent(event);
    expect(parsed[0]).toEqual({ kind: 'data', text: '', reasoning: '' });
  });
});

describe('MinimaxClient.streamChat (SSE spike)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function collectChunks(
    client: MinimaxClient,
    request?: AbortController,
  ): Promise<MinimaxStreamChunk[]> {
    const chunks: MinimaxStreamChunk[] = [];
    const abort = request ?? new AbortController();
    for await (const chunk of client.streamChat(
      [{ role: 'user', content: 'hi' }],
      { signal: abort.signal },
    )) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('yields incremental text deltas in arrival order from an SSE stream', async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好，"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

    const client = new MinimaxClient(TEST_SETTINGS);
    const chunks = await collectChunks(client);

    const texts = chunks.filter((c) => c.text).map((c) => c.text);
    expect(texts).toEqual(['你', '好，', '世界']);
    expect(chunks[chunks.length - 1]?.done).toBe(true);
  });

  it('sends stream: true and posts to the v2 endpoint', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.url = typeof input === 'string' ? input : input.toString();
        captured.init = init ?? {};
        return sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']);
      }),
    );

    const client = new MinimaxClient(TEST_SETTINGS);
    await collectChunks(client);

    expect(captured.url).toBe('https://api.minimaxi.com/v1/text/chatcompletion_v2');
    const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });

  it('normalizes OpenAI-compatible /v1 base URL before streamChat posts to native v2 endpoint', async () => {
    const captured: { url?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        captured.url = typeof input === 'string' ? input : input.toString();
        return sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']);
      }),
    );

    const client = new MinimaxClient({
      ...TEST_SETTINGS,
      baseUrl: 'https://api.minimaxi.com/v1',
    });
    await collectChunks(client);

    expect(captured.url).toBe('https://api.minimaxi.com/v1/text/chatcompletion_v2');
  });

  it('yields reasoning content separately when server sends reasoning_content deltas', async () => {
    const events = [
      'data: {"choices":[{"delta":{"reasoning_content":"step 1"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"part 2"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

    const client = new MinimaxClient(TEST_SETTINGS);
    const chunks = await collectChunks(client);

    const reasoning = chunks.filter((c) => c.reasoning).map((c) => c.reasoning);
    const texts = chunks.filter((c) => c.text).map((c) => c.text);
    expect(reasoning).toEqual(['step 1']);
    expect(texts).toEqual(['answer ', 'part 2']);
  });

  it('does not drop content when one SSE event contains both reasoning_content and content', async () => {
    const events = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking","content":"final-json"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

    const client = new MinimaxClient(TEST_SETTINGS);
    const chunks = await collectChunks(client);

    expect(chunks.filter((c) => c.reasoning).map((c) => c.reasoning)).toEqual(['thinking']);
    expect(chunks.filter((c) => c.text).map((c) => c.text)).toEqual(['final-json']);
  });

  it('throws MinimaxApiError when AbortSignal is already aborted before fetch', async () => {
    // jsdom 的 fetch 是 mock；预 abort 的 signal 让 fetch 直接抛 AbortError，
    // streamChat 把它转成 MinimaxApiError('追问请求已取消')。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }),
    );

    const client = new MinimaxClient(TEST_SETTINGS);
    const abort = new AbortController();
    abort.abort();
    await expect(collectChunks(client, abort)).rejects.toThrowError(MinimaxApiError);
  });

  it('throws MinimaxApiError with HTTP status when server returns 4xx/5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'oops' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const client = new MinimaxClient(TEST_SETTINGS);
    await expect(collectChunks(client)).rejects.toThrowError(MinimaxApiError);
  });

  it('falls back to chat() when streamChat fails: non-stream path still works', async () => {
    // 模拟服务端不支持流式 → streamChat 抛错；chat() 走通用 fetch
    const fallbackFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'non-stream answer' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fallbackFetch);

    const client = new MinimaxClient(TEST_SETTINGS);

    // 直接用 chat() —— 不需要 stream，验证现有 chat() 在新代码并存下仍 OK
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('non-stream answer');
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
  });

  it('treats [DONE] inside an event as the end-of-stream marker', async () => {
 // 用单 chunk 包 [DONE] 验证解析路径
 vi.stubGlobal(
 'fetch',
 vi.fn(async () =>
 sseResponse(['data: {"choices":[{"delta":{"content":"end"}}]}\n\n', 'data: [DONE]\n\n']),
 ),
 );

 const client = new MinimaxClient(TEST_SETTINGS);
 const chunks = await collectChunks(client);
 expect(chunks[chunks.length -1]?.done).toBe(true);
 // [DONE] 之后再没有 chunk
 const afterDone = chunks.findIndex((c) => c.done);
 expect(afterDone).toBeGreaterThanOrEqual(0);
 expect(chunks.length).toBe(afterDone +1);
 });
});

// ---------------------------------------------------------------------------
// Round12: streamChat真实响应形态兼容（鉴权失败 JSON、idle timeout、
// content-type探测、fastModel override）
// ---------------------------------------------------------------------------

import { MinimaxStreamUnsupportedError } from '@core/llm/minimax-client';

describe('MinimaxClient.streamChat (Round12: v2 protocol robustness)', () => {
 afterEach(() => {
 vi.unstubAllGlobals();
 });

 function jsonErrorResponse(body: unknown): Response {
 return new Response(JSON.stringify(body), {
 status:200,
 headers: { 'Content-Type': 'application/json; charset=utf-8' },
 });
 }

 function slowNoEventStream(): Response {
 //模拟服务端 TCP 半开 / 网关缓冲：返回 content-type 是 SSE 但永远
 // 不发 \n\n也不发 [DONE]，让 idle guard触发。
 const encoder = new TextEncoder();
 const stream = new ReadableStream<Uint8Array>({
 start(controller) {
 // 发一个 data: 行但永远不跟 \n\n，触发 idle timeout。
 controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]'));
 // 不 close，等 idle guard抛错。
 },
 });
 return new Response(stream, {
 status:200,
 headers: { 'Content-Type': 'text/event-stream' },
 });
 }

 it('默认走 settings.fastModel（不是 settings.model），避免追问触发 M3', async () => {
 const captured: { body?: string } = {};
 vi.stubGlobal(
 'fetch',
 vi.fn(async (_url: unknown, init?: RequestInit) => {
 captured.body = typeof init?.body === 'string' ? init.body : '';
 return sseResponse([
 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
 'data: [DONE]\n\n',
 ]);
 }),
 );
 const settings = {
 ...createDefaultTextProviderSettings(),
 apiKey: 'sk-test',
 model: 'MiniMax-M3', //旧字段，用户没动过
 fastModel: 'MiniMax-M2.7-highspeed' as const, // 默认快速分析模型
 };
 const client = new MinimaxClient(settings);
 const chunks: MinimaxStreamChunk[] = [];
 for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
 chunks.push(chunk);
 }
 const body = JSON.parse(captured.body ?? '{}') as { model?: string };
 expect(body.model).toBe('MiniMax-M2.7-highspeed');
 });

 it('options.model显式覆盖时优先于 fastModel', async () => {
 const captured: { body?: string } = {};
 vi.stubGlobal(
 'fetch',
 vi.fn(async (_url: unknown, init?: RequestInit) => {
 captured.body = typeof init?.body === 'string' ? init.body : '';
 return sseResponse([
 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
 'data: [DONE]\n\n',
 ]);
 }),
 );
 const settings = {
 ...createDefaultTextProviderSettings(),
 apiKey: 'sk-test',
 model: 'MiniMax-M3',
 fastModel: 'MiniMax-M2.7-highspeed' as const,
 };
 const client = new MinimaxClient(settings);
 const chunks: MinimaxStreamChunk[] = [];
 for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { model: 'MiniMax-M3' })) {
 chunks.push(chunk);
 }
 const body = JSON.parse(captured.body ?? '{}') as { model?: string };
 expect(body.model).toBe('MiniMax-M3');
 });

 it('options.maxTokens 显式覆盖流式 max_tokens', async () => {
 const captured: { body?: string } = {};
 vi.stubGlobal(
 'fetch',
 vi.fn(async (_url: unknown, init?: RequestInit) => {
 captured.body = typeof init?.body === 'string' ? init.body : '';
 return sseResponse([
 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
 'data: [DONE]\n\n',
 ]);
 }),
 );
 const client = new MinimaxClient({
 ...createDefaultTextProviderSettings(),
 apiKey: 'sk-test',
 });
 const chunks: MinimaxStreamChunk[] = [];
 for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { maxTokens: 8192 })) {
 chunks.push(chunk);
 }
 const body = JSON.parse(captured.body ?? '{}') as { max_tokens?: number };
 expect(body.max_tokens).toBe(8192);
 });

 it('content-type=application/json 时抛 MinimaxStreamUnsupportedError，让 controller fallback', async () => {
 // v2协议鉴权失败 /余额不足 / 参数错误场景：服务端返回 HTTP200 +
 // application/json + base_resp.status_code !=0。
 vi.stubGlobal(
 'fetch',
 vi.fn(async () =>
 jsonErrorResponse({
 base_resp: {
 status_code:1004,
 status_msg: 'login fail: Please carry the API secret key',
 },
 }),
 ),
 );
 const client = new MinimaxClient(TEST_SETTINGS);
 const promise = (async () => {
 const chunks: MinimaxStreamChunk[] = [];
 for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
 chunks.push(chunk);
 }
 return chunks;
 })();
 await expect(promise).rejects.toThrowError(MinimaxStreamUnsupportedError);
 try {
 await promise;
 } catch (err) {
 expect(err).toBeInstanceOf(MinimaxStreamUnsupportedError);
 if (err instanceof MinimaxStreamUnsupportedError) {
 // body 必须带上，方便排查
 expect(err.body).toContain('login fail');
 //错误 message 必须提到 content-type，让用户 / controller知道是协议层失败
 expect(err.message.toLowerCase()).toContain('application/json');
 }
 }
 });

 it('normalizes legacy .io domain before streamChat posts to the verified .com endpoint', async () => {
 const urls: string[] = [];
 vi.stubGlobal(
 'fetch',
 vi.fn(async (input: RequestInfo | URL) => {
 const url = typeof input === 'string' ? input : input.toString();
 urls.push(url);
 return sseResponse([
 'data: {"choices":[{"delta":{"content":"stream-ok"}}]}\n\n',
 'data: [DONE]\n\n',
 ]);
 }),
 );
 const client = new MinimaxClient({
 ...TEST_SETTINGS,
 baseUrl: 'https://api.minimax.io',
 });
 const chunks: MinimaxStreamChunk[] = [];
 for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
 chunks.push(chunk);
 }

 expect(chunks.filter((chunk) => chunk.text).map((chunk) => chunk.text)).toEqual(['stream-ok']);
 expect(chunks[chunks.length -1]?.done).toBe(true);
 expect(urls).toEqual(['https://api.minimaxi.com/v1/text/chatcompletion_v2']);
 });

 it('content-type=application/json 且 base_resp.status_code 是2013 invalid params 也抛 unsupported', async () => {
 vi.stubGlobal(
 'fetch',
 vi.fn(async () =>
 jsonErrorResponse({
 base_resp: {
 status_code:2013,
 status_msg: 'invalid params: thinking.type not allowed',
 },
 }),
 ),
 );
 const client = new MinimaxClient(TEST_SETTINGS);
 await expect(
 (async () => {
 for await (const _chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
 // noop
 }
 })(),
 ).rejects.toThrowError(MinimaxStreamUnsupportedError);
 });

 it('idle timeout：content-type=SSE 但长时间无事件 →抛 MinimaxStreamUnsupportedError', async () => {
 // 用一个永不结束 +永远不发 \n\n 的 SSE 流模拟网络中间层缓冲。
 vi.stubGlobal('fetch', vi.fn(async () => slowNoEventStream()));
 const client = new MinimaxClient(TEST_SETTINGS);
 const start = Date.now();
 try {
 const it = client.streamChat([{ role: 'user', content: 'hi' }], { idleTimeoutMs:300 });
 for await (const _chunk of it) {
 // 不应进入循环（idle timeout 会先抛错）
 }
 throw new Error('should not reach here');
 } catch (err) {
 const elapsed = Date.now() - start;
 expect(err).toBeInstanceOf(MinimaxStreamUnsupportedError);
 //应该在 idleTimeoutMs附近抛错，不应该等到 stream永远 hang
 expect(elapsed).toBeLessThan(2_000);
 }
 });

 it('单 \\n 分隔的 SSE也能解析（兜底，避免 silent hang）', async () => {
 //模拟某些 proxy / OpenAI旧路径用单 \n 分隔事件
 // 注：jsdom ReadableStream 的实际行为是1 个 enqueue 后立即返回 done=true，
 // 我们这里测的是：即使服务端用单 \n 而不是 \n\n，单个 event也能被
 // fallback解析路径处理，不会让 streamChat永远hang。
 const events = [
 'data: {"choices":[{"delta":{"content":"你"}}]}\n',
 ];
 vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
 const client = new MinimaxClient(TEST_SETTINGS);
 const chunks: MinimaxStreamChunk[] = [];
 for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
 chunks.push(chunk);
 }
 const texts = chunks.filter((c) => c.text).map((c) => c.text);
 expect(texts).toEqual(['你']);
 expect(chunks[chunks.length -1]?.done).toBe(true);
 });

  it('正常 SSE仍然走主路径（回归测试）', async () => {
  // 确保新加的 content-type探测 / idle guard / 单 \n fallback不会破坏正常流
  const events = [
  'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"好，"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
  'data: [DONE]\n\n',
  ];
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
  const client = new MinimaxClient(TEST_SETTINGS);
  const chunks: MinimaxStreamChunk[] = [];
  for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
  chunks.push(chunk);
  }
  const texts = chunks.filter((c) => c.text).map((c) => c.text);
  expect(texts).toEqual(['你', '好，', '世界']);
  expect(chunks[chunks.length -1]?.done).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Round13: 标准 SSE 事件 + [DONE] 都应设 sawAnyEvent=true，
  // 避免 raceReaderRead 在后续 read 误判「首事件未到达」抛 unsupported。
  // 回归测试：1 个 SSE event + 大于 idleTimeoutMs 的间隔后跟 [DONE]，
  // streamChat 必须正常 yield data + done，**不能**抛 MinimaxStreamUnsupportedError。
  // -----------------------------------------------------------------------
  it('标准 SSE 事件后超过 idle 间隔不应误触发「首事件未到达」fallback', async () => {
  // 模拟 jsdom ReadableStream：发一段标准 SSE event 后等 idleTimeoutMs 仍
  // 未关闭（理论上服务端可以这么做，但为简化测试，我们直接发完两个 event
  // 立刻 done=true，重点是第 1 段就触发了 raceReaderRead 的 sawAnyEvent 分支）。
  const events = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  ];
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
  const client = new MinimaxClient(TEST_SETTINGS);
  const chunks: MinimaxStreamChunk[] = [];
  // 极短的 idleTimeoutMs（5ms）也不会误触发：sseResponse 把所有 events 一次性
  // enqueue 后立即 close，jsdom reader 在同一次 read 拿到完整 buffer。
  await expect(
  (async () => {
  for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { idleTimeoutMs:5 })) {
  chunks.push(chunk);
  }
  })(),
  ).resolves.not.toThrow();
  const texts = chunks.filter((c) => c.text).map((c) => c.text);
  expect(texts).toEqual(['hi']);
  expect(chunks[chunks.length -1]?.done).toBe(true);
  });
});
