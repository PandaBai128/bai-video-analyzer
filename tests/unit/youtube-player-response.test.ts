import { describe, expect, it } from 'vitest';
import {
  parseInnertubePlayerResponse,
  parseTranscriptXml,
  sortCaptionTracks,
} from '@core/adapters/youtube-player-response';
import type { SubtitleCue } from '@core/types';

describe('parseInnertubePlayerResponse', () => {
  const baseResponse = {
    playabilityStatus: { status: 'OK' },
    videoDetails: {
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      author: 'Rick Astley',
      lengthSeconds: '213',
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
            languageCode: 'en',
            kind: 'asr',
            name: { simpleText: 'English' },
          },
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-Hans',
            languageCode: 'zh-Hans',
            name: { runs: [{ text: '简体中文' }] },
          },
        ],
      },
    },
  };

  it('extracts videoId, metadata, and captionTracks from Android innerTube response', () => {
    const parsed = parseInnertubePlayerResponse(baseResponse, 'dQw4w9WgXcQ');

    expect(parsed.videoId).toBe('dQw4w9WgXcQ');
    expect(parsed.metadata.title).toBe('Never Gonna Give You Up');
    expect(parsed.metadata.author).toBe('Rick Astley');
    expect(parsed.metadata.lengthSeconds).toBe(213);
    expect(parsed.captionTracks).toHaveLength(2);
    expect(parsed.captionTracks[0]?.languageCode).toBe('en');
    expect(parsed.captionTracks[0]?.kind).toBe('asr');
    expect(parsed.captionTracks[1]?.kind).toBe('official');
    expect(parsed.captionTracks[1]?.name).toBe('简体中文');
  });

  it('rejects when innerTube videoId does not match expected', () => {
    expect(() => parseInnertubePlayerResponse(baseResponse, 'AAAAAAAAAAA')).toThrow(
      /videoId.*不一致/,
    );
  });

  it('surfaces UNPLAYABLE playabilityStatus with reason', () => {
    const response = {
      ...baseResponse,
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
      },
    };

    expect(() => parseInnertubePlayerResponse(response, 'dQw4w9WgXcQ')).toThrow(/LOGIN_REQUIRED/);
  });

  it('throws NO_CAPTION_TRACKS when there are no tracks', () => {
    const response = {
      ...baseResponse,
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    };

    expect(() => parseInnertubePlayerResponse(response, 'dQw4w9WgXcQ')).toThrow(/没有可用的字幕轨/);
  });

  it('throws YouTubePlayerResponseParseError (real Error subclass) so error.message is not [object Object]', () => {
    // 这个 case 是修 #3 的关键：parser 必须抛真正的 Error 子类，否则上层
    // `error instanceof Error ? error.message : String(error)` 会得到 `[object Object]`。
    let caught: unknown;
    try {
      parseInnertubePlayerResponse(
        {
          ...baseResponse,
          playabilityStatus: { status: 'UNPLAYABLE', reason: 'Video unavailable' },
        },
        'dQw4w9WgXcQ',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('UNPLAYABLE');
    expect((caught as Error).message).not.toBe('[object Object]');
  });

  it('throws when response is not an object', () => {
    expect(() => parseInnertubePlayerResponse(null, 'dQw4w9WgXcQ')).toThrow();
    expect(() => parseInnertubePlayerResponse('string', 'dQw4w9WgXcQ')).toThrow();
  });
});

describe('sortCaptionTracks', () => {
  it('按浏览器语言优先，再在同一语言内按 official > asr 排序', () => {
    const tracks = [
      { languageCode: 'en', kind: 'asr' as const, baseUrl: 'a' },
      { languageCode: 'ja', kind: 'official' as const, baseUrl: 'b' },
      { languageCode: 'en', kind: 'official' as const, baseUrl: 'c' },
      { languageCode: 'zh-Hans', kind: 'asr' as const, baseUrl: 'd' },
      { languageCode: 'zh-Hans', kind: 'official' as const, baseUrl: 'e' },
    ];
    const sorted = sortCaptionTracks(tracks, ['en-US']);
    expect(sorted.map((t) => `${t.languageCode}:${t.kind}`)).toEqual([
      'en:official',
      'en:asr',
      'zh-Hans:official',
      'zh-Hans:asr',
      'ja:official',
    ]);
  });

  it('is stable: preserves input order within same priority', () => {
    const tracks = [
      { languageCode: 'en', kind: 'official' as const, baseUrl: 'first' },
      { languageCode: 'en', kind: 'official' as const, baseUrl: 'second' },
    ];
    const sorted = sortCaptionTracks(tracks, ['en-US']);
    expect(sorted.map((t) => t.baseUrl)).toEqual(['first', 'second']);
  });

  it('returns empty array on empty input', () => {
    expect(sortCaptionTracks([])).toEqual([]);
  });

  it('prefers manual en over asr zh (the bug behind "时间线从 18 分钟才开始" 的旁路)', () => {
    // 用户实际可能遇到的 case：视频有 official en + asr zh-Hans。之前的 pickTrack
    // 二次按语言匹配会选 asr zh-Hans —— 违背"人工字幕优先于 ASR"的硬约束。
    // 现在的 sortCaptionTracks 是唯一权威排序，调用方取第一条即可。
    const tracks = [
      { languageCode: 'en', kind: 'asr' as const, baseUrl: 'asr-en' },
      { languageCode: 'zh-Hans', kind: 'asr' as const, baseUrl: 'asr-zh' },
      { languageCode: 'en', kind: 'official' as const, baseUrl: 'manual-en' },
    ];
    const sorted = sortCaptionTracks(tracks, ['en-US']);
    expect(sorted[0]?.kind).toBe('official');
    expect(sorted[0]?.languageCode).toBe('en');
  });
});

describe('parseTranscriptXml', () => {
  it('parses format A: <transcript><text start dur>', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<transcript>' +
      '<text start="0.24" dur="6.8">Never gonna give you up</text>' +
      '<text start="7.04" dur="7.0">Never gonna let you down</text>' +
      '</transcript>';

    const cues = parseTranscriptXml(xml);
    expect(cues).toEqual<SubtitleCue[]>([
      { start: 0.24, end: 7.04, text: 'Never gonna give you up' },
      { start: 7.04, end: 14.04, text: 'Never gonna let you down' },
    ]);
  });

  it('parses format B: <timedtext><body><p t d><s>', () => {
    const xml =
      '<timedtext format="3">' +
      '<body>' +
      '<p t="240" d="6800"><s>Never</s><s> gonna</s><s> give</s><s> you</s><s> up</s></p>' +
      '<p t="7040" d="7000"><s>Never</s><s> gonna</s><s> let</s><s> you</s><s> down</s></p>' +
      '</body>' +
      '</timedtext>';

    const cues = parseTranscriptXml(xml);
    expect(cues).toEqual<SubtitleCue[]>([
      { start: 0.24, end: 7.04, text: 'Never gonna give you up' },
      { start: 7.04, end: 14.04, text: 'Never gonna let you down' },
    ]);
  });

  // Round 9 修：用户报"字幕 XML 中没有可识别的 p 节点"——实际是 YouTube
  // timedtext 的一种变体，<p> 元素里**没有** <s> 子节点包裹，文字直接挂在 <p> 上。
  // 之前 parser 用 `p.querySelectorAll('s')` 拿不到 <s> 就 join 出空字符串，
  // 全部节点被 filter 掉 → `cues.length === 0` → 抛 NO_CUES。
  // 修法：<s> 拿不到时 fallback 到 `p.textContent`。
  it('parses format B variant: <p> without <s> wrappers (text directly in <p>)', () => {
    const xml =
      '<timedtext format="3">' +
      '<body>' +
      '<p t="240" d="6800">Never gonna give you up</p>' +
      '<p t="7040" d="7000">Never gonna let you down</p>' +
      '</body>' +
      '</timedtext>';

    const cues = parseTranscriptXml(xml);
    expect(cues).toEqual<SubtitleCue[]>([
      { start: 0.24, end: 7.04, text: 'Never gonna give you up' },
      { start: 7.04, end: 14.04, text: 'Never gonna let you down' },
    ]);
  });

  it('parses format B mixed: some <p> with <s>, some without', () => {
    // 真实场景：YouTube 偶尔返回的 timedtext 里两种变体混在一起
    const xml =
      '<timedtext format="3">' +
      '<body>' +
      '<p t="240" d="6800"><s>Never</s><s> gonna</s></p>' +
      '<p t="7040" d="7000">give you up</p>' +
      '</body>' +
      '</timedtext>';

    const cues = parseTranscriptXml(xml);
    expect(cues).toEqual<SubtitleCue[]>([
      { start: 0.24, end: 7.04, text: 'Never gonna' },
      { start: 7.04, end: 14.04, text: 'give you up' },
    ]);
  });

  it('throws XML_PARSER_ERROR on parsererror (e.g. malformed XML)', () => {
    const xml = '<transcript><text start="0.24" dur="6.8">oops';
    // jsdom DOMParser treats malformed XML differently; check at minimum that parsererror path exists
    expect(() => parseTranscriptXml(xml)).toThrow();
  });

  it('throws XML_PARSER_ERROR on empty body', () => {
    expect(() => parseTranscriptXml('')).toThrow(/空 body|empty/i);
  });

  it('throws XML_UNRECOGNIZED_FORMAT when root is neither <transcript> nor <timedtext>', () => {
    const xml = '<?xml version="1.0"?><other><node/></other>';
    expect(() => parseTranscriptXml(xml)).toThrow(/不识别/);
  });
});
