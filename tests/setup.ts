import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// 给 jsdom 一个最小可用的 chrome.* 桩，让引用 `chrome.runtime` 等顶层 API 的
// 模块（比如 service-worker.ts）能在 vitest 加载时不直接抛 ReferenceError。
// 业务测试可以按需 `vi.stubGlobal('chrome', ...)` 覆盖；任何子字段的 mock 也
// 必须放在本对象上，否则 `chrome.tabs.sendMessage(...)` 这种调用会走到 noop
// 默认实现上，掩盖真实问题。
interface ChromeMockShape {
  runtime: {
    onInstalled: { addListener: (cb: () => void) => void };
    onMessage: { addListener: (cb: (...args: unknown[]) => void) => void };
    onConnect: { addListener: (cb: (port: unknown) => void) => void };
    sendMessage: (...args: unknown[]) => void;
    lastError: { message: string } | null;
  };
  sidePanel: {
    setPanelBehavior: (opts: { openPanelOnActionClick: boolean }) => void;
    open: (opts: { tabId: number }) => Promise<void>;
  };
  tabs: {
    onActivated: {
      addListener: (cb: (...args: unknown[]) => void) => void;
      removeListener: (cb: (...args: unknown[]) => void) => void;
    };
    onUpdated: {
      addListener: (cb: (...args: unknown[]) => void) => void;
      removeListener: (cb: (...args: unknown[]) => void) => void;
    };
    query: (q: { active: boolean; currentWindow: boolean }) => Promise<Array<{ id?: number; url?: string; title?: string }>>;
    sendMessage: (...args: unknown[]) => void;
  };
  scripting?: {
    executeScript: (opts: unknown) => Promise<unknown>;
  };
  storage?: {
    local: { get: (k: string) => Promise<Record<string, unknown>>; set: (v: Record<string, unknown>) => Promise<void> };
  };
}

const createNoopChrome = (): ChromeMockShape => ({
  runtime: {
    onInstalled: { addListener: () => undefined },
    onMessage: { addListener: () => undefined },
    onConnect: { addListener: () => undefined },
    sendMessage: () => undefined,
    lastError: null,
  },
  sidePanel: {
    setPanelBehavior: () => undefined,
    open: async () => undefined,
  },
  tabs: {
    onActivated: { addListener: () => undefined, removeListener: () => undefined },
    onUpdated: { addListener: () => undefined, removeListener: () => undefined },
    query: async () => [],
    sendMessage: () => undefined,
  },
});

if (typeof (globalThis as { chrome?: unknown }).chrome === 'undefined') {
  (globalThis as { chrome: ChromeMockShape }).chrome = createNoopChrome();
}

afterEach(() => {
  globalThis.sessionStorage?.clear();
});
