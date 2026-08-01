import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { getCachedAnalysis, saveCachedAnalysis } from '@core/storage/analysis-cache';
import { db } from '@core/storage/db';
import type { VideoMetadata, VideoAnalysis } from '@core/types';

const bilibiliMetadata = (page: number): VideoMetadata => ({
  platform: 'bilibili',
  videoId: 'BV1xx411c7mD',
  url: `https://www.bilibili.com/video/BV1xx411c7mD/${page > 1 ? `?p=${page}` : ''}`,
  title: '测试视频',
  author: '作者',
  duration: 600,
  platformSpecific: {
    page,
    cid: 100000 + page,
  },
});

const buildAnalysis = (page: number): VideoAnalysis => ({
  overview: `p${page} 视频核心`,
  watchStrategy: [],
  coreTakeaways: [`p${page} 要点`],
  reviewSummary: '整体总结',
  chapters: [
    {
      timestamp: 0,
      title: `p${page} 章 1`,
      summary: 'A',
      importance: 'must-watch',
      watchGuide: '重点',
      segments: [
        { timestamp: 0, title: '开场', summary: 's', importance: 'must-watch' },
        { timestamp: 100, title: 'A 段', summary: 't', importance: 'recommended' },
      ],
    },
  ],
  timeline: [
    { timestamp: 0, title: '开场', summary: 's', importance: 'must-watch' },
    { timestamp: 100, title: 'A 段', summary: 't', importance: 'recommended' },
  ],
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
});

const youtubeMetadata: VideoMetadata = {
  platform: 'youtube',
  videoId: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Never Gonna',
  author: 'Rick Astley',
  duration: 213,
};

const youtubeAnalysis: VideoAnalysis = {
  overview: 'YT 视频核心',
  watchStrategy: [],
  coreTakeaways: ['YT 要点'],
  reviewSummary: '整体总结',
  chapters: [],
  timeline: [{ timestamp: 0, title: 'a', summary: 'b', importance: 'must-watch' }],
  quotes: [],
  keyConcepts: [],
  inspirations: [],
  generatedAt: 1,
  modelUsed: 'MiniMax-M3',
  sourceMode: 'subtitle',
};

describe('analysis-cache (Round 22 必修 A3: contentKey 隔离)', () => {
  beforeEach(async () => {
    await db.analysisCache.clear();
  });

  afterEach(async () => {
    // 只 clear 当前 store，不关 db（视频 followup 等测试也用同一个 db 实例）
    await db.analysisCache.clear();
  });

  it('B 站 p=1 save → get 按 contentKey BV1xx:p=1 命中', async () => {
    const metadata = bilibiliMetadata(1);
    await saveCachedAnalysis({
      metadata,
      analysis: buildAnalysis(1),
      subtitleCueCount: 0,
      timings: [],
    });

    const got = await getCachedAnalysis({
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      contentKey: 'BV1xx411c7mD:p=1',
    });

    expect(got).not.toBeNull();
    expect(got?.analysis.overview).toBe('p1 视频核心');
  });

  it('新保存的分析缓存使用 v15，按输出语言隔离分析/导航缓存', async () => {
    const metadata = bilibiliMetadata(1);
    await saveCachedAnalysis({
      metadata,
      analysis: buildAnalysis(1),
      subtitleCueCount: 0,
      timings: [],
    });

    const record = await db.analysisCache
      .where('[platform+contentKey+sourceMode+outputLocale]')
      .equals(['bilibili', 'BV1xx411c7mD:p=1', 'subtitle', 'zh-CN'])
      .first();

    expect(record?.schemaVersion).toBe(15);
    expect(record?.outputLocale).toBe('zh-CN');
  });

  it('同一视频的中文和英文派生产物按 outputLocale 分开读取', async () => {
    const metadata = bilibiliMetadata(1);
    await saveCachedAnalysis({
      metadata,
      analysis: { ...buildAnalysis(1), overview: '中文分析', outputLocale: 'zh-CN' },
      subtitleCueCount: 0,
      timings: [],
    });
    await saveCachedAnalysis({
      metadata,
      analysis: { ...buildAnalysis(1), overview: 'English analysis', outputLocale: 'en-US' },
      subtitleCueCount: 0,
      timings: [],
    });

    const zh = await getCachedAnalysis({
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      contentKey: 'BV1xx411c7mD:p=1',
      outputLocale: 'zh-CN',
    });
    const en = await getCachedAnalysis({
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      contentKey: 'BV1xx411c7mD:p=1',
      outputLocale: 'en-US',
    });

    expect(zh?.analysis.overview).toBe('中文分析');
    expect(en?.analysis.overview).toBe('English analysis');
  });

  it('旧调用方不传 contentKey 时也按 outputLocale 过滤', async () => {
    await saveCachedAnalysis({
      metadata: youtubeMetadata,
      analysis: { ...youtubeAnalysis, overview: '中文 YouTube', outputLocale: 'zh-CN' },
      subtitleCueCount: 0,
      timings: [],
    });
    await saveCachedAnalysis({
      metadata: youtubeMetadata,
      analysis: { ...youtubeAnalysis, overview: 'English YouTube', outputLocale: 'en-US' },
      subtitleCueCount: 0,
      timings: [],
    });

    const got = await getCachedAnalysis({
      platform: 'youtube',
      videoId: youtubeMetadata.videoId,
      outputLocale: 'en-US',
    });

    expect(got?.analysis.overview).toBe('English YouTube');
  });

  it('B 站 p=8 save → get p=8 命中，p=10 不命中（关键隔离）', async () => {
    await saveCachedAnalysis({
      metadata: bilibiliMetadata(8),
      analysis: buildAnalysis(8),
      subtitleCueCount: 0,
      timings: [],
    });

    const p8 = await getCachedAnalysis({
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      contentKey: 'BV1xx411c7mD:p=8',
    });
    expect(p8).not.toBeNull();
    expect(p8?.analysis.overview).toBe('p8 视频核心');

    const p10 = await getCachedAnalysis({
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      contentKey: 'BV1xx411c7mD:p=10',
    });
    expect(p10).toBeNull();
  });

  it('B 站 p=1 / p=8 / p=10 三条缓存互不干扰', async () => {
    for (const page of [1, 8, 10]) {
      await saveCachedAnalysis({
        metadata: bilibiliMetadata(page),
        analysis: buildAnalysis(page),
        subtitleCueCount: 0,
        timings: [],
      });
    }

    for (const page of [1, 8, 10]) {
      const got = await getCachedAnalysis({
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        contentKey: `BV1xx411c7mD:p=${page}`,
      });
      expect(got?.analysis.overview).toBe(`p${page} 视频核心`);
      expect(got?.analysis.coreTakeaways[0]).toBe(`p${page} 要点`);
    }
  });

  it('YouTube save → get contentKey=videoId 命中', async () => {
    await saveCachedAnalysis({
      metadata: youtubeMetadata,
      analysis: youtubeAnalysis,
      subtitleCueCount: 0,
      timings: [],
    });

    const got = await getCachedAnalysis({
      platform: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      contentKey: 'dQw4w9WgXcQ',
    });
    expect(got).not.toBeNull();
    expect(got?.analysis.overview).toBe('YT 视频核心');
  });

  it('B 站 p=1 + subtitle 缓存，不传 sourceMode 也能拿到', async () => {
    await saveCachedAnalysis({
      metadata: bilibiliMetadata(1),
      analysis: buildAnalysis(1),
      subtitleCueCount: 0,
      timings: [],
    });

    const got = await getCachedAnalysis({
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      contentKey: 'BV1xx411c7mD:p=1',
    });
    expect(got).not.toBeNull();
  });

  it('B 站缺 contentKey 调用 getCachedAnalysis → 走 [platform+videoId] 降级索引', async () => {
    // 防御：旧代码或没拿到 PageContext.contentKey 时仍能拿到缓存（schema 已升 v11，
    // 旧记录会因 schemaVersion mismatch 被忽略）。
    await saveCachedAnalysis({
      metadata: bilibiliMetadata(1),
      analysis: buildAnalysis(1),
      subtitleCueCount: 0,
      timings: [],
    });

    const got = await getCachedAnalysis({
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      // 不传 contentKey
    });
    expect(got).not.toBeNull();
    expect(got?.analysis.overview).toBe('p1 视频核心');
  });

  it('字幕偏好相同才命中，偏好变化或旧记录缺 key 都失效', async () => {
    await saveCachedAnalysis({
      metadata: youtubeMetadata,
      analysis: youtubeAnalysis,
      subtitleCueCount: 1,
      transcriptCues: [{ start: 0, text: 'English' }],
      subtitlePreferenceKey: 'en-us,zh-cn',
      timings: [],
    });

    const same = await getCachedAnalysis({
      platform: 'youtube',
      videoId: youtubeMetadata.videoId,
      contentKey: youtubeMetadata.videoId,
      subtitlePreferenceKey: 'en-us,zh-cn',
    });
    const changed = await getCachedAnalysis({
      platform: 'youtube',
      videoId: youtubeMetadata.videoId,
      contentKey: youtubeMetadata.videoId,
      subtitlePreferenceKey: 'zh-cn,en-us',
    });
    expect(same?.transcriptCues?.[0]?.text).toBe('English');
    expect(changed).toBeNull();

    await db.analysisCache.put({
      id: 'youtube:legacy:subtitle:zh-CN',
      schemaVersion: 15,
      platform: 'youtube',
      videoId: youtubeMetadata.videoId,
      contentKey: youtubeMetadata.videoId,
      sourceMode: 'subtitle',
      outputLocale: 'zh-CN',
      metadata: youtubeMetadata,
      analysis: youtubeAnalysis,
      subtitleCueCount: 1,
      transcriptCues: [{ start: 0, text: 'Unknown language' }],
      timings: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const legacy = await getCachedAnalysis({
      platform: 'youtube',
      videoId: youtubeMetadata.videoId,
      contentKey: youtubeMetadata.videoId,
      subtitlePreferenceKey: 'zh-cn,en-us',
    });
    expect(legacy).toBeNull();
  });
});
