import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MinimaxSearchClient,
  buildFollowupWebSearchPlan,
  buildFollowupWebSearchQuery,
} from '@core/llm/minimax-search-client';
import { MinimaxApiError } from '@core/llm/minimax-client';
import type { TextProviderSettings } from '@shared/settings';

const SETTINGS: TextProviderSettings = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.minimaxi.com',
  model: 'MiniMax-M3',
  fastModel: 'MiniMax-M2.7-highspeed',
  analysisMode: 'subtitle',
  thinkingMode: 'disabled',
  webSearchEnabled: true,
  updatedAt: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MinimaxSearchClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('向 /v1/coding_plan/search 发送 { q }，并归一化 organic 结果', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        organic: [
          {
            title: '结果标题',
            link: 'https://example.com/a',
            snippet: '结果摘要',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new MinimaxSearchClient(SETTINGS);
    const result = await client.search('  Apple   AI 最新进展  ', { limit: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.minimaxi.com/v1/coding_plan/search');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({ q: 'Apple AI 最新进展' });
    expect(result).toEqual({
      query: 'Apple AI 最新进展',
      results: [
        {
          title: '结果标题',
          url: 'https://example.com/a',
          snippet: '结果摘要',
        },
      ],
    });
  });

  it('搜索失败时抛出带权限提示的 MinimaxApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403)));
    const client = new MinimaxSearchClient(SETTINGS);

    await expect(client.search('苹果 AI')).rejects.toThrow(MinimaxApiError);
    await expect(client.search('苹果 AI')).rejects.toThrow(/没有联网搜索|Token Plan|鉴权/);
  });

  it('HTTP 200 但 base_resp 非 0 时按联网失败处理，而不是归一化成 0 条结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          base_resp: {
            status_code: 1008,
            status_msg: 'permission denied',
          },
          organic: [],
        }),
      ),
    );
    const client = new MinimaxSearchClient(SETTINGS);

    await expect(client.search('苹果 AI')).rejects.toThrow(MinimaxApiError);
    await expect(client.search('苹果 AI')).rejects.toThrow(
      /业务状态 1008|Token Plan|permission denied/,
    );
  });

  it('searchFollowup 对实体介绍问题执行多 query 搜索、去重并标注来源类型', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { q: string };
      if (body.q.includes('官方')) {
        return jsonResponse({
          organic: [
            {
              title: '星际计划官方：新角色阿洛先导展示',
              link: 'https://example.com/official/aurora',
              snippet: '官方先导展示提到新角色阿洛。',
            },
          ],
        });
      }
      if (body.q.includes('角色 背景')) {
        return jsonResponse({
          organic: [
            {
              title: '媒体报道：星际计划新版本角色背景',
              link: 'https://news.example.com/aurora-background',
              snippet: '报道整理了新角色阿洛的公开背景。',
            },
          ],
        });
      }
      return jsonResponse({
        organic: [
          {
            title: '社区视频：新角色阿洛讨论',
            link: 'https://www.bilibili.com/video/BV-test',
            snippet: '玩家讨论新角色阿洛。',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new MinimaxSearchClient(SETTINGS);
    const result = await client.searchFollowup(
      {
        title: '星际计划3.0对比2.0剧情进步了么？',
        question: '搜索新角色阿洛，给我个介绍',
      },
      { limit: 10 },
    );

    expect(result.plan?.intent).toBe('entity_intro');
    expect(result.plan?.entity).toBe('新角色阿洛');
    expect(result.queries).toContain('星际计划 新角色阿洛 介绍');
    expect(result.queries).toContain('星际计划 新角色阿洛 官方');
    expect(result.queries).toContain('星际计划 新角色阿洛 角色 背景');
    expect(result.queries).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(result.queries?.length ?? 0);
    expect(result.results.map((item) => item.url)).toContain(
      'https://example.com/official/aurora',
    );
    expect(result.results[0]?.sourceType).toBe('official');
    expect(result.results.every((item) => item.sourceQuery)).toBe(true);
  });
});

describe('buildFollowupWebSearchQuery', () => {
  it('问题缺少明确主题时，只补短标题主题，不拼作者和完整视频标题', () => {
    expect(
      buildFollowupWebSearchQuery({
        title: '  WWDC  苹果 AI  ',
        author: '作者',
        question: '  最新进展是什么？ ',
      }),
    ).toBe('WWDC 苹果 AI 最新进展是什么？');
  });

  it('问题已有明确主题时，不再拼当前视频标题，避免把搜索拉偏', () => {
    expect(
      buildFollowupWebSearchQuery({
        title: '星际计划3.0对比2.0剧情进步了么？节奏-演出-角色塑造到底咋样？',
        author: 'UP 主',
        question: '星际计划目前人气最高的角色是谁',
      }),
    ).toBe('星际计划目前人气最高的角色是谁 人气榜 投票 排名 最新');
  });

  it('问题只写版本号时，从标题抽取短主题并补官方日期限定词', () => {
    expect(
      buildFollowupWebSearchQuery({
        title: '星际计划3.0对比2.0剧情进步了么？节奏-演出-角色塑造到底咋样？',
        question: '3.0什么时候推出的',
      }),
    ).toBe('星际计划 3.0 什么时候推出的 官方公告 上线时间 发布日期');
  });

  it('实体介绍问题生成搜索计划：清理口语词并生成通用查证 query', () => {
    const plan = buildFollowupWebSearchPlan({
      title: '星际计划3.0对比2.0剧情进步了么？节奏-演出-角色塑造到底咋样？',
      question: '搜索新角色阿洛，给我个介绍',
    });

    expect(plan.intent).toBe('entity_intro');
    expect(plan.entity).toBe('新角色阿洛');
    expect(plan.topicHint).toBe('星际计划');
    expect(plan.queries).toContain('星际计划 新角色阿洛 介绍');
    expect(plan.queries).toContain('星际计划 新角色阿洛 官方');
    expect(plan.queries).toContain('星际计划 新角色阿洛 角色 背景');
    expect(plan.queries).toHaveLength(3);
    expect(plan.requiredEvidence).toMatch(/官方公告|角色 PV/);
  });
});
