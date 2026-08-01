import { describe, expect, it } from 'vitest';
import {
  getPageContextContentKey,
  getVideoMetadataContentKey,
} from '@shared/content-key';
import type { PageContext } from '@shared/page-context';
import type { VideoMetadata } from '@core/types';

describe('getPageContextContentKey (Round 22 必修 A2)', () => {
  it('PageContext.contentKey 优先：直接返回', () => {
    const ctx: PageContext = {
      platform: 'bilibili',
      videoId: 'BV1xx',
      contentKey: 'BV1xx:p=10',
      url: 'https://www.bilibili.com/video/BV1xx/?p=10',
      title: 't',
      detectedAt: 0,
    };
    expect(getPageContextContentKey(ctx)).toBe('BV1xx:p=10');
  });

  it('PageContext 无 contentKey 但 B 站 + platformSpecific.page → 派生 BVxxx:p=N', () => {
    const ctx: PageContext = {
      platform: 'bilibili',
      videoId: 'BV1xx',
      platformSpecific: { page: 8 },
      url: 'https://www.bilibili.com/video/BV1xx/?p=8',
      title: 't',
      detectedAt: 0,
    };
    expect(getPageContextContentKey(ctx)).toBe('BV1xx:p=8');
  });

  it('B 站 + page 缺失 → 回落 BVxxx:p=1', () => {
    const ctx: PageContext = {
      platform: 'bilibili',
      videoId: 'BV1xx',
      url: 'https://www.bilibili.com/video/BV1xx/',
      title: 't',
      detectedAt: 0,
    };
    expect(getPageContextContentKey(ctx)).toBe('BV1xx:p=1');
  });

  it('B 站 + page 非法（非正整数） → 回落 1', () => {
    const ctx: PageContext = {
      platform: 'bilibili',
      videoId: 'BV1xx',
      platformSpecific: { page: 0 },
      url: 'https://www.bilibili.com/video/BV1xx/?p=0',
      title: 't',
      detectedAt: 0,
    };
    expect(getPageContextContentKey(ctx)).toBe('BV1xx:p=1');
  });

  it('YouTube: 返回 videoId', () => {
    const ctx: PageContext = {
      platform: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 't',
      detectedAt: 0,
    };
    expect(getPageContextContentKey(ctx)).toBe('dQw4w9WgXcQ');
  });

  it('context 为 null/undefined → undefined', () => {
    expect(getPageContextContentKey(null)).toBeUndefined();
    expect(getPageContextContentKey(undefined)).toBeUndefined();
  });

  it('无 videoId + 无 contentKey → undefined', () => {
    const ctx: PageContext = {
      platform: 'unknown',
      url: 'https://example.com',
      title: 't',
      detectedAt: 0,
    };
    expect(getPageContextContentKey(ctx)).toBeUndefined();
  });
});

describe('getVideoMetadataContentKey (Round 22 必修 A2)', () => {
  it('B 站 metadata + platformSpecific.page=10 → BVxxx:p=10', () => {
    const metadata: VideoMetadata = {
      platform: 'bilibili',
      videoId: 'BV1xx',
      url: 'https://www.bilibili.com/video/BV1xx/?p=10',
      title: 't',
      author: 'a',
      platformSpecific: { page: 10, cid: 12345 },
    };
    expect(getVideoMetadataContentKey(metadata)).toBe('BV1xx:p=10');
  });

  it('B 站 metadata 缺 page → 回落 BVxxx:p=1', () => {
    const metadata: VideoMetadata = {
      platform: 'bilibili',
      videoId: 'BV1xx',
      url: 'https://www.bilibili.com/video/BV1xx/',
      title: 't',
      author: 'a',
    };
    expect(getVideoMetadataContentKey(metadata)).toBe('BV1xx:p=1');
  });

  it('B 站 metadata page 非正整数 → 回落 1', () => {
    const metadata: VideoMetadata = {
      platform: 'bilibili',
      videoId: 'BV1xx',
      url: '',
      title: 't',
      author: 'a',
      platformSpecific: { page: 0 },
    };
    expect(getVideoMetadataContentKey(metadata)).toBe('BV1xx:p=1');
  });

  it('YouTube: videoId 即 contentKey', () => {
    const metadata: VideoMetadata = {
      platform: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 't',
      author: 'a',
    };
    expect(getVideoMetadataContentKey(metadata)).toBe('dQw4w9WgXcQ');
  });
});
