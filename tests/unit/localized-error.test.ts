import { describe, expect, it } from 'vitest';
import { localizeUnknownError, localizeUserMessage } from '@extension/ui/localized-error';

describe('localized error messages', () => {
  it('keeps original Chinese messages in zh-CN mode', () => {
    expect(
      localizeUserMessage(
        { code: 'STREAM_TIMEOUT', message: '追问响应超时，请重试。' },
        'zh-CN',
      ),
    ).toBe('追问响应超时，请重试。');
  });

  it('maps common follow-up errors to English', () => {
    expect(
      localizeUserMessage(
        { code: 'MISSING_CURRENT_TIME', message: '还没有拿到当前播放位置，请先播放视频或在菜单里刷新页面状态后重试。' },
        'en-US',
      ),
    ).toBe(
      'Current playback position is not available yet. Play the video or refresh page status from the menu, then try again.',
    );
  });

  it('maps text model API key errors without naming MiniMax', () => {
    expect(
      localizeUserMessage(
        { code: 'MINIMAX_API_KEY_MISSING', message: '请先在设置中配置当前文本模型 API Key' },
        'en-US',
      ),
    ).toBe('The text model API key is not configured. Open Settings and add the API key first.');
  });

  it('keeps MiniMax explicit for English web search provider mismatch', () => {
    expect(
      localizeUserMessage(
        { code: 'WEB_SEARCH_MINIMAX_ONLY', message: '联网搜索实验功能当前仅支持 MiniMax。' },
        'en-US',
      ),
    ).toBe(
      'Web search currently only supports MiniMax. Switch the text model provider to MiniMax in Settings, or use Video-only / General answer basis.',
    );
  });

  it('keeps MiniMax explicit for English web search MiniMax API key errors', () => {
    expect(
      localizeUserMessage(
        { code: 'MINIMAX_API_KEY_MISSING', message: '请先在设置中配置 MiniMax API Key。' },
        'en-US',
      ),
    ).toBe(
      'MiniMax API key is required for web search. Configure the MiniMax API key in Settings first.',
    );
  });

  it('maps settings host permission errors to English', () => {
    expect(
      localizeUnknownError(
        new Error('尚未授权访问模型服务域名：https://api.example.com/*。请在设置页点击保存或测试连接完成授权。'),
        'en-US',
      ),
    ).toBe(
      'Access to model service host https://api.example.com/* has not been authorized. Click Save or Test Connection in Settings to authorize it.',
    );
  });

  it('maps settings base URL errors to English', () => {
    expect(
      localizeUnknownError(
        new Error('模型服务 Base URL 只允许 https，或本地调试的 http://localhost / http://127.0.0.1。'),
        'en-US',
      ),
    ).toBe(
      'Model service Base URL must use HTTPS, or local debug HTTP at http://localhost / http://127.0.0.1.',
    );
  });

  it('does not leak unknown Chinese messages in English mode', () => {
    expect(localizeUserMessage('未知中文错误', 'en-US')).toBe(
      'Operation failed. Check the current page, settings, and network, then try again.',
    );
  });
});
