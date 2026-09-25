import type {
  LearningGuide,
  LearningGuideContentPoint,
  LearningGuideDecisionSegment,
  LearningGuideTimePlan,
  SubtitleCue,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
} from '@core/types';

export function alignLearningGuideWithTimeline(
  guide: LearningGuide,
  analysis: VideoAnalysis | null,
  transcriptCues: readonly SubtitleCue[] = [],
): LearningGuide {
  const candidates = analysis ? createTimelineCandidates(analysis) : [];
  if (candidates.length === 0 && transcriptCues.length === 0) {
    return guide;
  }
  const alignSegment = (segment: LearningGuideDecisionSegment): LearningGuideDecisionSegment =>
    alignDecisionSegment(segment, candidates);
  return {
    ...guide,
    decision: {
      ...guide.decision,
      ...(guide.decision.contentPoints
        ? {
            contentPoints: guide.decision.contentPoints.map((point) =>
              alignContentPoint(point, candidates, transcriptCues),
            ),
          }
        : {}),
      timePlans: guide.decision.timePlans.map((plan) => alignTimePlan(plan, alignSegment)),
      mustWatch: guide.decision.mustWatch.map(alignSegment),
      canWatch: guide.decision.canWatch.map(alignSegment),
      canSkim: guide.decision.canSkim.map(alignSegment),
      canSkip: guide.decision.canSkip.map(alignSegment),
    },
  };
}

function alignContentPoint(
  point: LearningGuideContentPoint,
  timeline: readonly TimelineCandidate[],
  transcriptCues: readonly SubtitleCue[],
): LearningGuideContentPoint {
  // 导航的小节来自字幕锚点；旧速览里的模型秒数只能作为模糊线索。
  const preciseTimelineTime = findContentPointTimelineTime(point, timeline, 'segment');
  if (preciseTimelineTime !== undefined) {
    return { ...point, timestamp: preciseTimelineTime };
  }
  // 仅有粗章节时，只修正明显早于章节起点的旧模型时间；章节内部不倒退到章首。
  const chapterTime = findContentPointTimelineTime(point, timeline, 'chapter');
  if (
    point.timestamp !== undefined && chapterTime !== undefined
    && chapterTime > point.timestamp && chapterTime - point.timestamp <= 90
  ) {
    return { ...point, timestamp: chapterTime };
  }
  if (point.timestamp !== undefined) return point;
  const topic = normalizeForLooseMatch(`${point.title}${point.detail}`);
  const fromTimeline = findUniqueTime(
    topic,
    timeline.map((candidate) => ({
      timestamp: candidate.timestamp,
      text: `${candidate.title}${candidate.summary}`,
    })),
    6,
  );
  const fromTranscript = fromTimeline === undefined
    ? findUniqueTime(
        topic,
        transcriptCues.map((cue, index) => ({
          timestamp: cue.start,
          text: transcriptCues
            .slice(index, index + 3)
            .filter((nearby) => nearby.start - cue.start <= 20)
            .map((nearby) => nearby.text)
            .join(''),
        })),
        6,
      )
    : undefined;
  const timestamp = fromTimeline ?? fromTranscript;
  return timestamp === undefined ? point : { ...point, timestamp };
}

function findContentPointTimelineTime(
  point: LearningGuideContentPoint,
  timeline: readonly TimelineCandidate[],
  source: TimelineCandidate['source'],
): number | undefined {
  const title = normalizeForLooseMatch(point.title);
  if (title.length < 3) return undefined;
  const detail = normalizeForLooseMatch(point.detail);
  const ranked = timeline
    .filter((candidate) => candidate.source === source)
    .map((candidate) => {
      const candidateTitle = normalizeForLooseMatch(candidate.title);
      const candidateSummary = normalizeForLooseMatch(candidate.summary);
      const titleOverlap = longestCommonSubstringLength(title, candidateTitle);
      const summaryOverlap = longestCommonSubstringLength(title, candidateSummary);
      const requiredOverlap = Math.min(4, title.length);
      if (Math.max(titleOverlap, summaryOverlap) < requiredOverlap) return null;
      const detailOverlap = longestCommonSubstringLength(detail, candidateSummary);
      const distance = point.timestamp === undefined ? Infinity : Math.abs(candidate.timestamp - point.timestamp);
      if (point.timestamp !== undefined && distance > 180) return null;
      return {
        timestamp: candidate.timestamp,
        score: titleOverlap * 3 + summaryOverlap + Math.min(detailOverlap, 8)
          + (distance <= 90 ? 3 : 0),
      };
    })
    .filter((item): item is { timestamp: number; score: number } => item !== null)
    .sort((left, right) => right.score - left.score || left.timestamp - right.timestamp);
  const best = ranked[0];
  if (!best) return undefined;
  const competing = ranked.find((candidate) => Math.abs(candidate.timestamp - best.timestamp) > 20);
  return competing && best.score - competing.score < 2 ? undefined : best.timestamp;
}

function findUniqueTime(
  topic: string,
  candidates: readonly { readonly timestamp: number; readonly text: string }[],
  minimumScore: number,
): number | undefined {
  const ranked = candidates
    .filter((candidate) => Number.isFinite(candidate.timestamp) && candidate.timestamp >= 0)
    .map((candidate) => ({
      timestamp: candidate.timestamp,
      score: longestCommonSubstringLength(topic, normalizeForLooseMatch(candidate.text)),
    }))
    .filter((candidate) => candidate.score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.timestamp - right.timestamp);
  const best = ranked[0];
  if (!best) return undefined;
  const competing = ranked.find((candidate) => Math.abs(candidate.timestamp - best.timestamp) > 20);
  return competing && best.score - competing.score < 2 ? undefined : best.timestamp;
}

interface TimelineCandidate {
  readonly title: string;
  readonly summary: string;
  readonly timestamp: number;
  readonly endTimestamp?: number;
  readonly source: 'segment' | 'chapter';
}

function createTimelineCandidates(analysis: VideoAnalysis): readonly TimelineCandidate[] {
  const candidates: TimelineCandidate[] = [];
  for (const chapter of analysis.chapters) {
    for (const segment of chapter.segments) {
      candidates.push(toCandidate(segment, 'segment'));
    }
    candidates.push(toCandidate(chapter, 'chapter'));
  }
  for (const node of analysis.timeline) {
    if (
      !candidates.some(
        (candidate) => candidate.timestamp === node.timestamp && candidate.title === node.title,
      )
    ) {
      candidates.push(toCandidate(node, 'segment'));
    }
  }
  return candidates;
}

function toCandidate(
  node: TimelineNode | VideoChapter,
  source: TimelineCandidate['source'],
): TimelineCandidate {
  return {
    title: node.title,
    summary: node.summary,
    timestamp: node.timestamp,
    ...(node.endTimestamp !== undefined ? { endTimestamp: node.endTimestamp } : {}),
    source,
  };
}

function alignTimePlan(
  plan: LearningGuideTimePlan,
  alignSegment: (segment: LearningGuideDecisionSegment) => LearningGuideDecisionSegment,
): LearningGuideTimePlan {
  return {
    ...plan,
    segments: plan.segments.map(alignSegment),
  };
}

function alignDecisionSegment(
  segment: LearningGuideDecisionSegment,
  candidates: readonly TimelineCandidate[],
): LearningGuideDecisionSegment {
  const match = findBestCandidate(segment, candidates);
  if (!match) return segment;
  const { endTimestamp: _oldEndTimestamp, ...rest } = segment;
  return {
    ...rest,
    title: match.title,
    startTimestamp: match.timestamp,
    ...(match.endTimestamp !== undefined ? { endTimestamp: match.endTimestamp } : {}),
  };
}

function findBestCandidate(
  segment: LearningGuideDecisionSegment,
  candidates: readonly TimelineCandidate[],
): TimelineCandidate | null {
  let best: { candidate: TimelineCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(segment, candidate);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }
  return best && best.score >= 8 ? best.candidate : null;
}

function scoreCandidate(
  segment: LearningGuideDecisionSegment,
  candidate: TimelineCandidate,
): number {
  const segmentTitle = normalizeForLooseMatch(segment.title);
  const candidateText = normalizeForLooseMatch(`${candidate.title}${candidate.summary}`);
  if (!segmentTitle || !candidateText) return 0;
  const shared = longestCommonSubstringLength(segmentTitle, candidateText);
  if (shared < 4) return 0;

  let score = shared;
  if (segment.startTimestamp !== undefined) {
    const candidateEnd = candidate.endTimestamp ?? candidate.timestamp;
    if (segment.startTimestamp >= candidate.timestamp && segment.startTimestamp <= candidateEnd) {
      score += 8;
    } else {
      const distance = Math.min(
        Math.abs(segment.startTimestamp - candidate.timestamp),
        Math.abs(segment.startTimestamp - candidateEnd),
      );
      if (distance <= 180) {
        score += 4;
      } else if (distance > 600) {
        score -= 4;
      }
    }
  }
  if (candidate.source === 'segment') {
    score += 2;
  }
  return score;
}

function normalizeForLooseMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
    .replace(/[的了着过和与及或在是为把将中里上下一]+/gu, '');
}

function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  const previous = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    let northwest = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j] ?? 0;
      if (a[i - 1] === b[j - 1]) {
        const value = northwest + 1;
        previous[j] = value;
        if (value > best) best = value;
      } else {
        previous[j] = 0;
      }
      northwest = saved;
    }
  }
  return best;
}
