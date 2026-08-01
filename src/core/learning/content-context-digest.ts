import type { SubtitleCue, VideoAnalysis, VideoMetadata } from '@core/types';

export function createContentContextDigest(input: {
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
}): string {
  const cues = input.transcriptCues;
  const step = Math.max(1, Math.ceil(cues.length / 96));
  const sampledCues = cues
    .filter((_, index) => index === 0 || index === cues.length - 1 || index % step === 0)
    .map((cue, index) =>
      [
        index,
        Math.round(cue.start * 10) / 10,
        cue.end !== undefined ? Math.round(cue.end * 10) / 10 : '',
        cue.text.replace(/\s+/g, ' ').trim().slice(0, 120),
      ].join('|'),
    );
  return stableHash(
    [
      input.metadata.platform,
      input.metadata.videoId,
      input.metadata.title,
      input.metadata.author,
      String(input.metadata.duration ?? ''),
      String(cues.length),
      ...sampledCues,
    ].join('\n'),
  );
}

export function createTimelineDigest(analysis: Pick<VideoAnalysis, 'chapters' | 'timeline'>): string {
  return stableHash(
    [
      ...analysis.chapters.map((chapter) =>
        [
          'chapter',
          chapter.id ?? '',
          chapter.sourceCueRange?.startCueId ?? '',
          chapter.sourceCueRange?.endCueId ?? '',
          Math.round(chapter.timestamp * 10) / 10,
          chapter.title,
        ].join('|'),
      ),
      ...analysis.timeline.map((node) =>
        [
          'node',
          node.id ?? '',
          node.sourceCueRange?.startCueId ?? '',
          node.sourceCueRange?.endCueId ?? '',
          Math.round(node.timestamp * 10) / 10,
          node.title,
        ].join('|'),
      ),
    ].join('\n'),
  );
}

function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
