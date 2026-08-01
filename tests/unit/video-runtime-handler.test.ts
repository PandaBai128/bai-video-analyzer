import { describe, expect, it, vi } from 'vitest';
import { createVideoRuntimeHandler } from '@extension/background/handlers/video-runtime-handler';
import type {
  VideoRuntimeHandlerDeps,
  VideoRuntimeRequest,
} from '@extension/background/handlers/video-runtime-handler';
import type { PageContext } from '@shared/page-context';
import type { PlaybackState } from '@shared/playback-state';
import type { ExtensionResponse } from '@shared/messages';

function makePageContext(overrides: Partial<PageContext> = {}): PageContext {
  return {
    platform: 'bilibili',
    url: 'https://www.bilibili.com/video/BV1xx',
    title: '测试视频',
    videoId: 'BV1xx',
    contentKey: 'BV1xx:p=10',
    detectedAt: 1,
    ...overrides,
  };
}

function makePlayback(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return { currentTime: 60, duration: 600, paused: false, updatedAt: 1, ...overrides };
}

function makeDeps(
  overrides: Partial<VideoRuntimeHandlerDeps> = {},
): VideoRuntimeHandlerDeps {
  return {
    // 页面上下文
    writePageContext: vi.fn(),
    deletePlayback: vi.fn(),
    isSupportedVideoContext: vi.fn().mockReturnValue(true),
    setLastVideoTabId: vi.fn(),
    resolveCurrentPageContext: vi.fn().mockResolvedValue(null),
    // 播放状态
    readCachedPlayback: vi.fn().mockReturnValue(null),
    writePlayback: vi.fn(),
    readPlaybackFromTab: vi.fn().mockResolvedValue(null),
    getCurrentVideoTabId: vi.fn().mockResolvedValue(null),
    getActiveTabId: vi.fn().mockResolvedValue(1),
    seek: vi.fn().mockResolvedValue({ ok: true, type: 'DONE' } satisfies ExtensionResponse),
    createErrorResponse: (code, message) => ({ ok: false, error: { code, message } }),
    now: () => 1_000_000,
    ...overrides,
  };
}

describe('createVideoRuntimeHandler', () => {
  describe('PAGE_DETECTED', () => {
    it('sender 无 tabId → 不写任何状态，返回 DONE', async () => {
      const writePageContext = vi.fn();
      const deletePlayback = vi.fn();
      const setLastVideoTabId = vi.fn();
      const deps = makeDeps({
        writePageContext,
        deletePlayback,
        setLastVideoTabId,
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'PAGE_DETECTED',
        payload: makePageContext(),
      };

      const response = await handler(request, null);

      expect(response).toEqual({ ok: true, type: 'DONE' });
      expect(writePageContext).not.toHaveBeenCalled();
      expect(deletePlayback).not.toHaveBeenCalled();
      expect(setLastVideoTabId).not.toHaveBeenCalled();
      expect(deps.readPlaybackFromTab).not.toHaveBeenCalled();
    });

    it('sender 有 tabId + 上下文是支持的视频 → 写 pageContexts + 删 playback + 更新 lastVideoTabId + 后台预取', async () => {
      const writePageContext = vi.fn();
      const deletePlayback = vi.fn();
      const setLastVideoTabId = vi.fn();
      const deps = makeDeps({
        writePageContext,
        deletePlayback,
        setLastVideoTabId,
        isSupportedVideoContext: vi.fn().mockReturnValue(true),
        readPlaybackFromTab: vi.fn().mockResolvedValue(makePlayback()),
      });
      const handler = createVideoRuntimeHandler(deps);
      const ctx = makePageContext();
      const request: VideoRuntimeRequest = {
        type: 'PAGE_DETECTED',
        payload: ctx,
      };

      const response = await handler(request, 7);

      expect(response).toEqual({ ok: true, type: 'DONE' });
      expect(writePageContext).toHaveBeenCalledWith(7, ctx);
      expect(deletePlayback).toHaveBeenCalledWith(7);
      expect(setLastVideoTabId).toHaveBeenCalledWith(7);
      // 等后台预取微任务完成
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deps.readPlaybackFromTab).toHaveBeenCalledWith(7);
      expect(deps.writePlayback).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ currentTime: 60 }),
      );
    });

    it('不支持的视频上下文 → 不更新 lastVideoTabId 且不预取', async () => {
      const setLastVideoTabId = vi.fn();
      const deps = makeDeps({
        setLastVideoTabId,
        isSupportedVideoContext: vi.fn().mockReturnValue(false),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'PAGE_DETECTED',
        payload: makePageContext({ platform: 'unknown' }),
      };

      const response = await handler(request, 5);

      expect(response).toEqual({ ok: true, type: 'DONE' });
      // 写 pageContexts + 删 playback 仍执行（与原 service-worker 一致）
      expect(deps.writePageContext).toHaveBeenCalled();
      expect(deps.deletePlayback).toHaveBeenCalled();
      expect(setLastVideoTabId).not.toHaveBeenCalled();
      expect(deps.readPlaybackFromTab).not.toHaveBeenCalled();
    });

    it('后台预取返回 null → 不写 playback', async () => {
      const writePlayback = vi.fn();
      const deps = makeDeps({
        writePlayback,
        isSupportedVideoContext: vi.fn().mockReturnValue(true),
        readPlaybackFromTab: vi.fn().mockResolvedValue(null),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'PAGE_DETECTED',
        payload: makePageContext(),
      };

      const response = await handler(request, 7);

      expect(response).toEqual({ ok: true, type: 'DONE' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deps.readPlaybackFromTab).toHaveBeenCalled();
      expect(writePlayback).not.toHaveBeenCalled();
    });

    it('deferred Promise：handler 在后台读取完成前返回 DONE，后台完成才写回缓存', async () => {
      let resolveRead: (value: PlaybackState | null) => void = () => {};
      const readPlaybackFromTab = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise<PlaybackState | null>((resolve) => {
              resolveRead = resolve;
            }),
        );
      const writePlayback = vi.fn();
      const deps = makeDeps({
        readPlaybackFromTab,
        writePlayback,
        isSupportedVideoContext: vi.fn().mockReturnValue(true),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'PAGE_DETECTED',
        payload: makePageContext(),
      };

      const response = await handler(request, 9);

      // handler 已立即返回 DONE（**未**等后台读取）
      expect(response).toEqual({ ok: true, type: 'DONE' });
      expect(writePlayback).not.toHaveBeenCalled();

      // 手动让后台读取 resolve
      resolveRead(makePlayback());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(writePlayback).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ currentTime: 60 }),
      );
    });
  });

  describe('GET_CURRENT_PAGE', () => {
    it('依赖返回 context → 返回 PAGE_CONTEXT payload=context', async () => {
      const ctx = makePageContext();
      const deps = makeDeps({
        resolveCurrentPageContext: vi.fn().mockResolvedValue(ctx),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_CURRENT_PAGE' };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: true,
        type: 'PAGE_CONTEXT',
        payload: ctx,
      });
    });

    it('依赖返回 null → 返回 PAGE_CONTEXT payload=null（**不**走错误响应）', async () => {
      const deps = makeDeps({
        resolveCurrentPageContext: vi.fn().mockResolvedValue(null),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_CURRENT_PAGE' };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: true,
        type: 'PAGE_CONTEXT',
        payload: null,
      });
    });
  });

  describe('PLAYBACK_PROGRESS', () => {
    it('sender 有 tabId → 写入该 tab 的播放缓存，返回 DONE', async () => {
      const writePlayback = vi.fn();
      const deps = makeDeps({ writePlayback });
      const handler = createVideoRuntimeHandler(deps);
      const state = makePlayback({ updatedAt: 1 });
      const request: VideoRuntimeRequest = {
        type: 'PLAYBACK_PROGRESS',
        payload: state,
      };

      const response = await handler(request, 42);

      expect(response).toEqual({ ok: true, type: 'DONE' });
      expect(writePlayback).toHaveBeenCalledWith(42, state);
    });

    it('sender 无 tabId → 不写缓存，仍返回 DONE', async () => {
      const writePlayback = vi.fn();
      const deps = makeDeps({ writePlayback });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'PLAYBACK_PROGRESS',
        payload: makePlayback(),
      };

      const response = await handler(request, null);

      expect(response).toEqual({ ok: true, type: 'DONE' });
      expect(writePlayback).not.toHaveBeenCalled();
    });
  });

  describe('GET_PLAYBACK_STATE', () => {
    it('无 active tab → 返回 PLAYBACK_STATE，payload=null，不调缓存依赖', async () => {
      const deps = makeDeps({
        getActiveTabId: vi.fn().mockResolvedValue(null),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_PLAYBACK_STATE' };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: true,
        type: 'PLAYBACK_STATE',
        payload: null,
      });
      expect(deps.readCachedPlayback).not.toHaveBeenCalled();
      expect(deps.readPlaybackFromTab).not.toHaveBeenCalled();
    });

    it('缓存命中且未过期 → 直返缓存，不主动读取', async () => {
      const now = 1_000_000;
      const cached = makePlayback({ updatedAt: now - 1_000 }); // 1 秒前，TTL 5s 内
      const deps = makeDeps({
        getActiveTabId: vi.fn().mockResolvedValue(1),
        readCachedPlayback: vi.fn().mockReturnValue(cached),
        now: () => now,
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_PLAYBACK_STATE' };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: true,
        type: 'PLAYBACK_STATE',
        payload: cached,
      });
      expect(deps.readCachedPlayback).toHaveBeenCalledTimes(1);
      // 缓存命中 → 不主动读取
      expect(deps.readPlaybackFromTab).not.toHaveBeenCalled();
      expect(deps.writePlayback).not.toHaveBeenCalled();
    });

    it('缓存命中但已过期 → 主动读取并写回', async () => {
      const now = 1_000_000;
      const cached = makePlayback({ updatedAt: now - 6_000 }); // 6 秒前，TTL 5s 已过
      const fresh = makePlayback({ updatedAt: now });
      const writePlayback = vi.fn();
      const deps = makeDeps({
        getActiveTabId: vi.fn().mockResolvedValue(1),
        readCachedPlayback: vi.fn().mockReturnValue(cached),
        readPlaybackFromTab: vi.fn().mockResolvedValue(fresh),
        writePlayback,
        now: () => now,
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_PLAYBACK_STATE' };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: true,
        type: 'PLAYBACK_STATE',
        payload: fresh,
      });
      expect(deps.readPlaybackFromTab).toHaveBeenCalledWith(1);
      expect(writePlayback).toHaveBeenCalledWith(1, fresh);
    });

    it('缓存缺失 → 主动读取', async () => {
      const fresh = makePlayback();
      const deps = makeDeps({
        getActiveTabId: vi.fn().mockResolvedValue(7),
        readCachedPlayback: vi.fn().mockReturnValue(null),
        readPlaybackFromTab: vi.fn().mockResolvedValue(fresh),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_PLAYBACK_STATE' };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: true,
        type: 'PLAYBACK_STATE',
        payload: fresh,
      });
      expect(deps.readPlaybackFromTab).toHaveBeenCalledWith(7);
      expect(deps.writePlayback).toHaveBeenCalledWith(7, fresh);
    });

    it('主动读取返回 null → 不覆盖缓存，响应 payload=null', async () => {
      const cached = makePlayback();
      const writePlayback = vi.fn();
      const deps = makeDeps({
        getActiveTabId: vi.fn().mockResolvedValue(1),
        readCachedPlayback: vi.fn().mockReturnValue(cached),
        readPlaybackFromTab: vi.fn().mockResolvedValue(null),
        writePlayback,
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_PLAYBACK_STATE' };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: true,
        type: 'PLAYBACK_STATE',
        payload: null,
      });
      expect(writePlayback).not.toHaveBeenCalled();
    });

    it('缓存命中且刚好 5000ms → 视为过期并主动读取（age < 5000 为有效）', async () => {
      const now = 1_000_000;
      const cached = makePlayback({ updatedAt: now - 5_000 }); // 刚好 5s
      const fresh = makePlayback({ updatedAt: now });
      const deps = makeDeps({
        getActiveTabId: vi.fn().mockResolvedValue(1),
        readCachedPlayback: vi.fn().mockReturnValue(cached),
        readPlaybackFromTab: vi.fn().mockResolvedValue(fresh),
        now: () => now,
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = { type: 'GET_PLAYBACK_STATE' };

      await handler(request, null);

      // age = 5000ms，**不**满足 age < 5000 → 过期 → 主动读取
      expect(deps.readPlaybackFromTab).toHaveBeenCalledTimes(1);
    });
  });

  describe('SEEK_ACTIVE_VIDEO', () => {
    it('无可跳转视频 tab → NO_ACTIVE_TAB + 原中文文案', async () => {
      const deps = makeDeps({
        getCurrentVideoTabId: vi.fn().mockResolvedValue(null),
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'SEEK_ACTIVE_VIDEO',
        payload: { seconds: 120 },
      };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: false,
        error: {
          code: 'NO_ACTIVE_TAB',
          message: '当前没有可跳转的视频标签页。请先打开 B 站或 YouTube 视频。',
        },
      });
      expect(deps.seek).not.toHaveBeenCalled();
    });

    it('有 tab → 把 tab ID 和原 request 传给 seek 并返回结果', async () => {
      const seek = vi.fn().mockResolvedValue({ ok: true, type: 'DONE' } satisfies ExtensionResponse);
      const deps = makeDeps({
        getCurrentVideoTabId: vi.fn().mockResolvedValue(42),
        seek,
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'SEEK_ACTIVE_VIDEO',
        payload: { seconds: 120 },
      };

      const response = await handler(request, null);

      expect(response).toEqual({ ok: true, type: 'DONE' });
      expect(seek).toHaveBeenCalledTimes(1);
      // seek 收到 tab ID 和**同一** request（透传；toBe 锁原对象引用）
      const callArgs = seek.mock.calls[0]!;
      expect(callArgs[0]).toBe(42);
      expect(callArgs[1]).toBe(request);
    });

    it('seek 返回错误响应 → handler 原样透传', async () => {
      const seek = vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'VIDEO_ELEMENT_NOT_FOUND', message: '没找到' },
      } satisfies ExtensionResponse);
      const deps = makeDeps({
        getCurrentVideoTabId: vi.fn().mockResolvedValue(7),
        seek,
      });
      const handler = createVideoRuntimeHandler(deps);
      const request: VideoRuntimeRequest = {
        type: 'SEEK_ACTIVE_VIDEO',
        payload: { seconds: 60 },
      };

      const response = await handler(request, null);

      expect(response).toEqual({
        ok: false,
        error: { code: 'VIDEO_ELEMENT_NOT_FOUND', message: '没找到' },
      });
    });
  });
});