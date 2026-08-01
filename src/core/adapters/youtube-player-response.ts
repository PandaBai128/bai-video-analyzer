/**
 * YouTube innerTube player response 解析 + timedtext XML 解析 + 字幕轨道排序。
 *
 * 设计原则：
 * - 纯逻辑，不依赖 `chrome.*`，单测可直接覆盖。
 * - DOM XML 解析用全局 `DOMParser`（content script 和 jsdom 都提供）；失败或缺失时抛错。
 * - 字幕轨道沿用共享语言偏好排序，保持与其他视频平台一致的选择语义。
 *
 * 实现约束：
 * - innerTube 用 ANDROID client（clientName=ANDROID, clientVersion=20.10.38）才能拿到不带 exp=xpe 的 captionTracks。
 * - timedtext 不要加 fmt=json3，否则会被 sparses 签名拒绝返回空 body。
 * - XML 同时支持格式 A（`<transcript><text start dur>`）和格式 B（`<timedtext><body><p t d><s>`）。
 */

import type { SubtitleCue } from '@core/types';
import {
  DEFAULT_SUBTITLE_LANGUAGES,
  sortSubtitleTracks,
} from '@core/subtitles/language-preference';

/* ---------- innerTube 响应解析 ---------- */

export interface ParsedYouTubePlayerResponse {
  readonly videoId: string;
  readonly metadata: {
    readonly title: string | null;
    readonly author: string | null;
    readonly lengthSeconds: number | null;
  };
  readonly captionTracks: readonly RawCaptionTrack[];
  /** innerTube playabilityStatus 字段；OK 时为 'OK'。 */
  readonly playabilityStatus: string | null;
  readonly playabilityReason: string | null;
}

export interface RawCaptionTrack {
  readonly baseUrl: string;
  readonly languageCode: string;
  /** 人工字幕: undefined / 'manual' / 'asr' 之外的值；自动字幕: 'asr' */
  readonly kind: 'asr' | 'official';
  readonly name: string | null;
  /** ASR 自动生成标签，例如 "(自动生成)" */
  readonly label: string;
  readonly vssId: string | null;
}

export type ParsePlayerResponseErrorCode =
  | 'INVALID_VIDEO_ID'
  | 'NO_VIDEO_ID_IN_RESPONSE'
  | 'NO_PLAYABILITY'
  | 'NO_CAPTION_TRACKS'
  | 'UNPLAYABLE'
  | 'PLAYER_UNPLAYABLE';

/**
 * 真正的 `Error` 子类。`parseInnertubePlayerResponse()` 在解析失败时抛这个，
 * 而不是普通对象 —— 这样 `error.message` 不会变成 `[object Object]`。
 * 携带 `code` 字段便于上层分类（业务错误 vs 传输错误）。
 */
export class YouTubePlayerResponseParseError extends Error {
  constructor(
    message: string,
    readonly code: ParsePlayerResponseErrorCode,
  ) {
    super(message);
    this.name = 'YouTubePlayerResponseParseError';
  }
}

/**
 * 解析 innerTube `youtubei/v1/player` 响应。
 * 失败时抛 `ParsePlayerResponseError`（含 `code` 用于 UI 分类）。
 */
export function parseInnertubePlayerResponse(
  response: unknown,
  expectedVideoId: string,
): ParsedYouTubePlayerResponse {
  if (!response || typeof response !== 'object') {
    throw playerError('NO_PLAYABILITY', 'innerTube 响应为空或格式异常');
  }

  const root = response as Record<string, unknown>;
  const playability = (root.playabilityStatus ?? {}) as Record<string, unknown>;
  const playabilityStatus = readString(playability.status);
  const playabilityReason = readString(playability.reason);

  if (playabilityStatus && playabilityStatus !== 'OK') {
    throw playerError(
      'UNPLAYABLE',
      `innerTube 拒绝：${playabilityStatus}${playabilityReason ? `（${playabilityReason}）` : ''}。这通常是 YouTube 反爬或视频不可用。`,
    );
  }

  const videoDetails = (root.videoDetails ?? {}) as Record<string, unknown>;
  const videoId = readString(videoDetails.videoId);

  if (!videoId) {
    throw playerError('NO_VIDEO_ID_IN_RESPONSE', 'innerTube 响应里没有 videoId');
  }

  if (videoId !== expectedVideoId) {
    throw playerError(
      'INVALID_VIDEO_ID',
      `innerTube 响应的 videoId(${videoId}) 与当前页面不一致(${expectedVideoId})，拒绝使用`,
    );
  }

  const captions = root.captions as Record<string, unknown> | undefined;
  const captionList = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const rawCaptionTracks = (captionList?.captionTracks ?? []) as unknown;

  if (!Array.isArray(rawCaptionTracks) || rawCaptionTracks.length === 0) {
    throw playerError(
      'NO_CAPTION_TRACKS',
      '该视频没有可用的字幕轨（可能作者未上传也未开启自动字幕）',
    );
  }

  const captionTracks: RawCaptionTrack[] = rawCaptionTracks.map((item) => normalizeCaptionTrack(item));

  const lengthSeconds = readNumber(videoDetails.lengthSeconds);

  return {
    videoId,
    metadata: {
      title: readString(videoDetails.title),
      author: readString(videoDetails.author),
      lengthSeconds,
    },
    captionTracks,
    playabilityStatus,
    playabilityReason,
  };
}

function normalizeCaptionTrack(item: unknown): RawCaptionTrack {
  const track = (item ?? {}) as Record<string, unknown>;
  const baseUrl = readString(track.baseUrl) ?? '';
  const languageCode = readString(track.languageCode) ?? 'unknown';
  const kindValue = readString(track.kind);
  const kind: RawCaptionTrack['kind'] = kindValue === 'asr' ? 'asr' : 'official';
  const nameText = readTrackName(track.name);
  const isAuto = kind === 'asr';
  const label = isAuto && !nameText?.includes('自动')
    ? `${nameText || languageCode}（自动生成）`
    : nameText || languageCode;

  return {
    baseUrl,
    languageCode,
    kind,
    name: nameText,
    label,
    vssId: readString(track.vssId),
  };
}

function readTrackName(name: unknown): string | null {
  if (!name || typeof name !== 'object') {
    return null;
  }
  const record = name as Record<string, unknown>;
  if (Array.isArray(record.runs)) {
    return record.runs
      .map((run) => (run && typeof run === 'object' ? readString((run as Record<string, unknown>).text) : null))
      .filter((text): text is string => Boolean(text))
      .join('') || null;
  }
  return readString(record.simpleText);
}

/* ---------- 字幕轨道排序 ---------- */

export interface SortableCaptionTrack {
  readonly languageCode: string;
  readonly kind: 'asr' | 'official';
}

/**
 * 按浏览器语言优先级排序字幕轨；同一语言内再按 official > unknown > ASR。
 * 这是 YouTube 页面轨道和 adapter 轨道共用的唯一排序入口，调用方不要二次重排。
 */
export function sortCaptionTracks<T extends SortableCaptionTrack>(
  tracks: readonly T[],
  languages: readonly string[] = DEFAULT_SUBTITLE_LANGUAGES,
): readonly T[] {
  return sortSubtitleTracks(
    tracks.map((track) => ({
      track,
      language: track.languageCode,
      source: track.kind === 'asr' ? ('asr' as const) : ('official' as const),
    })),
    languages,
  ).map((entry) => entry.track);
}

/* ---------- XML 解析 ---------- */

export type ParseTranscriptXmlErrorCode =
  | 'XML_PARSER_ERROR'
  | 'XML_UNRECOGNIZED_FORMAT'
  | 'NO_CUES';

/**
 * 真正的 `Error` 子类。`parseTranscriptXml()` 在解析失败时抛这个，
 * 携带 `code` 便于上层分类。`error.message` 不会变成 `[object Object]`。
 */
export class YouTubeTranscriptXmlParseError extends Error {
  constructor(
    message: string,
    readonly code: ParseTranscriptXmlErrorCode,
  ) {
    super(message);
    this.name = 'YouTubeTranscriptXmlParseError';
  }
}

/**
 * 解析 timedtext 的 XML 响应。两种格式：
 *   格式 A：`<transcript><text start="..." dur="...">text</text>...</transcript>`
 *   格式 B：`<timedtext format="3"><body><p t="..." d="..."><s>word</s>...</p></body></timedtext>`
 *
 * 需要全局 DOMParser。content script、浏览器、jsdom 都提供；如不可用抛 `XML_PARSER_ERROR`。
 */
export function parseTranscriptXml(xmlText: string): readonly SubtitleCue[] {
  if (typeof DOMParser === 'undefined') {
    throw xmlError('XML_PARSER_ERROR', '当前环境没有 DOMParser，无法解析 timedtext XML');
  }

  const trimmed = xmlText.trim();
  if (!trimmed) {
    throw xmlError('XML_PARSER_ERROR', 'timedtext 返回了空 body（可能被反爬/需要登录态/签名过期，刷新页面再试）');
  }

  const doc = new DOMParser().parseFromString(trimmed, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    const detail = (parseError.textContent ?? '').slice(0, 200);
    throw xmlError('XML_PARSER_ERROR', `字幕 XML 解析失败：${detail}`);
  }

  // 格式 A：<transcript><text start="..." dur="...">...</text>
  const textNodes = doc.querySelectorAll('transcript > text');
  if (textNodes.length > 0) {
    const cues: SubtitleCue[] = [];
    textNodes.forEach((node) => {
      const start = parseFloat(node.getAttribute('start') ?? '0');
      const dur = parseFloat(node.getAttribute('dur') ?? '0');
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text || !Number.isFinite(start)) {
        return;
      }
      const base: SubtitleCue = { start, text };
      cues.push(dur > 0 ? { ...base, end: start + dur } : base);
    });
    if (cues.length === 0) {
      throw xmlError('NO_CUES', '字幕 XML 中没有可识别的 text 节点');
    }
    return cues;
  }

  // 格式 B：<timedtext><body><p t="..." d="..."><s>...</s>...</p></body></timedtext>
  const pNodes = doc.querySelectorAll('timedtext > body > p');
  if (pNodes.length > 0) {
    const cues: SubtitleCue[] = [];
    pNodes.forEach((p) => {
      const t = parseInt(p.getAttribute('t') ?? '0', 10);
      const d = parseInt(p.getAttribute('d') ?? '0', 10);
      // 优先用 <s> 子节点 join；某些 YouTube timedtext 变体里 <p> 没有 <s> 包裹
      // （文字直接挂在 <p> 上），fallback 到 p.textContent。
      const sChildren = p.querySelectorAll('s');
      const text = (
        sChildren.length > 0
          ? Array.from(sChildren)
              .map((s) => s.textContent ?? '')
              .join('')
          : (p.textContent ?? '')
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || !Number.isFinite(t)) {
        return;
      }
      const start = t / 1000;
      const base: SubtitleCue = { start, text };
      cues.push(d > 0 ? { ...base, end: start + d / 1000 } : base);
    });
    if (cues.length === 0) {
      throw xmlError('NO_CUES', '字幕 XML 中没有可识别的 p 节点');
    }
    return cues;
  }

  throw xmlError('XML_UNRECOGNIZED_FORMAT', '字幕 XML 格式不识别（既不是 <transcript> 也不是 <timedtext>）');
}

/* ---------- helpers ---------- */

function playerError(
  code: ParsePlayerResponseErrorCode,
  message: string,
): YouTubePlayerResponseParseError {
  return new YouTubePlayerResponseParseError(message, code);
}

function xmlError(
  code: ParseTranscriptXmlErrorCode,
  message: string,
): YouTubeTranscriptXmlParseError {
  return new YouTubeTranscriptXmlParseError(message, code);
}

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}
