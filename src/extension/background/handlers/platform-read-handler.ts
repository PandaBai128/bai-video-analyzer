/**
 * 平台能力读取消息 handler。
 *
 * 处理 `FETCH_YOUTUBE_TRANSCRIPT` / `GET_BILIBILI_COOKIES`。业务逻辑从
 * service-worker.ts 迁出；handler 不调用 chrome.*、不持有全局状态、不引入
 * default throw。
 *
 * 字幕抓取走现有 content script 注入 / 轮询 / 重试链路，cookie 走现有
 * cookie-service；handler 只编排两者，**不**复用底层状态。
 */
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import type { BilibiliCookieSnapshot } from '@extension/background/cookie-service';
import type {
  YouTubeTranscriptError,
  YouTubeTranscriptResult,
  YouTubeTranscriptAttempt,
} from '@shared/youtube-transcript';

export type PlatformReadRequest = Extract<
  ExtensionRequest,
  { type: 'FETCH_YOUTUBE_TRANSCRIPT' | 'GET_BILIBILI_COOKIES' }
>;

/**
 * 字幕抓取底层结果。使用 `@shared/youtube-transcript` 共享协议类型，handler
 * 不能构造出非法响应。成功 result / attempts / 失败 error 都原对象透传。
 */
export type FetchTranscriptResult =
  | {
      readonly ok: true;
      readonly result: YouTubeTranscriptResult;
      readonly attempts: readonly YouTubeTranscriptAttempt[];
    }
  | { readonly ok: false; readonly error: YouTubeTranscriptError };

export interface PlatformReadHandlerDeps {
  /** 获取当前可用视频 tab ID；无 tab 或非支持平台时返回 null。 */
  readonly getCurrentVideoTabId: () => Promise<number | null>;
  /** 从指定 tab 抓取 YouTube 字幕。 */
  readonly fetchTranscriptFromTab: (
    tabId: number,
    payload: { videoId: string; languages?: readonly string[] },
  ) => Promise<FetchTranscriptResult>;
  /** 读取 B 站 cookie snapshot。 */
  readonly readBilibiliCookieSnapshot: () => Promise<BilibiliCookieSnapshot>;
  /** 构造普通错误响应（用于 NO_ACTIVE_TAB）。 */
  readonly createErrorResponse: (code: string, message: string) => ExtensionResponse;
}

export type PlatformReadHandler = (
  request: PlatformReadRequest,
) => Promise<ExtensionResponse>;

export function createPlatformReadHandler(
  deps: PlatformReadHandlerDeps,
): PlatformReadHandler {
  return async (request) => {
    switch (request.type) {
      case 'FETCH_YOUTUBE_TRANSCRIPT': {
        const tabId = await deps.getCurrentVideoTabId();
        if (typeof tabId !== 'number') {
          return deps.createErrorResponse(
            'NO_ACTIVE_TAB',
            '没有找到当前 YouTube 视频标签页',
          );
        }

        const transcript = await deps.fetchTranscriptFromTab(tabId, request.payload);
        if (!transcript.ok) {
          return {
            ok: false,
            type: 'YOUTUBE_TRANSCRIPT_FAILED',
            error: transcript.error,
          };
        }

        return {
          ok: true,
          type: 'YOUTUBE_TRANSCRIPT',
          payload: {
            result: transcript.result,
            attempts: transcript.attempts,
          },
        };
      }

      case 'GET_BILIBILI_COOKIES': {
        const snapshot = await deps.readBilibiliCookieSnapshot();
        return {
          ok: true,
          type: 'BILIBILI_COOKIES',
          payload: snapshot,
        };
      }
    }
  };
}