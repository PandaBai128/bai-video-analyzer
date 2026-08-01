import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BilibiliAdapter } from '@core/adapters/bilibili';
import { extractYouTubeCaptionTracks, YouTubeAdapter } from '@core/adapters/youtube';

const MOCK_VIEW = {
  code: 0,
  message: '0',
  data: {
    bvid: 'BV1xx411c7mD',
    aid: 1,
    cid: 999,
    title: '测试视频',
    duration: 600,
    pages: [{ cid: 999, page: 1, duration: 600 }],
    owner: { name: 'UP 主', mid: 100 },
  },
};

const MOCK_WBI_NAV = {
  code: 0,
  message: '0',
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484a6881eb0f8c0c624d.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caffdff14a82a82f8b6c0c0c0c0c.png',
    },
  },
};

const MOCK_WBI_SUBTITLES_MIXED = {
  code: 0,
  message: '0',
  data: {
    subtitle: {
      subtitles: [
        {
          lan: 'ai-zh',
          lan_doc: '中文（自动）',
          subtitle_url: '//aisubtitle.hdslb.com/sub-ai.json',
          ai_type: 1,
          type: 1,
        },
        {
          lan: 'zh-CN',
          lan_doc: '中文（中国）',
          subtitle_url: '//aisubtitle.hdslb.com/sub-manual.json',
          ai_type: 0,
          type: 0,
        },
        {
          lan: 'en-US',
          lan_doc: 'English (United States)',
          subtitle_url: '//aisubtitle.hdslb.com/sub-en.json',
          ai_type: 0,
          type: 0,
        },
      ],
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BilibiliAdapter', () => {
  let adapter: BilibiliAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new BilibiliAdapter({
      clock: () => 1_700_000_000,
      cacheStore: {
        read: async () => null,
        write: async () => undefined,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts bvid from bilibili URLs', () => {
    expect(adapter.extractVideoId('https://www.bilibili.com/video/BV1xx411c7mD/')).toBe(
      'BV1xx411c7mD',
    );
  });

  it('builds timestamp URLs', () => {
    expect(adapter.getTimestampUrl('BV1xx411c7mD', 12.8)).toBe(
      'https://www.bilibili.com/video/BV1xx411c7mD/?t=12',
    );
  });

  it('selects cid from the current p parameter for multi-part videos', async () => {
    const multiPartView = {
      code: 0,
      message: '0',
      data: {
        bvid: 'BV1xx411c7mD',
        aid: 1,
        cid: 111,
        title: '主标题',
        duration: 100,
        pages: [
          { cid: 111, page: 1, part: '第一集', duration: 100 },
          { cid: 222, page: 2, part: '第二集', duration: 200 },
        ],
        owner: { name: 'UP 主', mid: 1 },
      },
    };
    fetchMock = vi.fn(async () => jsonResponse(multiPartView));
    vi.stubGlobal('fetch', fetchMock);

    const metadata = await adapter.fetchMetadata(
      'https://www.bilibili.com/video/BV1xx411c7mD/?p=2',
    );

    expect(metadata.ok).toBe(true);
    if (!metadata.ok) {
      return;
    }
    expect(metadata.value.platformSpecific?.cid).toBe(222);
    expect(metadata.value.platformSpecific?.page).toBe(2);
    expect(metadata.value.url).toBe('https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
    expect(metadata.value.title).toBe('主标题 - 第二集');
  });

  it('attaches B 站播放器章节 view_points to metadata', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/player/wbi/v2')) {
        return jsonResponse({
          code: 0,
          message: '0',
          data: {
            view_points: [
              { type: 2, from: 1262, to: 1611, content: '项目开发' },
              { type: 2, from: 1611, to: 1913, content: '插件使用' },
              { type: 2, from: 1913, to: 2204, content: 'Skills' },
            ],
          },
        });
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const metadata = await adapter.fetchMetadata('https://www.bilibili.com/video/BV1xx411c7mD/');

    expect(metadata.ok).toBe(true);
    if (!metadata.ok) {
      return;
    }
    expect(metadata.value.platformChapters).toEqual([
      { title: '项目开发', start: 1262, end: 1611 },
      { title: '插件使用', start: 1611, end: 1913 },
      { title: 'Skills', start: 1913, end: 2204 },
    ]);
  });

  it('injects Cookie header into all API requests when setCookieHeader is called', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse(MOCK_WBI_NAV);
      }
      if (url.includes('/x/player/wbi/v2')) {
        return jsonResponse(MOCK_WBI_SUBTITLES_MIXED);
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    adapter.setCookieHeader('SESSDATA=abc123; bili_jct=def456');
    const tracks = await adapter.fetchSubtitleTracks(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
      ['zh-CN'],
    );

    expect(tracks.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const headersOfAllCalls = calls.map(
      ([, init]) => (init?.headers ?? {}) as Record<string, string>,
    );

    for (const headers of headersOfAllCalls) {
      expect(headers.Cookie ?? headers.cookie).toBe('SESSDATA=abc123; bili_jct=def456');
    }
  });

  it('uses WBI signed interface and applies conservative source ordering', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse(MOCK_WBI_NAV);
      }
      if (url.includes('/x/player/wbi/v2')) {
        return jsonResponse(MOCK_WBI_SUBTITLES_MIXED);
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tracks = await adapter.fetchSubtitleTracks(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    );

    expect(tracks.ok).toBe(true);
    if (!tracks.ok) {
      return;
    }
    // 先按浏览器偏好的中文选语言族，再按当前字段推导的来源排序信号。
    expect(tracks.value.map((t) => t.language)).toEqual(['zh-CN', 'ai-zh', 'en-US']);
    expect(tracks.value[0]?.source).toBe('official');
    expect(tracks.value[1]?.source).toBe('asr');
    // 协议头补全
    expect(tracks.value[0]?.url).toBe('https://aisubtitle.hdslb.com/sub-manual.json');
    expect(tracks.value[0]?.url.startsWith('//')).toBe(false);

    // 验证调用了 wbi 接口
    const urls = (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([url]) => url);
    expect(urls.some((u) => u.includes('/x/player/wbi/v2'))).toBe(true);
  });

  it('does not classify an ai-labeled ai_type=0 track as official', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse(MOCK_WBI_NAV);
      }
      if (url.includes('/x/player/wbi/v2')) {
        return jsonResponse({
          code: 0,
          message: '0',
          data: {
            subtitle: {
              subtitles: [
                {
                  lan: 'ai-zh',
                  lan_doc: '中文',
                  subtitle_url: '//aisubtitle.hdslb.com/sub-ai-zero.json',
                  ai_type: 0,
                  type: 0,
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tracks = await adapter.fetchSubtitleTracks('https://www.bilibili.com/video/BV1xx411c7mD/');

    expect(tracks.ok).toBe(true);
    if (!tracks.ok) {
      return;
    }
    expect(tracks.value[0]?.source).toBe('unknown');
  });

  it('falls back to legacy /x/player/v2 when WBI returns no subtitle_url', async () => {
    const legacySubtitles = {
      code: 0,
      message: '0',
      data: {
        subtitle: {
          subtitles: [
            {
              lan: 'zh-CN',
              lan_doc: '中文',
              subtitle_url: '//aisubtitle.hdslb.com/legacy.json',
              ai_type: 0,
            },
          ],
        },
      },
    };

    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse(MOCK_WBI_NAV);
      }
      if (url.includes('/x/player/wbi/v2')) {
        return jsonResponse({
          code: 0,
          message: '0',
          data: { subtitle: { subtitles: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: '' }] } },
        });
      }
      if (url.includes('/x/player/v2')) {
        return jsonResponse(legacySubtitles);
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tracks = await adapter.fetchSubtitleTracks(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    );

    expect(tracks.ok).toBe(true);
    if (!tracks.ok) {
      return;
    }
    expect(tracks.value[0]?.url).toBe('https://aisubtitle.hdslb.com/legacy.json');

    const urls = (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([url]) => url);
    expect(urls.some((u) => u.includes('/x/player/wbi/v2'))).toBe(true);
    expect(urls.some((u) => u.includes('/x/player/v2?'))).toBe(true);
  });

  it('returns NO_SUBTITLE when both interfaces return no subtitles', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse(MOCK_WBI_NAV);
      }
      if (url.includes('/x/player/wbi/v2') || url.includes('/x/player/v2')) {
        return jsonResponse({ code: 0, message: '0', data: { subtitle: { subtitles: [] } } });
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tracks = await adapter.fetchSubtitleTracks(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    );

    expect(tracks.ok).toBe(false);
    if (tracks.ok) {
      return;
    }
    expect(tracks.error.code).toBe('NO_SUBTITLE');
    expect(tracks.error.message).toMatch(/没有返回任何字幕/);
  });

  it('surfaces login-required error when API returns code -101', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse(MOCK_WBI_NAV);
      }
      if (url.includes('/x/player/wbi/v2')) {
        return jsonResponse({ code: -101, message: '未登录', data: null });
      }
      if (url.includes('/x/player/v2')) {
        return jsonResponse({ code: -101, message: '未登录', data: null });
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tracks = await adapter.fetchSubtitleTracks(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    );

    expect(tracks.ok).toBe(false);
    if (tracks.ok) {
      return;
    }
    expect(tracks.error.message).toMatch(/未识别登录态/);
  });

  it('surfaces risk-control error when API returns code -352', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/x/web-interface/view')) {
        return jsonResponse(MOCK_VIEW);
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse(MOCK_WBI_NAV);
      }
      if (url.includes('/x/player/wbi/v2')) {
        return jsonResponse({ code: -352, message: '风控', data: null });
      }
      if (url.includes('/x/player/v2')) {
        return jsonResponse({ code: -352, message: '风控', data: null });
      }
      return jsonResponse({ code: -1, message: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tracks = await adapter.fetchSubtitleTracks(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    );

    expect(tracks.ok).toBe(false);
    if (tracks.ok) {
      return;
    }
    expect(tracks.error.message).toMatch(/风控/);
  });
});

describe('YouTubeAdapter', () => {
  const adapter = new YouTubeAdapter();

  it('extracts video id from watch URLs', () => {
    expect(adapter.extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts video id from short URLs', () => {
    expect(adapter.extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts video id from /shorts/ URLs', () => {
    expect(adapter.extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts video id from /embed/ URLs', () => {
    expect(adapter.extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts video id from /live/ URLs', () => {
    expect(adapter.extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for non-YouTube URLs', () => {
    expect(adapter.extractVideoId('https://www.bilibili.com/video/BV1xx411c7mD/')).toBeNull();
  });

  it('builds timestamp URLs', () => {
    expect(adapter.getTimestampUrl('dQw4w9WgXcQ', 42.9)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    );
  });
});

describe('extractYouTubeCaptionTracks', () => {
  it('extracts caption tracks from a player response fragment', () => {
    const html =
      '{"captionTracks":[{"baseUrl":"https://example.com/caption","name":{"simpleText":"English"},"languageCode":"en","kind":"asr"}],"audioTracks":[]}';

    expect(extractYouTubeCaptionTracks(html)).toEqual([
      {
        baseUrl: 'https://example.com/caption',
        name: { simpleText: 'English' },
        languageCode: 'en',
        kind: 'asr',
      },
    ]);
  });
});
