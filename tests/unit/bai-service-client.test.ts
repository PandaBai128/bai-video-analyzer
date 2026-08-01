import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BaiServiceClient,
  parseBaiServiceSseEvent,
  stripThinkSections,
} from '@core/llm/bai-service-client';
import { LanguageModelApiError } from '@core/llm/language-model-client';
import type { BaiServiceSettings } from '@shared/settings';

const SETTINGS: BaiServiceSettings = {
  serviceUrl: 'http://io2477kl7316.vicp.fun/',
  inviteCode: 'bai-demo',
  accessToken: '',
  model: 'bai-service',
};

describe('BaiServiceClient', () => {
  const requests: { url: string; init: RequestInit }[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    requests.length = 0;
  });

  function stubFetch(
    handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  ): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        requests.push({ url, init: init ?? {} });
        return handler(url, init ?? {});
      }),
    );
  }

  function requestBody(index: number): Record<string, unknown> {
    return JSON.parse(String(requests[index]?.init.body)) as Record<string, unknown>;
  }

  it('exchanges invite code and posts chat requests with the issued token', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/invite')) {
        return new Response(
          JSON.stringify({
            token: 'issued-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          model: 'bai-service',
          choices: [{ message: { content: '你好' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new BaiServiceClient(SETTINGS);
    const result = await client.chat([{ role: 'user', content: 'hi' }], {
      maxTokens: 128,
      usageFeature: 'analysis',
    });

    expect(requests.map((request) => request.url)).toEqual([
      'http://io2477kl7316.vicp.fun/auth/invite',
      'http://io2477kl7316.vicp.fun/chat',
    ]);
    expect(requestBody(0)).toEqual({ code: 'bai-demo' });
    expect(requests[1]?.init.headers).toMatchObject({
      Authorization: 'Bearer issued-token',
    });
    expect(requestBody(1)).toMatchObject({
      model: 'bai-service',
      maxTokens: 128,
      stream: false,
      feature: 'analysis',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toMatchObject({ content: '你好', model: 'bai-service' });
  });

  it('fetches the current bAI free service quota with a bearer token', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/invite')) {
        return new Response(
          JSON.stringify({
            token: 'issued-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          user: { displayName: '测试用户', status: 'active' },
          quota: {
            daily: {
              limit: 30,
              used: 2,
              remaining: 28,
              resetAt: '2026-07-07T00:00:00.000Z',
            },
            weekly: {
              limit: 120,
              used: 5,
              remaining: 115,
              resetAt: '2026-07-13T00:00:00.000Z',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new BaiServiceClient(SETTINGS);
    const quota = await client.getQuota();

    expect(requests.map((request) => request.url)).toEqual([
      'http://io2477kl7316.vicp.fun/auth/invite',
      'http://io2477kl7316.vicp.fun/me/quota',
    ]);
    expect(requests[1]?.init.headers).toMatchObject({
      Authorization: 'Bearer issued-token',
    });
    expect(quota.quota.daily).toMatchObject({ limit: 30, used: 2, remaining: 28 });
  });

  it('does not expose service URL when invite exchange fetch fails', async () => {
    stubFetch(() => {
      throw new Error('network down');
    });

    const client = new BaiServiceClient(SETTINGS);
    let message = '';
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('bAI 服务邀请码验证失败：network down。');
    expect(message).not.toContain('io2477kl7316.vicp.fun');
    expect(message).not.toContain('当前服务地址');
  });

  it('does not expose service URL when chat fetch fails', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/invite')) {
        return new Response(
          JSON.stringify({
            token: 'issued-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('socket closed');
    });

    const client = new BaiServiceClient(SETTINGS);
    let message = '';
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('bAI 免费服务请求失败：socket closed。');
    expect(message).not.toContain('io2477kl7316.vicp.fun');
    expect(message).not.toContain('当前服务地址');
  });

  it('uses a saved non-expired token without exchanging invite code', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            model: 'bai-service',
            choices: [{ message: { content: 'ok' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );

    const client = new BaiServiceClient({
      ...SETTINGS,
      inviteCode: '',
      accessToken: 'stored-token',
      tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://io2477kl7316.vicp.fun/chat');
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer stored-token',
    });
  });

  it('strips MiniMax M3 think tags from non-stream responses', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/invite')) {
        return new Response(JSON.stringify({ token: 'issued-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          model: 'MiniMax-M3',
          choices: [
            {
              message: {
                content: '<think>先推理，但用户不应看到。</think>\n\n你好',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new BaiServiceClient(SETTINGS);
    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result.content).toBe('你好');
  });

  it('streams bAI service SSE chunks from POST /chat', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/invite')) {
        return new Response(JSON.stringify({ token: 'issued-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const client = new BaiServiceClient(SETTINGS);
    const chunks = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(requests[1]?.url).toBe('http://io2477kl7316.vicp.fun/chat');
    expect(requestBody(1)).toMatchObject({ stream: true });
    expect(chunks).toEqual([
      { text: '你', done: false },
      { text: '好', done: false },
      { text: '', done: true },
    ]);
  });

  it('strips MiniMax M3 think tags across stream chunks', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/invite')) {
        return new Response(JSON.stringify({ token: 'issued-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"nk>内部推理"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"</think>你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const client = new BaiServiceClient(SETTINGS);
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

  it('throws a clear error when no token or invite code is configured', async () => {
    const client = new BaiServiceClient({
      ...SETTINGS,
      inviteCode: '',
      accessToken: '',
    });

    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      new LanguageModelApiError('bAI 服务邀请码为空', null, ''),
    );
  });

  it('parses legacy smoke stream events', () => {
    expect(parseBaiServiceSseEvent('event: chunk\ndata: {"content":"hello"}')).toEqual({
      done: false,
      text: 'hello',
    });
    expect(parseBaiServiceSseEvent('event: done\ndata: {"ok":true}')).toEqual({
      done: true,
      text: '',
    });
  });

  it('strips complete and dangling think sections', () => {
    expect(stripThinkSections('<think>内部</think>\n\n最终内容')).toBe('最终内容');
    expect(stripThinkSections('<think>内部')).toBe('');
  });
});
