export interface PlaybackState {
  readonly currentTime: number;
  readonly duration?: number;
  readonly paused: boolean;
  readonly updatedAt: number;
}
