import { describe, expect, it } from 'vitest';
import {
  createSubtitlePreferenceKey,
  normalizeSubtitleLanguageTag,
  sortSubtitleTracks,
} from '@core/subtitles/language-preference';

const track = (language: string, source: 'official' | 'asr' | 'unknown') => ({
  language,
  label: language,
  url: language,
  source,
});

describe('subtitle language preference', () => {
  it('normalizes platform prefixes and browser language variants', () => {
    expect(normalizeSubtitleLanguageTag(' zh_CN ')).toBe('zh-cn');
    expect(createSubtitlePreferenceKey(['zh-CN', 'en-US', 'zh-CN'])).toBe('zh-cn,en-us');
  });

  it('zh-CN selects ai-zh from the real Bilibili order instead of ai-ar', () => {
    const sorted = sortSubtitleTracks(
      [
        track('ai-ar', 'asr'),
        track('ai-es', 'asr'),
        track('ai-pt', 'asr'),
        track('ai-zh', 'unknown'),
        track('ai-en', 'asr'),
        track('ai-ja', 'asr'),
      ],
      ['zh-CN', 'en-US', 'en', 'zh'],
    );
    expect(sorted[0]?.language).toBe('ai-zh');
  });

  it('en-US selects English, and other browser languages select a matching family', () => {
    const tracks = [track('ai-zh', 'official'), track('ai-en', 'asr'), track('ai-es', 'asr')];
    expect(sortSubtitleTracks(tracks, ['en-US'])[0]?.language).toBe('ai-en');
    expect(sortSubtitleTracks(tracks, ['es-ES', 'en-US'])[0]?.language).toBe('ai-es');
  });

  it('首选语言抓取失败后仍按中文、英文、其他语言回退', () => {
    const sorted = sortSubtitleTracks(
      [track('fr', 'asr'), track('ar', 'asr'), track('zh', 'asr'), track('en', 'asr')],
      ['fr-FR'],
    );
    expect(sorted.map((item) => item.language)).toEqual(['fr', 'zh', 'en', 'ar']);
  });

  it('同一语言族先按来源质量，再用地区精确匹配打破并列', () => {
    const sorted = sortSubtitleTracks(
      [track('en-US', 'asr'), track('en', 'official')],
      ['en-US'],
    );
    expect(sorted.map((item) => `${item.language}:${item.source}`)).toEqual([
      'en:official',
      'en-US:asr',
    ]);
  });

  it('falls back to Chinese, then English, then any language when no preference matches', () => {
    const tracks = [track('ai-ar', 'asr'), track('ai-en', 'asr'), track('ai-zh', 'asr')];
    expect(sortSubtitleTracks(tracks, ['fr-FR'])[0]?.language).toBe('ai-zh');
    expect(
      sortSubtitleTracks([track('ai-ar', 'asr'), track('ai-en', 'asr')], ['fr-FR'])[0]?.language,
    ).toBe('ai-en');
    expect(sortSubtitleTracks([track('ai-ar', 'asr')], ['fr-FR'])[0]?.language).toBe('ai-ar');
  });

  it('orders quality only within the selected language and keeps unknown fields stable', () => {
    const sorted = sortSubtitleTracks(
      [track('en', 'asr'), track('en-US', 'official'), track('en', 'unknown')],
      ['en-US'],
    );
    expect(sorted.map((item) => `${item.language}:${item.source}`)).toEqual([
      'en-US:official',
      'en:unknown',
      'en:asr',
    ]);
  });
});
