import { describe, expect, it } from 'vitest';
import {
  detectQuestionLocale,
  isGeneratedTextLikelyLocale,
  resolveUiLocale,
} from '@shared/locale-settings';

describe('locale settings', () => {
  it('auto 模式：中文系浏览器默认中文，非中文默认英文', () => {
    expect(resolveUiLocale('auto', ['zh-TW', 'en-US'])).toBe('zh-CN');
    expect(resolveUiLocale('auto', ['zh-Hant-TW'])).toBe('zh-CN');
    expect(resolveUiLocale('auto', ['ja-JP', 'en-US'])).toBe('en-US');
  });

  it('问答语言由问题文字决定', () => {
    expect(detectQuestionLocale('这个视频讲什么？')).toBe('zh-CN');
    expect(detectQuestionLocale('What is this video about?')).toBe('en-US');
  });

  it('混合语言问题按提问框架判断，不被被解释词带偏', () => {
    expect(
      detectQuestionLocale(
        'Can you show me which exact animation frame she means by “冲刺末尾收扇”?',
      ),
    ).toBe('en-US');
    expect(detectQuestionLocale('Can you explain 《冲刺末尾收扇》?')).toBe('en-US');
    expect(detectQuestionLocale('Can you explain 〈冲刺末尾收扇〉?')).toBe('en-US');
    expect(detectQuestionLocale('What does “happy” mean?')).toBe('en-US');
    expect(detectQuestionLocale('请解释 happy 这个词的意思')).toBe('zh-CN');
    expect(detectQuestionLocale('happy 是什么意思？')).toBe('zh-CN');
    expect(detectQuestionLocale('BM25 的核心思想')).toBe('zh-CN');
  });

  it('语言判断忽略系统追加的当前播放时间锚点', () => {
    expect(
      detectQuestionLocale(
        'Explain what the current segment is saying.（当前播放时间：1:12）',
      ),
    ).toBe('en-US');
    expect(detectQuestionLocale('这段在讲什么 (current playback time: 1:12)')).toBe('zh-CN');
  });

  it('英文派生产物允许少量中文专名，但过滤大段中文旧缓存', () => {
    expect(
      isGeneratedTextLikelyLocale(
        'This section explains how to photograph 维琳娜 in a fast action pose.',
        'en-US',
      ),
    ).toBe(true);
    expect(
      isGeneratedTextLikelyLocale(
        '这是一条偏粉丝向的游戏角色抓拍向短片，适合作为消遣刷到时快速看完，不必专门花时间找来看。',
        'en-US',
      ),
    ).toBe(false);
  });
});
