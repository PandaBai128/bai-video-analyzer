/**
 * 当前视频标签页运行态 handler。
 *
 * 处理 `PAGE_DETECTED` / `GET_CURRENT_PAGE` / `PLAYBACK_PROGRESS` /
 * `GET_PLAYBACK_STATE` / `SEEK_ACTIVE_VIDEO`。这五个消息都以当前 tab 为身份
 * 边界、共享 `playbackStates` / `lastVideoTabId` / 视频 tab 解析，合并为
 * 一个职责。
 *
 * 业务逻辑从 service-worker.ts 迁出；handler 不调用 chrome.*、不持有 Map 或
 * 模块级可变状态、不引入 default throw。缓存读写必须访问 service-worker 持有的
 * 同一 `playbackStates` / `pageContexts`（通过闭包注入实现）。
 *
 * PAGE_DETECTED 后页面切换需立即预取播放状态以缩短 GET_PLAYBACK_STATE 空窗，
 * 但该后台读取**不能**阻塞 `DONE` 响应 —— 保持 fire-and-forget 时序。
 */
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { PageContext } from '@shared/page-context';
import type { PlaybackState } from '@shared/playback-state';

export type VideoRuntimeRequest = Extract<
  ExtensionRequest,
  {
    type:
      | 'PAGE_DETECTED'
      | 'GET_CURRENT_PAGE'
      | 'PLAYBACK_PROGRESS'
      | 'GET_PLAYBACK_STATE'
      | 'SEEK_ACTIVE_VIDEO';
  }
>;

/** 5 秒缓存有效阈值（与原 service-worker 内 5_000 数字保持一致）。 */
const PLAYBACK_CACHE_TTL_MS = 5_000;

export interface VideoRuntimeHandlerDeps {
  // —— 页面上下文 ——
  readonly writePageContext: (tabId: number, context: PageContext) => void;
  readonly deletePlayback: (tabId: number) => void;
  readonly isSupportedVideoContext: (context: PageContext) => boolean;
  /** 更新最后视频 tab ID（lastVideoTabId 状态）。 */
  readonly setLastVideoTabId: (tabId: number) => void;
  /**
   * 解析当前 active tab 的页面上下文。返回 null 表示无 active tab
   * 或当前 tab 无可用页面上下文。
   */
  readonly resolveCurrentPageContext: () => Promise<PageContext | null>;

  // —— 播放状态 ——
  readonly readCachedPlayback: (tabId: number) => PlaybackState | null;
  readonly writePlayback: (tabId: number, state: PlaybackState) => void;
  /**
   * 主动从 tab 读取新播放状态（含 content script 注入 + 重试）。
   * 返回 null 表示读不到；调用方决定是否写回缓存。
   */
  readonly readPlaybackFromTab: (tabId: number) => Promise<PlaybackState | null>;
  /** 解析当前可跳转视频 tab ID（service-worker 内 getCurrentVideoTabId）。 */
  readonly getCurrentVideoTabId: () => Promise<number | null>;
  /**
   * 解析当前 active tab（GET_PLAYBACK_STATE 用），返回 tab.id 或 null。
   * 与 getCurrentVideoTabId 区别：后者还会回退到 lastVideoTabId；active tab 仅
   * 询问 chrome.tabs.query({ active, currentWindow })。
   */
  readonly getActiveTabId: () => Promise<number | null>;
  /** SEEK_ACTIVE_VIDEO 的 seek 依赖，透传 request 并返回结果。 */
  readonly seek: (
    tabId: number,
    request: Extract<ExtensionRequest, { type: 'SEEK_ACTIVE_VIDEO' }>,
  ) => Promise<ExtensionResponse>;
  readonly createErrorResponse: (code: string, message: string) => ExtensionResponse;
  /** 当前时间；测试可注入以稳定 5 秒缓存规则。 */
  readonly now: () => number;
}

export type VideoRuntimeHandler = (
  request: VideoRuntimeRequest,
  tabId: number | null,
) => Promise<ExtensionResponse>;

export function createVideoRuntimeHandler(
  deps: VideoRuntimeHandlerDeps,
): VideoRuntimeHandler {
  return async (request, tabId) => {
    switch (request.type) {
      case 'PAGE_DETECTED': {
        if (typeof tabId !== 'number') {
          return { ok: true, type: 'DONE' };
        }
        deps.writePageContext(tabId, request.payload);
        deps.deletePlayback(tabId);
        if (deps.isSupportedVideoContext(request.payload)) {
          deps.setLastVideoTabId(tabId);
          // 后台预取播放状态以缩短 GET_PLAYBACK_STATE 空窗；不阻塞响应。
          void (async (): Promise<void> => {
            const fresh = await deps.readPlaybackFromTab(tabId);
            if (fresh) {
              deps.writePlayback(tabId, fresh);
            }
          })();
        }
        return { ok: true, type: 'DONE' };
      }

      case 'GET_CURRENT_PAGE': {
        return {
          ok: true,
          type: 'PAGE_CONTEXT',
          payload: await deps.resolveCurrentPageContext(),
        };
      }

      case 'PLAYBACK_PROGRESS': {
        if (typeof tabId === 'number') {
          deps.writePlayback(tabId, request.payload);
        }
        return { ok: true, type: 'DONE' };
      }

      case 'GET_PLAYBACK_STATE': {
        const activeTabId = await deps.getActiveTabId();
        if (typeof activeTabId !== 'number') {
          return { ok: true, type: 'PLAYBACK_STATE', payload: null };
        }
        const cached = deps.readCachedPlayback(activeTabId);
        if (cached && deps.now() - cached.updatedAt < PLAYBACK_CACHE_TTL_MS) {
          return { ok: true, type: 'PLAYBACK_STATE', payload: cached };
        }
        const fresh = await deps.readPlaybackFromTab(activeTabId);
        if (fresh) {
          deps.writePlayback(activeTabId, fresh);
        }
        return { ok: true, type: 'PLAYBACK_STATE', payload: fresh };
      }

      case 'SEEK_ACTIVE_VIDEO': {
        const videoTabId = await deps.getCurrentVideoTabId();
        if (typeof videoTabId !== 'number') {
          return deps.createErrorResponse(
            'NO_ACTIVE_TAB',
            '当前没有可跳转的视频标签页。请先打开 B 站或 YouTube 视频。',
          );
        }
        return deps.seek(videoTabId, request);
      }
    }
  };
}
