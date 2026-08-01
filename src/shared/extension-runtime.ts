import { createErrorResponse, type ExtensionRequest, type ExtensionResponse } from './messages';

const CONTEXT_INVALIDATED_MESSAGE =
  '扩展刚刚重新加载，当前页面里的旧脚本已失效。请刷新视频页面，或关闭后重新打开侧边栏。';

export function isExtensionRuntimeAvailable(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

export async function sendRuntimeMessage(message: ExtensionRequest): Promise<ExtensionResponse> {
  if (!isExtensionRuntimeAvailable()) {
    return createErrorResponse('EXTENSION_CONTEXT_INVALIDATED', CONTEXT_INVALIDATED_MESSAGE);
  }

  try {
    return (await chrome.runtime.sendMessage(message)) as ExtensionResponse;
  } catch (error) {
    if (isExtensionContextError(error)) {
      return createErrorResponse('EXTENSION_CONTEXT_INVALIDATED', CONTEXT_INVALIDATED_MESSAGE);
    }

    const messageText = error instanceof Error ? error.message : String(error);
    return createErrorResponse('EXTENSION_RUNTIME_ERROR', `扩展消息通信失败：${messageText}`);
  }
}

function isExtensionContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Extension context invalidated|context invalidated|Receiving end does not exist/i.test(message);
}
