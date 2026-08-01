import type { VideoAdapter } from './base';
import type {
  Result,
  SubtitleCue,
  SubtitleTrack,
  VideoMetadata,
  VideoPlatformChapter,
} from '@core/types';
import {
  type MixKeyCache,
  type WbiCacheStore,
  type WbiNavResponse,
  WbiSigner,
} from '@core/bilibili';
import { sortSubtitleTracks } from '@core/subtitles/language-preference';

interface BilibiliViewResponse {
  readonly code: number;
  readonly message: string;
  readonly data?: {
    readonly bvid: string;
    readonly aid: number;
    readonly cid: number;
    readonly title: string;
    readonly desc?: string;
    readonly duration: number;
    readonly pic?: string;
    readonly pubdate?: number;
    readonly pages?: BilibiliPageInfo[];
    readonly owner?: {
      readonly name?: string;
      readonly mid?: number;
    };
  };
}

interface BilibiliPageInfo {
  readonly cid: number;
  readonly page: number;
  readonly part?: string;
  readonly duration?: number;
}

interface BilibiliSubtitleItem {
  readonly lan: string;
  readonly lan_doc: string;
  readonly subtitle_url: string;
  /** v2 / wbi 字段：当前接口观测到的来源排序信号，不能单独证明人工字幕。 */
  readonly ai_type?: number;
  /** wbi v2 字段：仅在缺少 ai_type 时作为保守回退信号。 */
  readonly type?: number;
  /** 是否需要大会员/登录，wbi v2 才有。 */
  readonly is_lock?: boolean;
}

interface BilibiliSubtitleResponse {
  readonly code: number;
  readonly message: string;
  readonly data?: {
    readonly subtitle?: {
      readonly subtitles?: BilibiliSubtitleItem[];
    };
    readonly view_points?: BilibiliViewPoint[];
  };
}

interface BilibiliViewPoint {
  readonly from?: number;
  readonly to?: number;
  readonly content?: string;
}

interface BilibiliSubtitleFile {
  readonly body?: Array<{
    readonly from: number;
    readonly to: number;
    readonly content: string;
  }>;
}

const BILIBILI_NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const BILIBILI_PLAYER_WBI_URL = 'https://api.bilibili.com/x/player/wbi/v2';
const BILIBILI_PLAYER_V2_URL = 'https://api.bilibili.com/x/player/v2';
const DEFAULT_WBI_CACHE_STORE = createMemoryWbiStore();

export class BilibiliAdapter implements VideoAdapter {
  readonly platform = 'bilibili' as const;

  private cookieHeader: string | null = null;
  private readonly wbiSigner: WbiSigner;
  private readonly clock: () => number;

  constructor(options: { clock?: () => number; cacheStore?: WbiCacheStore } = {}) {
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.wbiSigner = new WbiSigner({
      cacheStore: options.cacheStore ?? DEFAULT_WBI_CACHE_STORE,
      now: this.clock,
      fetchNav: () => this.fetchNavPayload(),
    });
  }

  setCookieHeader(header: string | null): void {
    this.cookieHeader = header && header.length > 0 ? header : null;
  }

  match(url: string): boolean {
    return this.extractVideoId(url) !== null;
  }

  extractVideoId(url: string): string | null {
    return url.match(/(?:bilibili\.com\/video\/|^)(BV[\w]+)/)?.[1] ?? null;
  }

  async fetchMetadata(videoIdOrUrl: string): Promise<Result<VideoMetadata>> {
    const bvid = this.extractVideoId(videoIdOrUrl) ?? videoIdOrUrl;
    const requestedPageNumber = extractPageNumber(videoIdOrUrl);

    if (!bvid.startsWith('BV')) {
      return {
        ok: false,
        error: { code: 'INVALID_URL', message: '无法识别 B 站 BV 号', retryable: false },
      };
    }

    try {
      const response = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        {
          headers: this.buildRequestHeaders(bvid),
          credentials: 'include',
        },
      );
      const data = (await response.json()) as BilibiliViewResponse;

      if (data.code !== 0 || !data.data) {
        return createBilibiliApiError(data.code, data.message, '视频信息接口');
      }

      const selectedPage = selectBilibiliPage(data.data.pages, requestedPageNumber);

      if (!selectedPage.ok) {
        return selectedPage;
      }

      const page = selectedPage.value;
      const pageTitle =
        page.part && page.part !== data.data.title
          ? `${data.data.title} - ${page.part}`
          : data.data.title;
      const platformChapters = await this.fetchViewPoints(data.data.bvid, page.cid);

      let metadata: VideoMetadata = {
        platform: this.platform,
        videoId: data.data.bvid,
        url: createBilibiliVideoUrl(data.data.bvid, page.page),
        title: pageTitle,
        author: data.data.owner?.name ?? '未知作者',
        duration: page.duration ?? data.data.duration,
        platformSpecific: {
          aid: data.data.aid,
          cid: page.cid,
          page: page.page,
          part: page.part,
          totalPages: data.data.pages?.length ?? 1,
          ownerMid: data.data.owner?.mid,
          ...(platformChapters.length ? { viewPoints: platformChapters } : {}),
        },
      };

      if (platformChapters.length) {
        metadata = { ...metadata, platformChapters };
      }

      if (data.data.pic) {
        metadata = { ...metadata, thumbnailUrl: data.data.pic };
      }

      if (data.data.pubdate) {
        metadata = { ...metadata, publishedAt: data.data.pubdate };
      }

      if (data.data.desc) {
        metadata = { ...metadata, description: data.data.desc };
      }

      return { ok: true, value: metadata };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: createBilibiliNetworkMessage('视频信息接口', error),
          retryable: true,
        },
      };
    }
  }

  private async fetchViewPoints(
    bvid: string,
    cid: number,
  ): Promise<readonly VideoPlatformChapter[]> {
    try {
      const query = new URLSearchParams({ bvid, cid: String(cid) });
      const response = await fetch(`${BILIBILI_PLAYER_WBI_URL}?${query.toString()}`, {
        headers: this.buildRequestHeaders(bvid),
        credentials: 'include',
      });
      const data = (await response.json()) as BilibiliSubtitleResponse;
      if (data.code !== 0) {
        return [];
      }
      return normalizeBilibiliViewPoints(data.data?.view_points ?? []);
    } catch {
      // 章节锚点是增强信息；拿不到时保留原 metadata 主链路。
      return [];
    }
  }

  async fetchSubtitleTracks(
    videoIdOrUrl: string,
    languages?: readonly string[],
  ): Promise<Result<readonly SubtitleTrack[]>> {
    const metadata = await this.fetchMetadata(videoIdOrUrl);

    if (!metadata.ok) {
      return metadata;
    }

    const cid = metadata.value.platformSpecific?.cid;

    if (typeof cid !== 'number') {
      return {
        ok: false,
        error: { code: 'API_ERROR', message: 'B 站 metadata 缺少 cid', retryable: true },
      };
    }

    const bvid = metadata.value.videoId;
    const headers = this.buildRequestHeaders(bvid);

    // 1) 优先走 WBI 签名接口，拿到完整 subtitle_url
    const wbi = await this.fetchSubtitleTracksViaWbi(bvid, cid, headers);
    if (wbi.ok) {
      return this.normalizeTracks(wbi.value, 'WBI 签名接口', languages);
    }

    // 2) 回退到老的 /x/player/v2
    try {
      const response = await fetch(
        `${BILIBILI_PLAYER_V2_URL}?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
        {
          headers,
          credentials: 'include',
        },
      );
      const data = (await response.json()) as BilibiliSubtitleResponse;

      if (data.code !== 0) {
        return createBilibiliApiError(data.code, data.message, '字幕接口');
      }

      return this.normalizeTracks(data.data?.subtitle?.subtitles ?? [], '老 v2 接口', languages);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: createBilibiliNetworkMessage('字幕接口', error),
          retryable: true,
        },
      };
    }
  }

  async fetchSubtitleCues(track: SubtitleTrack): Promise<Result<readonly SubtitleCue[]>> {
    try {
      const response = await fetch(track.url, {
        headers: this.buildRequestHeaders(),
      });
      const data = (await response.json()) as BilibiliSubtitleFile;
      const cues =
        data.body?.map((item) => ({
          start: item.from,
          end: item.to,
          text: item.content,
        })) ?? [];

      return { ok: true, value: cues };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'PARSE_ERROR',
          message: createBilibiliNetworkMessage('字幕文件', error),
          retryable: true,
        },
      };
    }
  }

  getTimestampUrl(videoId: string, seconds: number): string {
    return `https://www.bilibili.com/video/${videoId}/?t=${Math.max(0, Math.floor(seconds))}`;
  }

  private async fetchSubtitleTracksViaWbi(
    bvid: string,
    cid: number,
    headers: Record<string, string>,
  ): Promise<Result<readonly BilibiliSubtitleItem[]>> {
    try {
      const signed = await this.wbiSigner.sign({ bvid, cid });
      const query = new URLSearchParams();

      for (const [key, value] of Object.entries(signed)) {
        query.set(key, String(value));
      }

      const response = await fetch(`${BILIBILI_PLAYER_WBI_URL}?${query.toString()}`, {
        headers,
        credentials: 'include',
      });
      const data = (await response.json()) as BilibiliSubtitleResponse;

      if (data.code !== 0) {
        return createBilibiliApiError(data.code, data.message, 'WBI 字幕接口');
      }

      const items = data.data?.subtitle?.subtitles ?? [];
      const withUrl = items.filter((item) => item.subtitle_url);

      if (items.length > 0 && withUrl.length === 0) {
        // 服务端没给完整 url，需要登录态
        return {
          ok: false,
          error: {
            code: 'API_ERROR',
            message: 'WBI 接口返回了字幕但没给 url，通常是没拿到登录态。',
            retryable: true,
          },
        };
      }

      return { ok: true, value: withUrl };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: createBilibiliNetworkMessage('WBI 字幕接口', error),
          retryable: true,
        },
      };
    }
  }

  private async fetchNavPayload(): Promise<WbiNavResponse> {
    const headers = this.buildRequestHeaders();

    if (this.cookieHeader) {
      headers.Cookie = this.cookieHeader;
    }

    const response = await fetch(BILIBILI_NAV_URL, {
      headers,
      credentials: 'include',
    });

    return (await response.json()) as WbiNavResponse;
  }

  private normalizeTracks(
    items: readonly BilibiliSubtitleItem[],
    source: string,
    languages?: readonly string[],
  ): Result<readonly SubtitleTrack[]> {
    if (items.length === 0) {
      return {
        ok: false,
        error: {
          code: 'NO_SUBTITLE',
          message: `该视频在 ${source} 上没有返回任何字幕。可能原因：UP 主没上传字幕且 B 站 AI 转写未生成；或需要登录 / 大会员权限。`,
          retryable: false,
        },
      };
    }

    const tracks: SubtitleTrack[] = items.map((item) => ({
      language: item.lan,
      label: item.lan_doc,
      url: normalizeBilibiliSubtitleUrl(item.subtitle_url),
      source: subtitleSourceOf(item),
    }));

    return { ok: true, value: sortSubtitleTracks(tracks, languages) };
  }

  private buildRequestHeaders(bvid?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
      'User-Agent': navigatorUserAgent(),
    };

    if (this.cookieHeader) {
      headers.Cookie = this.cookieHeader;
    }

    return headers;
  }
}

function subtitleSourceOf(item: BilibiliSubtitleItem): SubtitleTrack['source'] {
  const isAiNamedTrack = item.lan.trim().toLowerCase().startsWith('ai-');
  if (typeof item.ai_type === 'number') {
    if (item.ai_type !== 0) return 'asr';
    return isAiNamedTrack ? 'unknown' : 'official';
  }
  if (item.type === 0) return isAiNamedTrack ? 'unknown' : 'official';
  return 'unknown';
}

function normalizeBilibiliSubtitleUrl(rawUrl: string): string {
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }

  if (rawUrl.startsWith('//')) {
    return `https:${rawUrl}`;
  }

  return `https://${rawUrl}`;
}

function normalizeBilibiliViewPoints(
  viewPoints: readonly BilibiliViewPoint[],
): readonly VideoPlatformChapter[] {
  return viewPoints
    .map((point): VideoPlatformChapter | null => {
      const title = point.content?.trim();
      if (!title || typeof point.from !== 'number' || !Number.isFinite(point.from)) {
        return null;
      }
      const start = Math.max(0, point.from);
      const end =
        typeof point.to === 'number' && Number.isFinite(point.to) && point.to > start
          ? point.to
          : undefined;
      return {
        title,
        start,
        ...(typeof end === 'number' ? { end } : {}),
      };
    })
    .filter((chapter): chapter is VideoPlatformChapter => chapter !== null)
    .sort((left, right) => left.start - right.start);
}

function extractPageNumber(videoIdOrUrl: string): number {
  try {
    const parsed = new URL(videoIdOrUrl);
    const page = Number(parsed.searchParams.get('p') ?? '1');

    return Number.isInteger(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

function createBilibiliVideoUrl(bvid: string, page: number): string {
  const baseUrl = `https://www.bilibili.com/video/${bvid}/`;

  return page > 1 ? `${baseUrl}?p=${page}` : baseUrl;
}

function selectBilibiliPage(
  pages: readonly BilibiliPageInfo[] | undefined,
  requestedPageNumber: number,
): Result<BilibiliPageInfo> {
  if (!Array.isArray(pages) || pages.length === 0) {
    return {
      ok: false,
      error: {
        code: 'API_ERROR',
        message: 'B 站 metadata 缺少分 P 信息，无法确认字幕对应当前页面',
        retryable: true,
      },
    };
  }

  const selectedPage = pages.find((page) => page.page === requestedPageNumber);

  if (!selectedPage) {
    return {
      ok: false,
      error: {
        code: 'API_ERROR',
        message: `当前 URL 指向 B 站第 ${requestedPageNumber}P，但 metadata 没有对应分 P，已停止字幕分析以避免取错字幕。`,
        retryable: true,
      },
    };
  }

  const value: BilibiliPageInfo = {
    cid: selectedPage.cid,
    page: selectedPage.page,
  };

  return {
    ok: true,
    value: {
      ...value,
      ...(selectedPage.part ? { part: selectedPage.part } : {}),
      ...(typeof selectedPage.duration === 'number' ? { duration: selectedPage.duration } : {}),
    },
  };
}

function navigatorUserAgent(): string {
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36 bAI-browser-assistant'
  );
}

function createBilibiliNetworkMessage(stage: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `B 站 ${stage} 请求失败：${message}。请确认扩展已重新加载，manifest 允许 api.bilibili.com 和 hdslb.com 跨域请求。`;
}

function createBilibiliApiError(
  code: number,
  original: string | undefined,
  stage: string,
): Result<never> {
  if (code === -101) {
    return {
      ok: false,
      error: {
        code: 'API_ERROR',
        message: `B 站接口未识别登录态（${stage}）。请确认已在 B 站登录，刷新视频页后再试。`,
        retryable: true,
      },
    };
  }

  if (code === -352) {
    return {
      ok: false,
      error: {
        code: 'API_ERROR',
        message: `B 站接口触发风控（${stage}）。请稍候再试，或检查登录态后刷新。`,
        retryable: true,
      },
    };
  }

  if (code === -403) {
    return {
      ok: false,
      error: {
        code: 'API_ERROR',
        message: `B 站接口拒绝访问（${stage}）。该视频可能需要登录或大会员权限。`,
        retryable: true,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'API_ERROR',
      message: original
        ? `${stage} 失败：${original}（code=${code}）`
        : `${stage} 失败（code=${code}）`,
      retryable: true,
    },
  };
}

function createMemoryWbiStore(): WbiCacheStore {
  let cached: MixKeyCache | null = null;
  return {
    async read(): Promise<MixKeyCache | null> {
      return cached;
    },
    async write(cache: MixKeyCache): Promise<void> {
      cached = cache;
    },
  };
}
