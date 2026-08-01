import type {
  LearningGuide,
  LearningGuideDecisionSegment,
  LearningGuideTimePlan,
  TimelineNode,
  VideoAnalysis,
  VideoChapter,
} from '@core/types';

export function alignLearningGuideWithTimeline(
  guide: LearningGuide,
  analysis: VideoAnalysis | null,
): LearningGuide {
  if (!analysis || (analysis.timeline.length === 0 && analysis.chapters.length === 0)) {
    return guide;
  }
  const candidates = createTimelineCandidates(analysis);
  if (candidates.length === 0) {
    return guide;
  }
  const alignSegment = (segment: LearningGuideDecisionSegment): LearningGuideDecisionSegment =>
    alignDecisionSegment(segment, candidates);
  return {
    ...guide,
    decision: {
      ...guide.decision,
      timePlans: guide.decision.timePlans.map((plan) => alignTimePlan(plan, alignSegment)),
      mustWatch: guide.decision.mustWatch.map(alignSegment),
      canWatch: guide.decision.canWatch.map(alignSegment),
      canSkim: guide.decision.canSkim.map(alignSegment),
      canSkip: guide.decision.canSkip.map(alignSegment),
    },
  };
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
