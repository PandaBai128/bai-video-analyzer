import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@core/storage/db';
import {
  createContentContextId,
  getCachedContentContext,
  saveContentContext,
} from '@core/storage/content-context-cache';
import type { VideoMetadata } from '@core/types';

const METADATA: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  author: '测试作者',
  duration: 600,
};

describe('content-context-cache (Round 29A 必修 A)', () => {
  beforeEach(async () => {
    await db.contentContexts.clear();
  });

  it('必修 A 验收 1：createContentContextId 形如 `${platform}:${contentKey}`', () => {
    expect(createContentContextId('bilibili', 'BV1xx:p=1')).toBe('bilibili:BV1xx:p=1');
    expect(createContentContextId('youtube', 'dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ');
  });

  it('必修 A 验收 2：saveContentContext 后 getCachedContentContext 返回新存的数据', async () => {
    const transcriptCues = [
      { start: 0, end: 2, text: '第一句' },
      { start: 2, end: 4, text: '第二句' },
    ];
    await saveContentContext(
      {
        metadata: METADATA,
        transcriptCues,
        transcriptSource: 'official',
        language: 'zh-CN',
      },
      { contentKey: 'BV1xx:p=1' },
    );
    const cached = await getCachedContentContext({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
    });
    expect(cached).not.toBeNull();
    expect(cached?.metadata.videoId).toBe('BV1xx');
    expect(cached?.transcriptCues).toEqual(transcriptCues);
    expect(cached?.transcriptSource).toBe('official');
    expect(cached?.language).toBe('zh-CN');
  });

  it('必修 A 验收 3：不同 contentKey 隔离（B 站多 P）', async () => {
    await saveContentContext(
      {
        metadata: METADATA,
        transcriptCues: [{ start: 0, end: 1, text: 'p1' }],
        transcriptSource: 'official',
      },
      { contentKey: 'BV1xx:p=1' },
    );
    await saveContentContext(
      {
        metadata: METADATA,
        transcriptCues: [{ start: 0, end: 1, text: 'p8' }],
        transcriptSource: 'official',
      },
      { contentKey: 'BV1xx:p=8' },
    );
    const p1 = await getCachedContentContext({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
    });
    const p8 = await getCachedContentContext({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=8',
    });
    expect(p1?.transcriptCues[0]?.text).toBe('p1');
    expect(p8?.transcriptCues[0]?.text).toBe('p8');
  });

  it('必修 A 验收 4：saveContentContext 二次调用（同 contentKey）覆盖 cues 但保留 createdAt', async () => {
    const before = Date.now() - 1000;
    await saveContentContext(
      {
        metadata: METADATA,
        transcriptCues: [{ start: 0, end: 1, text: 'old' }],
        transcriptSource: 'official',
      },
      { contentKey: 'BV1xx:p=1' },
    );
    const first = await db.contentContexts.get('bilibili:BV1xx:p=1');
    expect(first?.createdAt).toBeGreaterThanOrEqual(before);
    const firstCreatedAt = first?.createdAt;

    // 等待一毫秒确保 updatedAt 改变
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveContentContext(
      {
        metadata: METADATA,
        transcriptCues: [{ start: 0, end: 1, text: 'new' }],
        transcriptSource: 'official',
      },
      { contentKey: 'BV1xx:p=1' },
    );
    const second = await db.contentContexts.get('bilibili:BV1xx:p=1');
    expect(second?.createdAt).toBe(firstCreatedAt); // 保留
    expect(second?.updatedAt).toBeGreaterThan(first!.updatedAt); // 更新
    expect(second?.transcriptCues[0]?.text).toBe('new');
  });

  it('必修 A 验收 5：未命中返回 null（不抛错）', async () => {
    const cached = await getCachedContentContext({
      platform: 'bilibili',
      contentKey: 'BV_NOSUCH',
    });
    expect(cached).toBeNull();
  });

  it('必修 A 验收 6：transcriptCues.length === 0 时仍能保存（无字幕视频也能落底座）', async () => {
    await saveContentContext(
      {
        metadata: METADATA,
        transcriptCues: [],
        transcriptSource: 'unknown',
      },
      { contentKey: 'BV1xx:p=1' },
    );
    const cached = await getCachedContentContext({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
    });
    expect(cached).not.toBeNull();
    expect(cached?.transcriptCues).toEqual([]);
  });

  it('同一内容只保存一条记录，但浏览器字幕偏好变化时缓存失效', async () => {
    await saveContentContext(
      {
        metadata: METADATA,
        transcriptCues: [{ start: 0, text: 'English' }],
        transcriptSource: 'official',
        subtitlePreferenceKey: 'en-us,zh-cn',
      },
      { contentKey: 'BV1xx:p=1' },
    );

    const same = await getCachedContentContext({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
      subtitlePreferenceKey: 'en-us,zh-cn',
    });
    const changed = await getCachedContentContext({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
      subtitlePreferenceKey: 'zh-cn,en-us',
    });
    expect(same?.transcriptCues[0]?.text).toBe('English');
    expect(changed).toBeNull();
    expect(await db.contentContexts.count()).toBe(1);
  });

  it('旧 schema 或缺少字幕偏好 key 的记录不会恢复', async () => {
    await db.contentContexts.put({
      id: 'bilibili:legacy',
      schemaVersion: 13,
      platform: 'bilibili',
      contentKey: 'legacy',
      videoId: 'BV-legacy',
      kind: 'video',
      metadata: { ...METADATA, videoId: 'BV-legacy' },
      transcriptCues: [{ start: 0, text: 'legacy' }],
      transcriptCueCount: 1,
      transcriptSource: 'unknown',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(
      await getCachedContentContext({ platform: 'bilibili', contentKey: 'legacy' }),
    ).toBeNull();
  });
});
