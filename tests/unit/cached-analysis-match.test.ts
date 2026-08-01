import { describe, expect, it } from 'vitest';
import type { PageContext } from '@shared/page-context';
import type { AnalysisMode } from '@shared/settings';
import type { VideoMetadata, VideoAnalysis } from '@core/types';
import { isCachedAnalysisForCurrentView } from '@extension/sidepanel/cached-analysis-match';

const youtubeCtx = (videoId = 'dQw4w9WgXcQ'): PageContext => ({
  platform: 'youtube',
  videoId,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  title: 'demo',
  detectedAt: 0,
});

const bilibiliCtx = (videoId = 'BV1xx', page = 1): PageContext => ({
  platform: 'bilibili',
  videoId,
  url: `https://www.bilibili.com/video/${videoId}${page > 1 ? `/?p=${page}` : ''}`,
  title: 'demo',
  detectedAt: 0,
  contentKey: `${videoId}:p=${page}`,
  platformSpecific: { page },
});

const emptyCtx = (): PageContext => ({
  platform: 'unknown',
  url: 'https://example.com',
  title: 'no video',
  detectedAt: 0,
});

const buildCached = (
  platform: 'youtube' | 'bilibili',
  videoId: string,
  sourceMode: 'subtitle' | 'multimodal',
  page?: number,
): { metadata: VideoMetadata; analysis: VideoAnalysis } => {
  const metadata: VideoMetadata = {
    platform,
    videoId,
    title: 'demo',
    author: '',
    url: '',
  };
  if (platform === 'bilibili' && typeof page === 'number') {
    Object.assign(metadata, {
      platformSpecific: { page, cid: 100000 + page },
    });
  }
  return {
    metadata,
    analysis: {
      sourceMode,
      overview: '',
      reviewSummary: '',
      keyConcepts: [],
      chapters: [],
      timeline: [],
      quotes: [],
      coreTakeaways: [],
      inspirations: [],
      watchStrategy: [],
      generatedAt: 0,
      modelUsed: '',
    },
  };
};

describe('isCachedAnalysisForCurrentView (Fix #3: 缓存恢复不能串视频/串模式)', () => {
  it('returns true for same video + same mode', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('youtube', 'dQw4w9WgXcQ', 'subtitle'),
        youtubeCtx('dQw4w9WgXcQ'),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(true);
  });

  it('returns false for same video but old cached mode', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('youtube', 'dQw4w9WgXcQ', 'multimodal'),
        youtubeCtx('dQw4w9WgXcQ'),
        'subtitle',
      ),
    ).toBe(false);
  });

  it('returns false for different video (A -> B)', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('youtube', 'dQw4w9WgXcQ', 'subtitle'),
        youtubeCtx('xxxxxxxxxxx'),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(false);
  });

  it('returns false for different platform', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('youtube', 'dQw4w9WgXcQ', 'subtitle'),
        bilibiliCtx(),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(false);
  });

  it('returns false when context is null (no supported page)', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('youtube', 'dQw4w9WgXcQ', 'subtitle'),
        null,
        'subtitle' as AnalysisMode,
      ),
    ).toBe(false);
  });

  it('returns false when context has no videoId', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('youtube', 'dQw4w9WgXcQ', 'subtitle'),
        emptyCtx(),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(false);
  });

  it('returns false when cached is null', () => {
    expect(
      isCachedAnalysisForCurrentView(null, youtubeCtx(), 'subtitle' as AnalysisMode),
    ).toBe(false);
  });

  it('returns false when cached is undefined', () => {
    expect(
      isCachedAnalysisForCurrentView(undefined, youtubeCtx(), 'subtitle' as AnalysisMode),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 22 必修 A4：同 BV 不同 p 必须不命中（多 P 隔离）
// ---------------------------------------------------------------------------

describe('isCachedAnalysisForCurrentView (Round 22 必修 A4: B 站多 P 隔离)', () => {
  it('B 站同 BV 同 p → 命中', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('bilibili', 'BV1xx', 'subtitle', 8),
        bilibiliCtx('BV1xx', 8),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(true);
  });

  it('B 站同 BV 不同 p (p=8 缓存，p=10 当前) → 不命中', () => {
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('bilibili', 'BV1xx', 'subtitle', 8),
        bilibiliCtx('BV1xx', 10),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(false);
  });

  it('B 站同 BV 默认 p=1 缓存，p=8 当前 → 不命中', () => {
    // 防御：用户先分析 P1，再切 P8，缓存不能复用 P1 的。
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('bilibili', 'BV1xx', 'subtitle', 1),
        bilibiliCtx('BV1xx', 8),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(false);
  });

  it('B 站同 BV 缺 page metadata (兜底) → 与 page=1 命中', () => {
    // 防御：metadata 没写 platformSpecific.page 时，cached 侧 getVideoMetadataContentKey
    // 兜底为 p=1；与 page=1 context 比较应当放行（避免漏命中导致"我已经分析过但还提示我重新分析"）。
    expect(
      isCachedAnalysisForCurrentView(
        buildCached('bilibili', 'BV1xx', 'subtitle'),
        bilibiliCtx('BV1xx', 1),
        'subtitle' as AnalysisMode,
      ),
    ).toBe(true);
  });
});
