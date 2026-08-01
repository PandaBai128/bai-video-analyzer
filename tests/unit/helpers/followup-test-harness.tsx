import { vi } from 'vitest';
import type { PageContext } from '@shared/page-context';
import type { PlaybackState } from '@shared/playback-state';
import type { VideoFollowupPortMessage } from '@shared/messages';

/**
 * 追问测试用的 FakePort + chrome.runtime stub 工具。
 *
 * 由 use-followup-session.test.tsx 和 followup-components.test.tsx 共享。
 * FollowupTab 集成测试也复用，避免在三个测试文件里重复维护。
 */

export interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  onDisconnect: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
  /** 测试主动调用，模拟 background 推 chunk / done / error。 */
  emitMessage: (message: VideoFollowupPortMessage) => void;
  emitDisconnect: () => void;
}

export function makeFakePort(): FakePort {
  const port: FakePort = {
    name: 'video-followup',
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn(),
    emitMessage: () => undefined,
    emitDisconnect: () => undefined,
  };
  let messageListener: ((raw: unknown) => void) | null = null;
  let disconnectListener: (() => void) | null = null;
  port.onMessage.addListener.mockImplementation((cb: (raw: unknown) => void) => {
    messageListener = cb;
  });
  port.onMessage.removeListener.mockImplementation((cb: (raw: unknown) => void) => {
    if (messageListener === cb) {
      messageListener = null;
    }
  });
  port.onDisconnect.addListener.mockImplementation((cb: () => void) => {
    disconnectListener = cb;
  });
  port.onDisconnect.removeListener.mockImplementation((cb: () => void) => {
    if (disconnectListener === cb) {
      disconnectListener = null;
    }
  });
  port.emitMessage = (message: VideoFollowupPortMessage): void => {
    if (messageListener) {
      messageListener(message);
    }
  };
  port.emitDisconnect = (): void => {
    if (disconnectListener) {
      disconnectListener();
    }
  };
  return port;
}

export function installChromePortStub(): FakePort {
  const port = makeFakePort();
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn(() => port),
    },
  });
  return port;
}

export function uninstallChromePortStub(): void {
  vi.unstubAllGlobals();
}

/**
 * 固定的 requestId 工厂：让测试断言 requestId 编号可控。
 */
export function makeRequestIdFactory(prefix: string): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

export const BILIBILI_CTX: PageContext = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: '测试视频',
  detectedAt: 0,
};

export const PLAYBACK: PlaybackState = {
  currentTime: 30,
  duration: 600,
  paused: true,
  updatedAt: 0,
};

/**
 * 从 port.postMessage mock 调用里提取第一个 ASK_VIDEO_QUESTION。
 */
export function getAskPayload(
  port: FakePort,
): Extract<VideoFollowupPortMessage, { type: 'ASK_VIDEO_QUESTION' }> {
  const call = port.postMessage.mock.calls.find(
    (entry) => (entry[0] as { type?: string })?.type === 'ASK_VIDEO_QUESTION',
  );
  if (!call) {
    throw new Error('port.postMessage 没有收到 ASK_VIDEO_QUESTION');
  }
  return call[0] as Extract<VideoFollowupPortMessage, { type: 'ASK_VIDEO_QUESTION' }>;
}
