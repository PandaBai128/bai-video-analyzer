import { describe, expect, it } from 'vitest';
import { detectPageContext } from '@shared/page-context';

describe('detectPageContext', () => {
  it('detects bilibili video pages', () => {
    const context = detectPageContext(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
      '测试视频',
    );

    expect(context.platform).toBe('bilibili');
    expect(context.videoId).toBe('BV1xx411c7mD');
  });

  it('detects youtube video pages', () => {
    const context = detectPageContext('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '测试视频');

    expect(context.platform).toBe('youtube');
    expect(context.videoId).toBe('dQw4w9WgXcQ');
  });

  it('cleans YouTube browser notification count and suffix from the page title', () => {
    const context = detectPageContext(
      'https://www.youtube.com/watch?v=htk4B9rIMaA',
      "(10) I'm 100% playing this - YouTube",
    );

    expect(context.title).toBe("I'm 100% playing this");
  });

  it('detects youtube /shorts/ pages', () => {
    const context = detectPageContext(
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'Shorts 视频',
    );

    expect(context.platform).toBe('youtube');
    expect(context.videoId).toBe('dQw4w9WgXcQ');
  });

  it('detects youtube /embed/ pages', () => {
    const context = detectPageContext(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'Embed 视频',
    );

    expect(context.platform).toBe('youtube');
    expect(context.videoId).toBe('dQw4w9WgXcQ');
  });

  it('detects youtu.be short URLs', () => {
    const context = detectPageContext('https://youtu.be/dQw4w9WgXcQ', 'Short URL 视频');

    expect(context.platform).toBe('youtube');
    expect(context.videoId).toBe('dQw4w9WgXcQ');
  });
});

// ---------------------------------------------------------------------------
// Round 22 必修 A1：contentKey + B 站分 P 解析
// ---------------------------------------------------------------------------

describe('detectPageContext (Round 22: contentKey + B 站分 P)', () => {
  it('B 站默认 URL 不带 ?p= → contentKey 派生为 BVxxx:p=1, platformSpecific.page=1', () => {
    const context = detectPageContext(
      'https://www.bilibili.com/video/BV1xx411c7mD/',
      '测试视频',
    );

    expect(context.platform).toBe('bilibili');
    expect(context.videoId).toBe('BV1xx411c7mD');
    expect(context.contentKey).toBe('BV1xx411c7mD:p=1');
    expect(context.platformSpecific?.page).toBe(1);
  });

  it('B 站 ?p=10 → contentKey 派生为 BVxxx:p=10, platformSpecific.page=10', () => {
    const context = detectPageContext(
      'https://www.bilibili.com/video/BV1xx411c7mD/?p=10',
      '测试视频',
    );

    expect(context.platform).toBe('bilibili');
    expect(context.videoId).toBe('BV1xx411c7mD');
    expect(context.contentKey).toBe('BV1xx411c7mD:p=10');
    expect(context.platformSpecific?.page).toBe(10);
  });

  it('B 站 ?p=abc (无效分 P) → 回落 page=1, contentKey=BVxxx:p=1', () => {
    const context = detectPageContext(
      'https://www.bilibili.com/video/BV1xx411c7mD/?p=abc',
      '测试视频',
    );

    expect(context.platform).toBe('bilibili');
    expect(context.videoId).toBe('BV1xx411c7mD');
    expect(context.contentKey).toBe('BV1xx411c7mD:p=1');
    expect(context.platformSpecific?.page).toBe(1);
  });

  it('B 站 ?p=0 / ?p=-1 (非正整数) → 回落 page=1', () => {
    const zeroCtx = detectPageContext(
      'https://www.bilibili.com/video/BV1xx411c7mD/?p=0',
      '测试视频',
    );
    expect(zeroCtx.contentKey).toBe('BV1xx411c7mD:p=1');
    expect(zeroCtx.platformSpecific?.page).toBe(1);

    const negativeCtx = detectPageContext(
      'https://www.bilibili.com/video/BV1xx411c7mD/?p=-1',
      '测试视频',
    );
    expect(negativeCtx.contentKey).toBe('BV1xx411c7mD:p=1');
    expect(negativeCtx.platformSpecific?.page).toBe(1);
  });

  it('YouTube: contentKey 仍等于 videoId (Round 22 不改变 YouTube 内容身份规则)', () => {
    const context = detectPageContext('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '测试视频');

    expect(context.platform).toBe('youtube');
    expect(context.videoId).toBe('dQw4w9WgXcQ');
    expect(context.contentKey).toBe('dQw4w9WgXcQ');
  });

  it('同 BV 不同 p 派生不同 contentKey（关键不变量）', () => {
    const p1 = detectPageContext('https://www.bilibili.com/video/BV1xx411c7mD/', '测试视频');
    const p8 = detectPageContext('https://www.bilibili.com/video/BV1xx411c7mD/?p=8', '测试视频');
    const p10 = detectPageContext('https://www.bilibili.com/video/BV1xx411c7mD/?p=10', '测试视频');

    expect(p1.contentKey).toBe('BV1xx411c7mD:p=1');
    expect(p8.contentKey).toBe('BV1xx411c7mD:p=8');
    expect(p10.contentKey).toBe('BV1xx411c7mD:p=10');
    expect(new Set([p1.contentKey, p8.contentKey, p10.contentKey]).size).toBe(3);
  });
});
