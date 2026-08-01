export type SupportedPlatform = 'bilibili' | 'youtube' | 'unknown';

/**
 * Round 22 必修 A1：扩展 PageContext，引入 `contentKey` + `platformSpecific`。
 *
 * 设计目标：
 * - B 站多 P（`?p=10`）必须和 `?p=1` 在系统里有不同身份 —— 否则缓存/追问/标注/
 *   反思会串。
 * - YouTube 仍然用 videoId 作为内容身份。
 * - `contentKey` 优先于 `videoId` 作为内容身份；如果 contentKey 缺失，
 *   调用方应走 `getPageContextContentKey()` 兜底（看 VideoMetadata 的
 *   `platformSpecific.page`）。
 * - `platformSpecific` 是开放 map，B 站至少需要 `page`（Number）。
 *
 * 不变量：
 * - `contentKey` 一旦在 PageContext 上就**只能由 detectPageContext 派生**。
 *   测试中可以直接读 `platformSpecific.page` 验证，而不是只信 contentKey。
 */
export interface PageContext {
  readonly platform: SupportedPlatform;
  readonly url: string;
  readonly title: string;
  readonly videoId?: string;
  /**
   * Round 22：内容身份 key。
   * - B 站：`<BV>:p=<page>`（默认 page=1）
   * - YouTube：videoId
   * - 其它平台：undefined
   */
  readonly contentKey?: string;
  /**
   * Round 22：平台特定字段。B 站目前至少含 `page: number`。
   * 用 map 形式保持向后兼容（YouTube 暂不需要）。
   */
  readonly platformSpecific?: {
    readonly page?: number;
    readonly [key: string]: unknown;
  };
  readonly detectedAt: number;
}

export function detectPageContext(urlText: string, title: string): PageContext {
  const url = new URL(urlText);
  const host = url.hostname;
  const pathname = url.pathname;

  if (host.includes('bilibili.com')) {
    const match = pathname.match(/\/video\/(BV[\w]+)/);
    const page = extractBilibiliPageNumber(url);
    const baseContext = {
      platform: 'bilibili' as const,
      url: urlText,
      title,
      detectedAt: Date.now(),
    };

    if (match?.[1]) {
      const videoId = match[1];
      return {
        ...baseContext,
        videoId,
        contentKey: `${videoId}:p=${page}`,
        platformSpecific: { page },
      };
    }

    return baseContext;
  }

  if (host.includes('youtube.com') || host.includes('youtu.be')) {
    const videoId = extractYouTubeVideoId(url);
    const normalizedTitle = normalizeYouTubePageTitle(title);

    const context: PageContext = {
      platform: 'youtube',
      url: urlText,
      title: normalizedTitle,
      detectedAt: Date.now(),
    };

    if (videoId) {
      return { ...context, videoId, contentKey: videoId };
    }

    return context;
  }

  return {
    platform: 'unknown',
    url: urlText,
    title,
    detectedAt: Date.now(),
  };
}

export function normalizeYouTubePageTitle(title: string): string {
  return title
    .replace(/\s+-\s+YouTube\s*$/i, '')
    .replace(/^\s*(?:\(\d+\)\s*)+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 YouTube URL 抽 videoId。支持 watch / youtu.be / shorts / embed / live。
 * 抽不到返回 undefined（不抛错）。
 */
export function extractYouTubeVideoId(url: URL): string | undefined {
  const host = url.hostname;

  if (host.includes('youtu.be')) {
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    return segments[0];
  }

  if (url.pathname === '/watch') {
    return url.searchParams.get('v') ?? undefined;
  }

  // /shorts/<id> / /embed/<id> / /live/<id> / /v/<id>
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length >= 2) {
    const head = segments[0]?.toLowerCase();
    if (
      head === 'shorts' ||
      head === 'embed' ||
      head === 'live' ||
      head === 'v'
    ) {
      return segments[1];
    }
  }

  return undefined;
}

/**
 * Round 22：从 B 站 URL 抽 `?p=N` 里的分 P 编号。
 * - 缺失 / 解析失败 / 非正整数 / <= 0 → 回落 1
 * - 不抛错
 */
export function extractBilibiliPageNumber(url: URL): number {
  const raw = url.searchParams.get('p');
  if (raw === null) {
    return 1;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
