import { describe, expect, it, vi } from 'vitest';
import type { SubtitleCue, SubtitleTrack } from '@core/types';

// vitest `vi.mock` factory 会被 hoist 到模块顶部——所以 spy 必须在
// `vi.hoisted` 块里声明，**不**能放在模块顶层 `const`（那样引用时
// 还没初始化，ReferenceError）。
const { setCookieHeaderSpy, fetchSubtitleTracksMock, fetchSubtitleCuesMock } = vi.hoisted(() => ({
  setCookieHeaderSpy: vi.fn(),
  fetchSubtitleTracksMock: vi.fn(),
  fetchSubtitleCuesMock: vi.fn(),
}));

vi.mock('@core/adapters', async () => {
  const actual = await vi.importActual<typeof import('@core/adapters')>('@core/adapters');
  return {
    ...actual,
    BilibiliAdapter: class {
      readonly platform = 'bilibili' as const;
      setCookieHeader = setCookieHeaderSpy;
      fetchSubtitleTracks = fetchSubtitleTracksMock;
      fetchSubtitleCues = fetchSubtitleCuesMock;
      match = (): boolean => true;
      extractVideoId = (): string | null => 'BV-mock';
    },
    YouTubeAdapter: class {
      readonly platform = 'youtube' as const;
      // **不**实现 setCookieHeader（YouTube 不需要登录态）
      fetchSubtitleTracks = fetchSubtitleTracksMock;
      fetchSubtitleCues = fetchSubtitleCuesMock;
      match = (): boolean => false;
      extractVideoId = (): string | null => null;
    },
  };
});

import { fetchSubtitlesForTimeline } from '@core/analysis/timeline-request-context';
import type { PageContext } from '@shared/page-context';
import type { VideoMetadata } from '@core/types';

const SAMPLE_METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV-mock',
  title: 'mock',
  author: 'mock-author',
  duration: 120,
  url: 'https://www.bilibili.com/video/BV-mock',
};

const BILIBILI_CTX: PageContext = {
  platform: 'bilibili',
  videoId: 'BV-mock',
  contentKey: 'BV-mock',
  url: 'https://www.bilibili.com/video/BV-mock',
  title: 'mock',
  detectedAt: Date.now(),
};

const SAMPLE_TRACK: SubtitleTrack = {
  language: 'zh-CN',
  label: '中文（自动）',
  url: 'https://example.com/sub.json',
  source: 'official',
};

const SAMPLE_CUES: SubtitleCue[] = [
  { start: 0, end: 2, text: '第一句' },
  { start: 2, end: 4, text: '第二句' },
];

function resetMocks(): void {
  setCookieHeaderSpy.mockReset();
  fetchSubtitleTracksMock.mockReset();
  fetchSubtitleCuesMock.mockReset();
  // 默认：fetchSubtitleTracks 返回 1 个 track，fetchSubtitleCues 返回 cues
  fetchSubtitleTracksMock.mockResolvedValue({ ok: true, value: [SAMPLE_TRACK] });
  fetchSubtitleCuesMock.mockResolvedValue({ ok: true, value: SAMPLE_CUES });
}

describe('fetchSubtitlesForTimeline (Round 29A QA 必修 A: cookie 注入)', () => {
  it('必修 A 验收 1：cookieProvider 返回有效 cookie 时调 setCookieHeader(provider 返回值)', async () => {
    resetMocks();
    const cookieProvider = vi.fn().mockResolvedValue('SESSDATA=abc; bili_jct=xyz');

    await fetchSubtitlesForTimeline({
      context: BILIBILI_CTX,
      prefetchedYouTube: { kind: 'skipped' },
      startedAt: Date.now(),
      cookieProvider,
    });

    expect(cookieProvider).toHaveBeenCalledWith('bilibili');
    expect(setCookieHeaderSpy).toHaveBeenCalledWith('SESSDATA=abc; bili_jct=xyz');
  });

  it('必修 A 验收 2：cookieProvider 返回 null 时调 setCookieHeader(null)（避免旧 Cookie 残留）', async () => {
    resetMocks();
    const cookieProvider = vi.fn().mockResolvedValue(null);

    await fetchSubtitlesForTimeline({
      context: BILIBILI_CTX,
      prefetchedYouTube: { kind: 'skipped' },
      startedAt: Date.now(),
      cookieProvider,
    });

    expect(cookieProvider).toHaveBeenCalledWith('bilibili');
    expect(setCookieHeaderSpy).toHaveBeenCalledWith(null);
  });

  it('必修 A 验收 3：没传 cookieProvider 时也调 setCookieHeader(null)（清空模块级 adapter 残留）', async () => {
    resetMocks();

    // 模拟上一次调用残留了 cookie（**不**通过本函数注入的）
    setCookieHeaderSpy.mockImplementationOnce(() => undefined);

    await fetchSubtitlesForTimeline({
      context: BILIBILI_CTX,
      prefetchedYouTube: { kind: 'skipped' },
      startedAt: Date.now(),
      // 故意**不**传 cookieProvider
    });

    // 即使没 provider，**也**要显式 setCookieHeader(null) 清空旧 Cookie
    expect(setCookieHeaderSpy).toHaveBeenCalledWith(null);
  });

  it('必修 A 验收 4：prefetchedYouTube=ok 时不调 setCookieHeader（**不**走 adapter 路径）', async () => {
    resetMocks();
    // prefetchedYouTube=ok → 直接用 transcript.cues，**不**调 adapter
    const result = await fetchSubtitlesForTimeline({
      context: BILIBILI_CTX,
      prefetchedYouTube: {
        kind: 'ok',
        transcript: {
          metadata: SAMPLE_METADATA,
          cues: SAMPLE_CUES,
          source: 'asr',
          language: 'en',
        },
        attempts: [],
      },
      startedAt: Date.now(),
      cookieProvider: vi.fn().mockResolvedValue('SESSDATA=abc'),
    });

    // ok 路径不调 setCookieHeader（prefetch 已拿到字幕，**不**再 fallback）
    expect(setCookieHeaderSpy).not.toHaveBeenCalled();
    expect(result.transcriptSource).toBe('asr');
    expect(result.language).toBe('en');
  });

  it('返回实际选中的 B 站字幕轨来源，避免 AI 字幕被标成官方字幕', async () => {
    resetMocks();
    const asrTrack: SubtitleTrack = {
      ...SAMPLE_TRACK,
      label: '中文（AI）',
      source: 'asr',
    };
    fetchSubtitleTracksMock.mockResolvedValue({ ok: true, value: [asrTrack] });

    const result = await fetchSubtitlesForTimeline({
      context: BILIBILI_CTX,
      prefetchedYouTube: { kind: 'skipped' },
      startedAt: Date.now(),
      cookieProvider: vi.fn().mockResolvedValue('SESSDATA=abc'),
    });

    expect(result.transcriptSource).toBe('asr');
    expect(result.language).toBe('zh-CN');
  });

  it('首选字幕轨抓取失败后继续尝试同一语言排序中的下一条', async () => {
    resetMocks();
    const firstTrack: SubtitleTrack = { ...SAMPLE_TRACK, url: 'first' };
    const secondTrack: SubtitleTrack = { ...SAMPLE_TRACK, url: 'second', source: 'asr' };
    fetchSubtitleTracksMock.mockResolvedValue({ ok: true, value: [firstTrack, secondTrack] });
    fetchSubtitleCuesMock
      .mockResolvedValueOnce({ ok: false, error: { code: 'PARSE_ERROR', message: 'bad track' } })
      .mockResolvedValueOnce({ ok: true, value: SAMPLE_CUES });

    const result = await fetchSubtitlesForTimeline({
      context: BILIBILI_CTX,
      prefetchedYouTube: { kind: 'skipped' },
      startedAt: Date.now(),
      subtitleLanguages: ['zh-CN'],
    });

    expect(fetchSubtitleCuesMock).toHaveBeenNthCalledWith(1, firstTrack);
    expect(fetchSubtitleCuesMock).toHaveBeenNthCalledWith(2, secondTrack);
    expect(result.subtitles).toEqual(SAMPLE_CUES);
  });
});
