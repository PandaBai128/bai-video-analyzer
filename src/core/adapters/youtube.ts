import type { VideoAdapter } from './base';
import type { Result, SubtitleCue, SubtitleTrack, VideoMetadata } from '@core/types';
import { sortSubtitleTracks } from '@core/subtitles/language-preference';

interface YouTubeOEmbedResponse {
  readonly title: string;
  readonly author_name: string;
  readonly thumbnail_url?: string;
}

interface CaptionTrackRaw {
  readonly baseUrl: string;
  readonly name?: { readonly simpleText?: string };
  readonly languageCode?: string;
  readonly kind?: string;
}

export class YouTubeAdapter implements VideoAdapter {
  readonly platform = 'youtube' as const;

  match(url: string): boolean {
    return this.extractVideoId(url) !== null;
  }

  extractVideoId(url: string): string | null {
    try {
      const parsed = new URL(url);

      if (parsed.hostname.includes('youtu.be')) {
        const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
        return segments[0] ?? null;
      }

      if (parsed.hostname.includes('youtube.com')) {
        if (parsed.pathname === '/watch') {
          return parsed.searchParams.get('v');
        }
        // /shorts/<id> / /embed/<id> / /live/<id> / /v/<id>
        const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
        if (segments.length >= 2) {
          const head = segments[0]?.toLowerCase();
          if (head === 'shorts' || head === 'embed' || head === 'live' || head === 'v') {
            return segments[1] ?? null;
          }
        }
      }
    } catch {
      return /^[\w-]{11}$/.test(url) ? url : null;
    }

    return /^[\w-]{11}$/.test(url) ? url : null;
  }

  async fetchMetadata(videoIdOrUrl: string): Promise<Result<VideoMetadata>> {
    const videoId = this.extractVideoId(videoIdOrUrl) ?? videoIdOrUrl;

    if (!/^[\w-]{11}$/.test(videoId)) {
      return {
        ok: false,
        error: { code: 'INVALID_URL', message: '无法识别 YouTube 视频 ID', retryable: false },
      };
    }

    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await fetch(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      );

      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: 'API_ERROR',
            message: `YouTube oEmbed 返回 HTTP ${response.status}`,
            retryable: true,
          },
        };
      }

      const data = (await response.json()) as YouTubeOEmbedResponse;

      const metadata: VideoMetadata = {
        platform: this.platform,
        videoId,
        url,
        title: data.title,
        author: data.author_name,
      };

      if (data.thumbnail_url) {
        return { ok: true, value: { ...metadata, thumbnailUrl: data.thumbnail_url } };
      }

      return { ok: true, value: metadata };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: createYouTubeNetworkMessage('metadata', error),
          retryable: true,
        },
      };
    }
  }

  async fetchSubtitleTracks(
    videoIdOrUrl: string,
    languages?: readonly string[],
  ): Promise<Result<readonly SubtitleTrack[]>> {
    const videoId = this.extractVideoId(videoIdOrUrl) ?? videoIdOrUrl;

    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 bAI-browser-assistant' },
      });
      const html = await response.text();
      const tracks = extractYouTubeCaptionTracks(html).map((track) => ({
        language: track.languageCode ?? 'unknown',
        label: track.name?.simpleText ?? track.languageCode ?? '字幕',
        url: track.baseUrl,
        source: track.kind === 'asr' ? ('asr' as const) : ('official' as const),
      }));

      return { ok: true, value: sortSubtitleTracks(tracks, languages) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: createYouTubeNetworkMessage('subtitle list', error),
          retryable: true,
        },
      };
    }
  }

  async fetchSubtitleCues(track: SubtitleTrack): Promise<Result<readonly SubtitleCue[]>> {
    try {
      const url = new URL(track.url);
      url.searchParams.set('fmt', 'json3');
      const response = await fetch(url);
      const text = await response.text();

      if (!text.trim()) {
        return { ok: true, value: [] };
      }

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
            const text =
              event.segs
                ?.map((seg) => seg.utf8 ?? '')
                .join('')
                .trim() ?? '';
            const start = (event.tStartMs ?? 0) / 1000;
            const duration = (event.dDurationMs ?? 0) / 1000;

            const cue: SubtitleCue = {
              start,
              text,
            };

            return duration > 0 ? { ...cue, end: start + duration } : cue;
          })
          .filter((cue) => cue.text.length > 0) ?? [];

      return { ok: true, value: cues };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'PARSE_ERROR',
          message: createYouTubeNetworkMessage('subtitle file', error),
          retryable: true,
        },
      };
    }
  }

  getTimestampUrl(videoId: string, seconds: number): string {
    return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(seconds))}s`;
  }
}

export function extractYouTubeCaptionTracks(html: string): readonly CaptionTrackRaw[] {
  const key = '"captionTracks":';
  const start = html.indexOf(key);

  if (start === -1) {
    return [];
  }

  const arrayStart = html.indexOf('[', start);

  if (arrayStart === -1) {
    return [];
  }

  const arrayText = readJsonArray(html, arrayStart);

  if (!arrayText) {
    return [];
  }

  try {
    return JSON.parse(arrayText) as CaptionTrackRaw[];
  } catch {
    return [];
  }
}

function readJsonArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function createYouTubeNetworkMessage(stage: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `YouTube ${stage} 请求失败：${message}。请确认扩展已重新加载，manifest 允许 youtube.com 跨域请求。`;
}
