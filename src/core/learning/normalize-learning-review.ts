import type { LearningReview, SubtitleCue, VideoAnalysis } from '@core/types';

interface EvidenceCandidate {
  readonly timestamp: number;
  readonly text: string;
}

export function normalizeLearningReview(input: {
  readonly review: LearningReview;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
}): LearningReview {
  const candidates = buildEvidenceCandidates(input);
  return {
    ...input.review,
    keyIdeas: input.review.keyIdeas.map((idea) => {
      const timestamp = pickEvidenceTimestamp({
        title: idea.title,
        explanation: idea.explanation,
        candidates,
      });
      const { evidenceTimestamp: _ignored, ...rest } = idea;
      return timestamp !== undefined ? { ...rest, evidenceTimestamp: timestamp } : rest;
    }),
    personalInsights: input.review.personalInsights.map(rewriteUserSubject),
    ...(input.review.transferReflection
      ? { transferReflection: rewriteUserSubject(input.review.transferReflection) }
      : {}),
  };
}

function buildEvidenceCandidates(input: {
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
}): readonly EvidenceCandidate[] {
  const chapterCandidates =
    input.analysis?.chapters.map((chapter) => ({
      timestamp: chapter.timestamp,
      text: `${chapter.title} ${chapter.summary}`,
    })) ?? [];

  const transcriptCandidates = input.transcriptCues.map((cue, index) => {
    const nearby = input.transcriptCues.slice(Math.max(0, index - 1), index + 2);
    return {
      timestamp: cue.start,
      text: nearby.map((item) => item.text).join(' '),
    };
  });

  return [...chapterCandidates, ...transcriptCandidates];
}

function pickEvidenceTimestamp(input: {
  readonly title: string;
  readonly explanation: string;
  readonly candidates: readonly EvidenceCandidate[];
}): number | undefined {
  const query = `${input.title} ${input.explanation}`;
  const queryTokens = tokenizeEvidenceText(query);
  if (queryTokens.size === 0 || input.candidates.length === 0) return undefined;

  let best: { readonly timestamp: number; readonly score: number } | null = null;
  for (const candidate of input.candidates) {
    const candidateTokens = tokenizeEvidenceText(candidate.text);
    let score = 0;
    for (const token of queryTokens) {
      if (candidateTokens.has(token)) score += 1;
    }
    if (!best || score > best.score) {
      best = { timestamp: candidate.timestamp, score };
    }
  }

  const threshold = Math.min(4, Math.max(2, Math.ceil(queryTokens.size * 0.18)));
  return best && best.score >= threshold ? best.timestamp : undefined;
}

function tokenizeEvidenceText(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_+.-]{1,}/g)) {
    const token = match[0];
    if (!STOP_WORDS.has(token)) tokens.add(token);
  }
  for (const match of normalized.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const text = match[0];
    for (let index = 0; index < text.length - 1; index += 1) {
      const token = text.slice(index, index + 2);
      if (!STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function rewriteUserSubject(value: string): string {
  return value.replace(/用户/g, '我');
}

const STOP_WORDS = new Set([
  '这个',
  '视频',
  '作者',
  '内容',
  '问题',
  '观点',
  '重点',
  '需要',
  '可以',
  '不是',
  '因为',
  '所以',
  '以及',
  '一个',
  'the',
  'and',
  'for',
  'with',
]);
