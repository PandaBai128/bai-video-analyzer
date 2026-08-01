/**
 * YouTube 字幕抓取：在 YouTube 视频页 content script 中跑。
 *
 * 当前主路不再请求 InnerTube `/youtubei/v1/player`。原因是这条链路在真实浏览器里
 * 已经频繁被 LOGIN_REQUIRED 和反爬策略卡住，而用户当前页面明明已经拿到了字幕信息。
 *
 * 新主路：
 *   1) 从当前页面 HTML / 播放器状态里抽 `captionTracks.baseUrl`；
 *   2) 直接拉取字幕文件（XML 或 json3）并解析；
 *   3) 如果页面没有暴露 track，再读取/打开“转录文本 / Transcript”面板 DOM。
 *
 * 这条路径复用当前 Chrome 页面的登录态和 YouTube 前端能力，和 Web Clipper 类工具的
 * 成功条件更接近。失败时抛 `YouTubeTranscriptError`，由调用方映射到 UI 文案。
 */

import {
  parseTranscriptXml,
  sortCaptionTracks,
  YouTubeTranscriptXmlParseError,
} from '@core/adapters/youtube-player-response';
import { DEFAULT_SUBTITLE_LANGUAGES } from '@core/subtitles/language-preference';
import { extractYouTubeCaptionTracks } from '@core/adapters/youtube';
import type { SubtitleCue } from '@core/types';
import { extractYouTubeVideoId, normalizeYouTubePageTitle } from '@shared/page-context';
import {
  YOUTUBE_TRANSCRIPT_CACHE_TTL_MS,
  type YouTubePageCaptionTrack,
  type YouTubeTranscriptAttempt,
  type YouTubeTranscriptError,
  type YouTubeTranscriptErrorCode,
  type YouTubeTranscriptResult,
} from '@shared/youtube-transcript';

export { YOUTUBE_TRANSCRIPT_CACHE_TTL_MS };
export type {
  YouTubeTranscriptAttempt,
  YouTubeTranscriptError,
  YouTubeTranscriptErrorCode,
  YouTubeTranscriptResult,
};

interface FetchOptions {
  /** 字幕语言优先级，同时用于轨道选择和页面内短期缓存 key。 */
  readonly languages?: readonly string[];
  /** 自定义 fetch 注入（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 强制跳过缓存。 */
  readonly bypassCache?: boolean;
  /** 打开/等待转录文本面板的最长时间，测试可调。 */
  readonly transcriptOpenTimeoutMs?: number;
}

interface CacheEntry {
  readonly result: YouTubeTranscriptResult;
  readonly expireAt: number;
}

interface DomTranscriptSegment {
  readonly start: number;
  readonly text: string;
}

interface PageCaptionTrack {
  readonly baseUrl: string;
  readonly languageCode: string;
  readonly kind: 'asr' | 'official';
  readonly label: string;
  readonly name: string | null;
  readonly vssId: string | null;
}

interface PageCaptionOutcome {
  readonly result: YouTubeTranscriptResult | null;
  readonly timings: readonly YouTubeTranscriptAttempt[];
}

interface YouTubePlayerElement extends HTMLElement {
  readonly getVideoData?: () => {
    readonly video_id?: unknown;
    readonly videoId?: unknown;
  };
  readonly getPlayerResponse?: () => {
    readonly videoDetails?: {
      readonly videoId?: unknown;
    };
  };
}

const DEFAULT_LANGUAGES = DEFAULT_SUBTITLE_LANGUAGES;
const TRANSCRIPT_OPEN_TIMEOUT_MS = 4_500;
const TRANSCRIPT_POLL_INTERVAL_MS = 120;
const PAGE_HTML_FETCH_TIMEOUT_MS = 3_000;

const TRANSCRIPT_SEGMENT_SELECTORS = [
  'ytd-transcript-segment-renderer',
  'yt-transcript-segment-renderer',
  'ytd-transcript-body-renderer [data-start-time]',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] [data-start-time]',
];

const TRANSCRIPT_TEXT_SELECTORS = [
  'yt-formatted-string.segment-text',
  '.segment-text',
  '#segment-text',
  '[class*="segment-text"]',
  '[id*="content-text"]',
];

const TRANSCRIPT_TIMESTAMP_SELECTORS = [
  '.segment-timestamp',
  '#timestamp',
  '[class*="segment-timestamp"]',
  '[class*="timestamp"]',
  '[data-start-time]',
];

const TRANSCRIPT_TRIGGER_SELECTORS = [
  'button',
  '[role="button"]',
  'tp-yt-paper-button',
  'ytd-button-renderer',
  'yt-button-shape button',
].join(',');

const DESCRIPTION_EXPAND_SELECTORS = [
  'tp-yt-paper-button#expand',
  '#description-inline-expander #expand',
  'ytd-text-inline-expander #expand',
  'button',
  '[role="button"]',
  'tp-yt-paper-button',
].join(',');

const TRANSCRIPT_TRIGGER_TERMS = [
  'show transcript',
  'open transcript',
  'transcript',
  '显示转录文本',
  '显示文字记录',
  '转录文本',
  '文字记录',
  '轉錄文字',
  '顯示轉錄文字',
  '转写文稿',
  '轉寫文稿',
  '转写稿',
  '轉寫稿',
  '字幕稿',
  '文字稿',
];

const DESCRIPTION_EXPAND_TERMS = [
  'show more',
  '...more',
  '更多',
  '展开',
  '展開',
  '顯示更多',
  '查看更多',
];

const TRANSCRIPT_CLOSE_TERMS = [
  'close transcript',
  '关闭转写文稿',
  '关闭转录文本',
  '关闭文字记录',
  '關閉轉寫文稿',
  '關閉轉錄文字',
];

const DESCRIPTION_EXPAND_BLOCK_TERMS = ['more actions', '更多操作', '其他操作'];

const cache = new Map<string, CacheEntry>();

/**
 * 拿当前 YouTube 视频页 videoId；非 YouTube 视频页返回 null。
 */
export function getCurrentYouTubeVideoId(href: string = location.href): string | null {
  const url = parseUrl(href);
  if (!url || !isYouTubeHost(url.hostname)) {
    return null;
  }

  const urlVideoId = extractYouTubeVideoId(url);
  if (urlVideoId) {
    return urlVideoId;
  }

  return (
    readActiveYouTubePlayerVideoId() ??
    readYouTubeCanonicalVideoId() ??
    readYouTubeWatchFlexyVideoId()
  );
}

function parseUrl(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

function isYouTubeHost(hostname: string): boolean {
  return (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtu.be' ||
    hostname.endsWith('.youtu.be')
  );
}

function readActiveYouTubePlayerVideoId(): string | null {
  const player = document.querySelector<YouTubePlayerElement>('#movie_player');
  try {
    const videoData = player?.getVideoData?.();
    const videoDataId = normalizeYouTubeVideoId(videoData?.video_id);
    if (videoDataId) {
      return videoDataId;
    }

    const camelVideoDataId = normalizeYouTubeVideoId(videoData?.videoId);
    if (camelVideoDataId) {
      return camelVideoDataId;
    }

    const playerResponse = player?.getPlayerResponse?.();
    return normalizeYouTubeVideoId(playerResponse?.videoDetails?.videoId);
  } catch {
    return null;
  }
}

function readYouTubeCanonicalVideoId(): string | null {
  const candidates = [
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content,
    document.querySelector<HTMLMetaElement>('meta[itemprop="videoId"]')?.content,
  ];

  for (const candidate of candidates) {
    const plainVideoId = normalizeYouTubeVideoId(candidate);
    if (plainVideoId) {
      return plainVideoId;
    }

    const url = candidate ? parseUrl(candidate) : null;
    const parsedVideoId = url ? extractYouTubeVideoId(url) : undefined;
    if (parsedVideoId) {
      return parsedVideoId;
    }
  }

  return null;
}

function readYouTubeWatchFlexyVideoId(): string | null {
  return normalizeYouTubeVideoId(
    document.querySelector('ytd-watch-flexy[video-id]')?.getAttribute('video-id'),
  );
}

function normalizeYouTubeVideoId(value: unknown): string | null {
  return typeof value === 'string' && /^[\w-]{11}$/.test(value) ? value : null;
}

/**
 * 主入口：抓取当前 YouTube 视频的字幕。
 * 失败抛 `YouTubeTranscriptError`。
 */
export async function fetchYouTubeTranscriptInPageContext(
  input: {
    readonly videoId: string;
    readonly languages?: readonly string[];
    readonly pageCaptionTracks?: readonly YouTubePageCaptionTrack[];
  },
  options: FetchOptions = {},
): Promise<YouTubeTranscriptResult> {
  const videoId = input.videoId;
  if (!/^[\w-]{11}$/.test(videoId)) {
    throw transcriptError('NO_VIDEO_ID', '当前页面没有可识别的 YouTube videoId', 'extract_video_id');
  }

  const languages = input.languages ?? options.languages ?? DEFAULT_LANGUAGES;
  const cacheKey = buildCacheKey(videoId, languages);
  if (!options.bypassCache) {
    const hit = readCache(cacheKey);
    if (hit) {
      return { ...hit, cached: true, timings: [{ stage: 'cache', durationMs: 0 }] };
    }
  }

  const timings: YouTubeTranscriptAttempt[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageCaptionOutcome = await tryReadPageCaptionTrackTranscript({
    videoId,
    languages,
    fetchImpl,
    providedTracks: input.pageCaptionTracks ?? [],
  });
  timings.push(...pageCaptionOutcome.timings);
  if (pageCaptionOutcome.result) {
    writeCache(cacheKey, {
      result: pageCaptionOutcome.result,
      expireAt: Date.now() + YOUTUBE_TRANSCRIPT_CACHE_TTL_MS,
    });
    return pageCaptionOutcome.result;
  }

  const domStartedAt = Date.now();
  const segments = await readTranscriptSegmentsFromPage(
    options.transcriptOpenTimeoutMs ?? TRANSCRIPT_OPEN_TIMEOUT_MS,
  );

  if (segments.length === 0) {
    timings.push({
      stage: 'dom_panel',
      durationMs: Date.now() - domStartedAt,
      error: 'NO_CAPTION_TRACKS',
    });
    throw transcriptError(
      'NO_CAPTION_TRACKS',
      '没有在当前 YouTube 页面找到可读取的字幕轨或转录文本。请确认视频有字幕；如果播放器能显示字幕但仍失败，请刷新 YouTube 页面后重试。',
      'dom_panel',
    );
  }

  timings.push({
    stage: 'dom_panel',
    durationMs: Date.now() - domStartedAt,
    cueCount: segments.length,
  });

  const parseStartedAt = Date.now();
  const cues = buildCuesFromDomSegments(segments);
  if (cues.length === 0) {
    timings.push({
      stage: 'parse_dom',
      durationMs: Date.now() - parseStartedAt,
      error: 'NO_CUES',
    });
    throw transcriptError('NO_CUES', '转录文本面板存在，但没有解析到有效字幕内容', 'parse_dom');
  }
  timings.push({
    stage: 'parse_dom',
    durationMs: Date.now() - parseStartedAt,
    cueCount: cues.length,
  });

  const result: YouTubeTranscriptResult = {
    videoId,
    metadata: readYouTubeDomMetadata(),
    track: {
      language: 'unknown',
      label: 'YouTube 转录文本',
      source: 'official',
      isAutoGenerated: false,
    },
    availableTrackCount: 1,
    cues,
    cached: false,
    timings,
  };

  writeCache(cacheKey, { result, expireAt: Date.now() + YOUTUBE_TRANSCRIPT_CACHE_TTL_MS });
  return result;
}

export function clearYouTubeTranscriptCache(): void {
  cache.clear();
}

/* ---------- page captionTracks path ---------- */

async function tryReadPageCaptionTrackTranscript(input: {
  readonly videoId: string;
  readonly languages: readonly string[];
  readonly fetchImpl: typeof fetch;
  readonly providedTracks: readonly YouTubePageCaptionTrack[];
}): Promise<PageCaptionOutcome> {
  const timings: YouTubeTranscriptAttempt[] = [];
  const tracksStartedAt = Date.now();
  let tracks: readonly PageCaptionTrack[] = [];

  try {
    tracks = await readPageCaptionTracks(input.videoId, input.fetchImpl, input.providedTracks);
  } catch {
    timings.push({
      stage: 'caption_tracks',
      durationMs: Date.now() - tracksStartedAt,
      error: 'NETWORK_ERROR',
    });
    return { result: null, timings };
  }

  timings.push({
    stage: 'caption_tracks',
    durationMs: Date.now() - tracksStartedAt,
    cueCount: tracks.length,
    ...(tracks.length === 0 ? { error: 'NO_CAPTION_TRACKS' } : {}),
  });

  if (tracks.length === 0) {
    return { result: null, timings };
  }

  const sortedTracks = sortCaptionTracks(tracks, input.languages);
  for (const track of sortedTracks.slice(0, 4)) {
    const fetchStartedAt = Date.now();
    const fetched = await fetchCaptionTrackCues(track, input.fetchImpl);
    timings.push({
      stage: 'caption_fetch',
      language: track.languageCode,
      source: track.kind,
      durationMs: Date.now() - fetchStartedAt,
      ...(fetched.ok
        ? { cueCount: fetched.cues.length }
        : { error: fetched.error, ...(typeof fetched.status === 'number' ? { status: fetched.status } : {}) }),
    });

    if (!fetched.ok) {
      continue;
    }

    const parseStartedAt = Date.now();
    timings.push({
      stage: 'parse_caption',
      language: track.languageCode,
      source: track.kind,
      durationMs: Date.now() - parseStartedAt,
      cueCount: fetched.cues.length,
    });

    const result: YouTubeTranscriptResult = {
      videoId: input.videoId,
      metadata: readYouTubeDomMetadata(),
      track: {
        language: track.languageCode,
        label: track.label,
        source: track.kind,
        isAutoGenerated: track.kind === 'asr',
      },
      availableTrackCount: tracks.length,
      cues: fetched.cues,
      cached: false,
      timings,
    };
    return { result, timings };
  }

  return { result: null, timings };
}

async function readPageCaptionTracks(
  videoId: string,
  fetchImpl: typeof fetch,
  providedTracks: readonly YouTubePageCaptionTrack[],
): Promise<readonly PageCaptionTrack[]> {
  const fromBackgroundMainWorld = normalizePageCaptionTracks(providedTracks, videoId);
  if (fromBackgroundMainWorld.length > 0) {
    return fromBackgroundMainWorld;
  }

  const fromCurrentDocument = normalizePageCaptionTracks(
    extractYouTubeCaptionTracks(document.documentElement.innerHTML),
    videoId,
  );
  if (fromCurrentDocument.length > 0) {
    return fromCurrentDocument;
  }

  if (isJsdomEnvironment()) {
    return [];
  }

  const watchHtml = await fetchCurrentWatchHtml(videoId, fetchImpl);
  return normalizePageCaptionTracks(extractYouTubeCaptionTracks(watchHtml), videoId);
}

async function fetchCurrentWatchHtml(videoId: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), PAGE_HTML_FETCH_TIMEOUT_MS)
    : null;

  try {
    const response = await fetchImpl(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      method: 'GET',
      credentials: 'include',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      return '';
    }
    return response.text();
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function normalizePageCaptionTracks(
  rawTracks: readonly unknown[],
  expectedVideoId: string,
): readonly PageCaptionTrack[] {
  return rawTracks
    .map((track) => {
      const record = (track ?? {}) as Record<string, unknown>;
      const baseUrl = readString(record.baseUrl);
      if (!baseUrl || !captionTrackMatchesVideoId(baseUrl, expectedVideoId)) {
        return null;
      }
      const languageCode = readString(record.languageCode) ?? 'unknown';
      const kind: PageCaptionTrack['kind'] = readString(record.kind) === 'asr' ? 'asr' : 'official';
      const name = readTrackName(record.name);
      const label = name ?? languageCode;
      return {
        baseUrl,
        languageCode,
        kind,
        label: kind === 'asr' && !label.includes('自动') ? `${label}（自动生成）` : label,
        name,
        vssId: readString(record.vssId),
      } satisfies PageCaptionTrack;
    })
    .filter((track): track is PageCaptionTrack => track !== null);
}

function captionTrackMatchesVideoId(baseUrl: string, expectedVideoId: string): boolean {
  try {
    const trackVideoId = new URL(baseUrl).searchParams.get('v');
    return trackVideoId === expectedVideoId;
  } catch {
    return false;
  }
}

async function fetchCaptionTrackCues(
  track: PageCaptionTrack,
  fetchImpl: typeof fetch,
): Promise<
  | { readonly ok: true; readonly cues: readonly SubtitleCue[] }
  | { readonly ok: false; readonly error: string; readonly status?: number }
> {
  const urls = buildCaptionFetchUrls(track.baseUrl);
  let lastError: { readonly error: string; readonly status?: number } = { error: 'NO_CUES' };

  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        lastError = { error: 'TIMEDTEXT_BAD_STATUS', status: response.status };
        continue;
      }

      const text = (await response.text()).trim();
      if (!text) {
        lastError = { error: 'TIMEDTEXT_EMPTY_BODY', status: response.status };
        continue;
      }

      const cues = parseCaptionResponseText(text);
      if (cues.length > 0) {
        return { ok: true, cues };
      }
      lastError = { error: 'NO_CUES', status: response.status };
    } catch (error) {
      lastError = { error: error instanceof YouTubeTranscriptXmlParseError ? error.code : 'NETWORK_ERROR' };
    }
  }

  return { ok: false, ...lastError };
}

function buildCaptionFetchUrls(baseUrl: string): readonly string[] {
  const urls = [baseUrl];
  try {
    const jsonUrl = new URL(baseUrl);
    jsonUrl.searchParams.set('fmt', 'json3');
    const jsonUrlText = jsonUrl.toString();
    if (jsonUrlText !== baseUrl) {
      urls.push(jsonUrlText);
    }
  } catch {
    // baseUrl 理论上是完整 URL；异常时只试原始 URL。
  }
  return urls;
}

function parseCaptionResponseText(text: string): readonly SubtitleCue[] {
  const first = text.trimStart()[0];
  if (first === '{' || first === '[') {
    return parseJson3Caption(text);
  }

  try {
    return parseTranscriptXml(text);
  } catch (xmlError) {
    try {
      return parseJson3Caption(text);
    } catch {
      throw xmlError;
    }
  }
}

function parseJson3Caption(text: string): readonly SubtitleCue[] {
  const data = JSON.parse(text) as {
    readonly events?: Array<{
      readonly tStartMs?: number;
      readonly dDurationMs?: number;
      readonly segs?: Array<{ readonly utf8?: string }>;
    }>;
  };
  const cues =
    data.events
      ?.map((event) => {
        const cueText = event.segs?.map((seg) => seg.utf8 ?? '').join('').replace(/\s+/g, ' ').trim() ?? '';
        const start = typeof event.tStartMs === 'number' ? event.tStartMs / 1000 : 0;
        const duration = typeof event.dDurationMs === 'number' ? event.dDurationMs / 1000 : 0;
        if (!cueText || !Number.isFinite(start)) {
          return null;
        }
        const baseCue: SubtitleCue = { start, text: cueText };
        return duration > 0 ? { ...baseCue, end: start + duration } : baseCue;
      })
      .filter((cue): cue is SubtitleCue => cue !== null) ?? [];

  return cues;
}

/* ---------- DOM transcript path ---------- */

async function readTranscriptSegmentsFromPage(timeoutMs: number): Promise<readonly DomTranscriptSegment[]> {
  const existing = readTranscriptSegmentsFromDom();
  if (existing.length > 0) {
    return existing;
  }

  clickTranscriptTrigger();
  const directSegments = await waitForTranscriptSegments(Math.min(timeoutMs, 1_200));
  if (directSegments.length > 0) {
    return directSegments;
  }

  clickDescriptionExpander();
  clickTranscriptTrigger();
  return waitForTranscriptSegments(timeoutMs);
}

async function waitForTranscriptSegments(timeoutMs: number): Promise<readonly DomTranscriptSegment[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const segments = readTranscriptSegmentsFromDom();
    if (segments.length > 0) {
      return segments;
    }
    await delay(TRANSCRIPT_POLL_INTERVAL_MS);
  }
  return readTranscriptSegmentsFromDom();
}

function readTranscriptSegmentsFromDom(): readonly DomTranscriptSegment[] {
  const nodes = uniqueElements(
    TRANSCRIPT_SEGMENT_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))),
  );

  const segments = nodes
    .map(readTranscriptSegment)
    .filter((segment): segment is DomTranscriptSegment => segment !== null);

  return dedupeAndSortSegments(segments);
}

function readTranscriptSegment(node: Element): DomTranscriptSegment | null {
  const timestampText = readTimestampText(node);
  const start = parseTimestampToSeconds(timestampText);
  if (start === null) {
    return null;
  }

  const text = readSegmentText(node, timestampText);
  if (!text) {
    return null;
  }

  return { start, text };
}

function readTimestampText(node: Element): string | null {
  const byData = node.getAttribute('data-start-time');
  if (byData && Number.isFinite(Number(byData))) {
    return secondsToTimestamp(Number(byData));
  }

  const explicit = readFirstText(node, TRANSCRIPT_TIMESTAMP_SELECTORS);
  if (explicit) {
    const extracted = extractTimestamp(explicit);
    if (extracted) {
      return extracted;
    }
  }

  return extractTimestamp(node.textContent ?? '');
}

function readSegmentText(node: Element, timestampText: string | null): string | null {
  const explicit = readFirstText(node, TRANSCRIPT_TEXT_SELECTORS);
  if (explicit) {
    return explicit;
  }

  let text = cleanText(node.textContent);
  if (!text) {
    return null;
  }
  if (timestampText) {
    text = cleanText(text.replace(timestampText, ''));
  }
  return text;
}

function clickTranscriptTrigger(): boolean {
  return clickFirstMatchingElement(TRANSCRIPT_TRIGGER_SELECTORS, TRANSCRIPT_TRIGGER_TERMS, {
    blockTerms: ['transcript unavailable', 'no transcript', ...TRANSCRIPT_CLOSE_TERMS],
  });
}

function clickDescriptionExpander(): boolean {
  return clickFirstMatchingElement(DESCRIPTION_EXPAND_SELECTORS, DESCRIPTION_EXPAND_TERMS, {
    blockTerms: DESCRIPTION_EXPAND_BLOCK_TERMS,
  });
}

function clickFirstMatchingElement(
  selector: string,
  terms: readonly string[],
  options: { readonly blockTerms?: readonly string[] } = {},
): boolean {
  const elements = Array.from(document.querySelectorAll(selector));
  const candidates: Array<{ readonly target: HTMLElement; readonly priority: number }> = [];
  for (const element of elements) {
    const label = getElementLabel(element);
    if (!matchesAnyTerm(label, terms)) {
      continue;
    }
    if (options.blockTerms && matchesAnyTerm(label, options.blockTerms)) {
      continue;
    }

    const target = findClickableElement(element);
    if (!target || !isElementUsable(target)) {
      continue;
    }

    candidates.push({ target, priority: getElementClickPriority(target) });
  }
  const candidate = candidates.sort((left, right) => left.priority - right.priority)[0];
  if (!candidate) {
    return false;
  }

  candidate.target.click();
  return true;
}

function findClickableElement(element: Element): HTMLElement | null {
  const nested = element.querySelector('button,[role="button"],tp-yt-paper-button,a');
  if (nested instanceof HTMLElement) {
    return nested;
  }

  if (element instanceof HTMLElement && isClickableElement(element)) {
    return element;
  }

  const closest = element.closest('button,[role="button"],tp-yt-paper-button,ytd-button-renderer,a');
  return closest instanceof HTMLElement ? closest : null;
}

function isClickableElement(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === 'button' ||
    tagName === 'a' ||
    tagName === 'tp-yt-paper-button' ||
    tagName === 'ytd-button-renderer' ||
    element.getAttribute('role') === 'button'
  );
}

function isElementUsable(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
    return false;
  }
  if (element.closest('[hidden],[aria-hidden="true"]')) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    if (current === document.body) {
      break;
    }
  }

  return true;
}

function getElementClickPriority(element: HTMLElement): number {
  if (isJsdomEnvironment()) {
    return 0;
  }

  const rect = element.getBoundingClientRect();
  return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 ? 0 : 1;
}

function getElementLabel(element: Element): string {
  const html = element instanceof HTMLElement ? element : null;
  return normalizeForMatch(
    [
      element.textContent,
      html?.getAttribute('aria-label'),
      html?.getAttribute('title'),
      html?.getAttribute('data-title-no-tooltip'),
    ]
      .filter((part): part is string => typeof part === 'string')
      .join(' '),
  );
}

function matchesAnyTerm(label: string, terms: readonly string[]): boolean {
  return terms.some((term) => label.includes(normalizeForMatch(term)));
}

function readFirstText(node: Element, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const target = node.matches(selector) ? node : node.querySelector(selector);
    const text = cleanText(target?.textContent);
    if (text) {
      return text;
    }
  }
  return null;
}

function extractTimestamp(value: string): string | null {
  const match = value.match(/\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/);
  return match?.[0] ?? null;
}

function parseTimestampToSeconds(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const timestamp = extractTimestamp(value);
  if (!timestamp) {
    return null;
  }

  const parts = timestamp.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (minutes === undefined || seconds === undefined) {
      return null;
    }
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (hours === undefined || minutes === undefined || seconds === undefined) {
      return null;
    }
    return hours * 3_600 + minutes * 60 + seconds;
  }
  return null;
}

function secondsToTimestamp(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function buildCuesFromDomSegments(segments: readonly DomTranscriptSegment[]): readonly SubtitleCue[] {
  return segments.map((segment, index) => {
    const nextStart = segments[index + 1]?.start;
    const baseCue = { start: segment.start, text: segment.text };
    return typeof nextStart === 'number' && nextStart > segment.start
      ? { ...baseCue, end: nextStart }
      : baseCue;
  });
}

function dedupeAndSortSegments(
  segments: readonly DomTranscriptSegment[],
): readonly DomTranscriptSegment[] {
  const sorted = [...segments].sort((left, right) => left.start - right.start);
  const seen = new Set<string>();
  const unique: DomTranscriptSegment[] = [];
  for (const segment of sorted) {
    const key = `${segment.start.toFixed(3)}::${segment.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(segment);
  }
  return unique;
}

function readYouTubeDomMetadata(): YouTubeTranscriptResult['metadata'] {
  const title =
    readFirstDocumentText([
      'h1.ytd-watch-metadata yt-formatted-string',
      'ytd-watch-metadata h1 yt-formatted-string',
      'h1.title yt-formatted-string',
      'h1',
    ]) ?? cleanTitleFromDocument();

  const author = readFirstDocumentText([
    '#owner #channel-name a',
    'ytd-video-owner-renderer #channel-name a',
    'ytd-watch-metadata ytd-channel-name a',
    '#channel-name a',
  ]);

  return {
    title,
    author,
    lengthSeconds: readVideoLengthSeconds(),
  };
}

function readFirstDocumentText(selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const text = cleanText(document.querySelector(selector)?.textContent);
    if (text) {
      return text;
    }
  }
  return null;
}

function cleanTitleFromDocument(): string | null {
  const title = cleanText(normalizeYouTubePageTitle(document.title));
  if (!title) {
    return null;
  }
  return title;
}

function readVideoLengthSeconds(): number | null {
  const videos = Array.from(document.querySelectorAll('video'));
  const video = videos.find((candidate) => {
    const duration = candidate.duration;
    return Number.isFinite(duration) && duration > 0;
  });
  return video ? Math.round(video.duration) : null;
}

/* ---------- cache / errors / utilities ---------- */

function buildCacheKey(videoId: string, languages: readonly string[]): string {
  return `${videoId}::${languages.join(',')}`;
}

function readCache(key: string): YouTubeTranscriptResult | null {
  const hit = cache.get(key);
  if (!hit) {
    return null;
  }
  if (hit.expireAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

function writeCache(key: string, entry: CacheEntry): void {
  cache.set(key, entry);
}

function transcriptError(
  code: YouTubeTranscriptErrorCode,
  message: string,
  stage: YouTubeTranscriptError['stage'],
): YouTubeTranscriptError {
  return { code, message, stage };
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim() ?? '';
  return cleaned.length > 0 ? cleaned : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readTrackName(name: unknown): string | null {
  if (!name || typeof name !== 'object') {
    return null;
  }
  const record = name as Record<string, unknown>;
  if (Array.isArray(record.runs)) {
    const text = record.runs
      .map((run) => (run && typeof run === 'object' ? readString((run as Record<string, unknown>).text) : null))
      .filter((part): part is string => Boolean(part))
      .join('');
    return cleanText(text);
  }
  return cleanText(readString(record.simpleText));
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function uniqueElements(elements: readonly Element[]): readonly Element[] {
  return Array.from(new Set(elements));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isJsdomEnvironment(): boolean {
  return navigator.userAgent.toLowerCase().includes('jsdom');
}
