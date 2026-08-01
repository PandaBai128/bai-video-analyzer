import type { UiLocale } from '@shared/locale-settings';

export interface LocalizableErrorMessage {
  readonly code?: string;
  readonly message: string;
}

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  API_ERROR: 'The platform API returned an error. Try again later.',
  API_KEY_MISSING: 'API key is not configured. Open Settings and add an API key first.',
  CONTENT_CONTEXT_REQUIRED: 'Open the current video content first.',
  CONTENT_SCRIPT_UNAVAILABLE: 'The page script is not available. Refresh the video page and try again.',
  EMPTY_LEARNING_EXCHANGE: 'Only complete Q&A pairs can be added to study notes.',
  EMPTY_LEARNING_MOMENT: 'Record content cannot be empty.',
  EXTENSION_CONTEXT_INVALIDATED:
    'The extension was just reloaded, so the old script on this page is no longer valid. Refresh the video page or reopen the side panel.',
  EXTENSION_RUNTIME_ERROR: 'Extension message failed.',
  INVALID_URL: 'This video URL could not be recognized.',
  LEARNING_GUIDE_GENERATION_FAILED:
    'Analysis generation failed because the model output was incomplete or invalid. The previous analysis is kept if available; try again later.',
  LEARNING_GUIDE_GENERATION_TIMEOUT:
    'Analysis generation timed out. The previous analysis is kept; try again later.',
  LEARNING_MOMENT_NOT_FOUND: 'This learning record was not found.',
  LEARNING_REVIEW_GENERATION_FAILED:
    'Study note generation failed because the model output was incomplete or invalid. Try again.',
  LLM_ERROR: 'The model request failed. Check the model settings and try again.',
  MINIMAX_API_KEY_MISSING:
    'The text model API key is not configured. Open Settings and add the API key first.',
  MISSING_CURRENT_TIME:
    'Current playback position is not available yet. Play the video or refresh page status from the menu, then try again.',
  NETWORK_ERROR: 'Network request failed. Check the connection and try again.',
  NO_ACTIVE_TAB: 'No active tab was found.',
  NO_CONTENT_CONTEXT:
    'No usable subtitles or transcript were found for this video. Try another video or refresh the page.',
  NO_PAGE_CONTEXT: 'No supported video page has been detected yet.',
  NO_SUBTITLE:
    'No usable subtitles were found for this video. The public build needs subtitles for analysis, Q&A, and study notes.',
  NO_VIDEO_ID: 'This video ID could not be recognized.',
  PARSE_ERROR: 'Failed to parse the platform response. Try again later.',
  PORT_DISCONNECTED: 'The connection to the extension background was lost. Try again.',
  POST_MESSAGE_FAILED: 'Failed to send the follow-up question.',
  SESSION_INTERRUPTED: 'This answer was interrupted by a disconnected session. Ask again to continue.',
  STREAM_TIMEOUT: 'The follow-up response timed out. Try again.',
  TOO_MANY_REVIEW_EXCHANGES: 'Up to 8 Q&A items can be added to study notes.',
  UNKNOWN_MESSAGE: 'Unknown message type.',
  UNSUPPORTED_ANALYSIS_MODE:
    'The public build only supports fast subtitle analysis. Save settings again and retry.',
  UNSUPPORTED_PLATFORM:
    'This page is not supported yet. Open a Bilibili or YouTube video page.',
};

const MESSAGE_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly toEnglish: (match: RegExpMatchArray) => string;
}[] = [
  {
    pattern: /^尚未授权访问模型服务域名：(.+?)。请在设置页点击保存或测试连接完成授权。$/,
    toEnglish: (match) =>
      `Access to model service host ${match[1] ?? ''} has not been authorized. Click Save or Test Connection in Settings to authorize it.`,
  },
  {
    pattern: /^尚未授权访问模型服务域名：(.+)$/,
    toEnglish: (match) =>
      `Access to model service host ${match[1] ?? ''} has not been authorized.`,
  },
  {
    pattern: /^模型服务 Base URL 不是合法 URL。$/,
    toEnglish: () => 'Model service Base URL is not a valid URL.',
  },
  {
    pattern: /^模型服务 Base URL 只允许 https，或本地调试的? http:\/\/localhost \/ http:\/\/127\.0\.0\.1。$/,
    toEnglish: () =>
      'Model service Base URL must use HTTPS, or local debug HTTP at http://localhost / http://127.0.0.1.',
  },
  {
    pattern: /^当前浏览器不支持本地目录授权$/,
    toEnglish: () => 'This browser does not support local folder authorization.',
  },
  {
    pattern: /^扩展消息通信失败：(.+)$/,
    toEnglish: (match) => `Extension message failed: ${sanitizeEnglishDetail(match[1] ?? '')}`,
  },
  {
    pattern: /^追问发送失败：(.+)$/,
    toEnglish: (match) =>
      `Failed to send the follow-up question: ${sanitizeEnglishDetail(match[1] ?? '')}`,
  },
  {
    pattern: /^当前页面不是 YouTube 视频页。请打开 https:\/\/www\.youtube\.com\/watch\?v=.+ 后重试。$/,
    toEnglish: () =>
      'This page is not a YouTube video page. Open a YouTube watch page and try again.',
  },
  {
    pattern: /^当前页 videoId\(.+\) 与请求 videoId\(.+\) 不一致，拒绝使用$/,
    toEnglish: () =>
      'The current page video ID does not match the requested video ID, so the result was rejected.',
  },
  {
    pattern: /^当前 B 站未登录时没有返回字幕。若播放器提示登录，请登录后刷新页面再试。$/,
    toEnglish: () =>
      'Bilibili did not return subtitles while logged out. If the player asks you to log in, log in and refresh the page.',
  },
  {
    pattern: /^当前内容没有可用字幕，公开版需要字幕才能分析、提问或写笔记。$/,
    toEnglish: () =>
      'No usable subtitles were found for this content. The public build needs subtitles for analysis, Q&A, and study notes.',
  },
  {
    pattern: /^已保存的 Markdown Vault 目录不可用，请到设置页重新选择目录后再导出$/,
    toEnglish: () =>
      'The saved Markdown Vault folder is unavailable. Choose the folder again in Settings before exporting.',
  },
  {
    pattern: /^请先在设置页选择 Markdown Vault 目录$/,
    toEnglish: () => 'Choose a Markdown Vault directory in Settings first.',
  },
  {
    pattern: /^没有 Markdown Vault 写入权限$/,
    toEnglish: () => 'Markdown Vault write permission is not granted.',
  },
  {
    pattern: /^已取消导出，未覆盖原文件$/,
    toEnglish: () => 'Export cancelled. Existing file was not overwritten.',
  },
  {
    pattern: /^与扩展后台的连接已断开，请重试。$/,
    toEnglish: () =>
      CODE_MESSAGES.PORT_DISCONNECTED ??
      'The connection to the extension background was lost. Try again.',
  },
  {
    pattern: /^追问响应超时，请重试。$/,
    toEnglish: () => CODE_MESSAGES.STREAM_TIMEOUT ?? 'The follow-up response timed out. Try again.',
  },
  {
    pattern: /^还没有拿到当前播放位置，请先播放视频或在菜单里刷新页面状态后重试。$/,
    toEnglish: () =>
      CODE_MESSAGES.MISSING_CURRENT_TIME ??
      'Current playback position is not available yet. Play the video or refresh page status from the menu, then try again.',
  },
  {
    pattern: /^连接中断导致这次回答中断，请重新提问。$/,
    toEnglish: () =>
      CODE_MESSAGES.SESSION_INTERRUPTED ??
      'This answer was interrupted by a disconnected session. Ask again to continue.',
  },
];

export function localizeUserMessage(
  error: LocalizableErrorMessage | string,
  locale: UiLocale,
): string {
  const message = typeof error === 'string' ? error : error.message;
  const code = typeof error === 'string' ? undefined : error.code;
  if (locale !== 'en-US') {
    return message;
  }

  if (code === 'POST_MESSAGE_FAILED') {
    return localizePostMessageFailure(message);
  }
  if (code === 'WEB_SEARCH_MINIMAX_ONLY') {
    return 'Web search currently only supports MiniMax. Switch the text model provider to MiniMax in Settings, or use Video-only / General answer basis.';
  }
  if (code === 'MINIMAX_API_KEY_MISSING' && /MiniMax (?:API )?Key/i.test(message)) {
    return 'MiniMax API key is required for web search. Configure the MiniMax API key in Settings first.';
  }
  const codeMessage = code ? CODE_MESSAGES[code] : undefined;
  if (codeMessage) {
    return codeMessage;
  }

  const mapped = localizeMessagePattern(message);
  if (mapped) {
    return mapped;
  }

  if (containsHan(message)) {
    return 'Operation failed. Check the current page, settings, and network, then try again.';
  }
  return message;
}

export function localizeUnknownError(error: unknown, locale: UiLocale): string {
  if (error instanceof Error) {
    return localizeUserMessage(error.message, locale);
  }
  return localizeUserMessage(String(error), locale);
}

function localizePostMessageFailure(message: string): string {
  const mapped = localizeMessagePattern(message);
  if (mapped) return mapped;
  return CODE_MESSAGES.POST_MESSAGE_FAILED ?? 'Failed to send the follow-up question.';
}

function localizeMessagePattern(message: string): string | null {
  for (const item of MESSAGE_PATTERNS) {
    const match = message.match(item.pattern);
    if (match) {
      return item.toEnglish(match);
    }
  }
  return null;
}

function sanitizeEnglishDetail(detail: string): string {
  if (!detail) return '';
  if (detail === 'port 未连接') return 'port is not connected';
  if (containsHan(detail)) return 'see extension logs for details';
  return detail;
}

function containsHan(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}
