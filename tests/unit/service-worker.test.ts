import { describe, expect, it } from 'vitest';
import type { PageContext } from '@shared/page-context';
import { resolveTabContext } from '@extension/background/service-worker';

const youtubeCtxWithVideo = (): PageContext => ({
  platform: 'youtube',
  videoId: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'never gonna',
  detectedAt: 0,
});

// SG-02K：shouldPrefetchYouTubeTranscript / maybeFetchYouTubeTranscript /
// transport-error 白名单 / transcript 转换行为测试
// 迁到 `tests/unit/video-analysis-service.test.ts`（行为迁到
// `services/video-analysis-service.ts` 后，旧 service-worker 内部函数
// 已经不存在）。
// 本文件只保留 service-worker 入口层面的 tab context 解析测试。
describe('resolveTabContext (SPA navigation)', () => {
  it('prefers the current tab URL over a stale cached context', () => {
    const cached = youtubeCtxWithVideo();

    const context = resolveTabContext({
      tabUrl: 'https://www.youtube.com/watch?v=HA6XxtGNOm0',
      tabTitle: 'new video',
      cachedContext: cached,
    });

    expect(context).toMatchObject({
      platform: 'youtube',
      videoId: 'HA6XxtGNOm0',
      url: 'https://www.youtube.com/watch?v=HA6XxtGNOm0',
      title: 'new video',
    });
  });

  it('falls back to cached context when the tab URL is unavailable', () => {
    const cached = youtubeCtxWithVideo();

    expect(
      resolveTabContext({
        cachedContext: cached,
      }),
    ).toBe(cached);
  });
});
