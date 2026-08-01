import type { Result, SubtitleCue, SubtitleTrack, VideoMetadata, VideoPlatform } from '@core/types';

export interface VideoAdapter {
  readonly platform: VideoPlatform;
  match(url: string): boolean;
  extractVideoId(url: string): string | null;
  fetchMetadata(videoIdOrUrl: string): Promise<Result<VideoMetadata>>;
  fetchSubtitleTracks(
    videoIdOrUrl: string,
    languages?: readonly string[],
  ): Promise<Result<readonly SubtitleTrack[]>>;
  fetchSubtitleCues(track: SubtitleTrack): Promise<Result<readonly SubtitleCue[]>>;
  getTimestampUrl(videoId: string, seconds: number): string;

  /**
   * 注入登录态 Cookie 头（如 `SESSDATA=xxx; bili_jct=yyy`）。由调用方在分析前设置，
   * adapter 内部会把它加到 fetch 的 `Cookie` header 里。传 `null` 表示清除。
   * 不需要登录态的 adapter 可以不实现。
   */
  setCookieHeader?(header: string | null): void;
}
