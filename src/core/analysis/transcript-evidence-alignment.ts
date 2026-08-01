import type { SubtitleCue, TimelineNode, VideoAnalysis, VideoChapter } from '@core/types';
import { normalizeChapterTimelineStructure } from './timeline-normalize';

const SNAP_TOLERANCE_SECONDS = 15;
const MAX_EVIDENCE_SEARCH_SECONDS = 4 * 60;
const MIN_EVIDENCE_SCORE = 5;

interface EvidenceCue {
  readonly start: number;
  readonly text: string;
  readonly normalizedText: string;
}

interface SearchTerm {
  readonly normalized: string;
  readonly score: number;
}

export function alignAnalysisToTranscriptEvidence(input: {
  readonly analysis: VideoAnalysis;
  readonly subtitles: readonly SubtitleCue[];
  readonly duration?: number | undefined;
}): VideoAnalysis {
  if (input.subtitles.length === 0 || input.analysis.chapters.length === 0) {
    return input.analysis;
  }

  const evidenceCues = input.subtitles
    .filter((cue) => Number.isFinite(cue.start) && cue.text.trim())
    .map((cue) => ({
      start: Math.max(0, cue.start),
      text: cue.text,
      normalizedText: normalizeForEvidence(cue.text),
    }))
    .filter((cue) => cue.normalizedText);

  if (evidenceCues.length === 0) {
    return input.analysis;
  }

  const sortedChapters = [...input.analysis.chapters].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const snappedChapters = sortedChapters.map((chapter, chapterIndex) => {
    const previousChapter = sortedChapters[chapterIndex - 1];
    const nextChapter = sortedChapters[chapterIndex + 1];
    return snapChapter({
      chapter,
      evidenceCues,
      lowerBound: previousChapter?.timestamp,
      upperBound: nextChapter?.timestamp,
      duration: input.duration,
    });
  });

  const normalized = normalizeChapterTimelineStructure(snappedChapters, input.duration);
  const cappedChapters = capSegmentRanges(normalized.chapters, input.duration);
  return {
    ...input.analysis,
    chapters: cappedChapters,
    timeline: cappedChapters.flatMap((chapter) => chapter.segments),
  };
}

function snapChapter(input: {
  readonly chapter: VideoChapter;
  readonly evidenceCues: readonly EvidenceCue[];
  readonly lowerBound?: number | undefined;
  readonly upperBound?: number | undefined;
  readonly duration?: number | undefined;
}): VideoChapter {
  const snappedTimestamp = findEvidenceTimestamp({
    title: input.chapter.title,
    summary: input.chapter.summary,
    currentTimestamp: input.chapter.timestamp,
    evidenceCues: input.evidenceCues,
    lowerBound: input.lowerBound,
    upperBound: input.upperBound,
    duration: input.duration,
  });

  const chapterTimestamp = snappedTimestamp ?? input.chapter.timestamp;
  const sortedSegments = [...input.chapter.segments].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const snappedSegments = sortedSegments.map((segment, segmentIndex) => {
    const previousSegment = sortedSegments[segmentIndex - 1];
    const nextSegment = sortedSegments[segmentIndex + 1];
    return snapSegment({
      segment,
      evidenceCues: input.evidenceCues,
      lowerBound: previousSegment?.timestamp ?? chapterTimestamp,
      upperBound: nextSegment?.timestamp ?? input.chapter.endTimestamp ?? input.upperBound,
      duration: input.duration,
    });
  });

  return {
    ...input.chapter,
    timestamp: chapterTimestamp,
    segments: snappedSegments,
  };
}

function snapSegment(input: {
  readonly segment: TimelineNode;
  readonly evidenceCues: readonly EvidenceCue[];
  readonly lowerBound?: number | undefined;
  readonly upperBound?: number | undefined;
  readonly duration?: number | undefined;
}): TimelineNode {
  const snappedTimestamp = findEvidenceTimestamp({
    title: input.segment.title,
    summary: input.segment.summary,
    currentTimestamp: input.segment.timestamp,
    evidenceCues: input.evidenceCues,
    lowerBound: input.lowerBound,
    upperBound: input.upperBound,
    duration: input.duration,
  });
  if (typeof snappedTimestamp !== 'number') {
    return input.segment;
  }
  const endTimestamp =
    typeof input.segment.endTimestamp === 'number' && input.segment.endTimestamp > snappedTimestamp
      ? input.segment.endTimestamp
      : undefined;
  return {
    ...input.segment,
    timestamp: snappedTimestamp,
    ...(typeof endTimestamp === 'number' ? { endTimestamp } : {}),
  };
}

function findEvidenceTimestamp(input: {
  readonly title: string;
  readonly summary: string;
  readonly currentTimestamp: number;
  readonly evidenceCues: readonly EvidenceCue[];
  readonly lowerBound?: number | undefined;
  readonly upperBound?: number | undefined;
  readonly duration?: number | undefined;
}): number | undefined {
  const terms = createSearchTerms(input.title, input.summary, input.evidenceCues);
  if (terms.length === 0) {
    return undefined;
  }

  const searchStart = Math.max(
    0,
    input.currentTimestamp - MAX_EVIDENCE_SEARCH_SECONDS,
    typeof input.lowerBound === 'number' ? input.lowerBound - SNAP_TOLERANCE_SECONDS : 0,
  );
  const searchEnd = Math.min(
    typeof input.duration === 'number' && input.duration > 0 ? input.duration : Number.POSITIVE_INFINITY,
    input.currentTimestamp + MAX_EVIDENCE_SEARCH_SECONDS,
    typeof input.upperBound === 'number'
      ? input.upperBound + SNAP_TOLERANCE_SECONDS
      : Number.POSITIVE_INFINITY,
  );

  const candidate = input.evidenceCues.find((cue) => {
    if (cue.start < searchStart || cue.start > searchEnd) {
      return false;
    }
    return scoreCue(cue, terms) >= MIN_EVIDENCE_SCORE;
  });

  if (!candidate) {
    return undefined;
  }
  if (Math.abs(candidate.start - input.currentTimestamp) <= SNAP_TOLERANCE_SECONDS) {
    return undefined;
  }
  return candidate.start;
}

function createSearchTerms(
  title: string,
  summary: string,
  cues: readonly EvidenceCue[],
): readonly SearchTerm[] {
  const titleTerms = extractTerms(title);
  const summaryTerms = titleTerms.length >= 2 ? [] : extractTerms(summary);
  const deduped = dedupeTerms([...titleTerms, ...summaryTerms]);
  return deduped.filter((term) => !isOverlyCommonTerm(term, cues));
}

function extractTerms(text: string): readonly SearchTerm[] {
  const terms: SearchTerm[] = [];
  const latinSequences = text.match(/[A-Za-z0-9][A-Za-z0-9.\-+]*(?:\s+[A-Za-z0-9][A-Za-z0-9.\-+]*)*/g) ?? [];
  for (const sequence of latinSequences) {
    const words = sequence
      .toLowerCase()
      .split(/\s+/)
      .map((word) => normalizeForEvidence(word))
      .filter((word) => word.length >= 3 && !LATIN_STOP_TERMS.has(word));
    if (words.length >= 2) {
      terms.push({ normalized: words.join(''), score: 8 });
    }
    for (const word of words) {
      terms.push({ normalized: word, score: word.length >= 5 ? 6 : 5 });
      if (word.length > 4 && word.endsWith('s')) {
        terms.push({ normalized: word.slice(0, -1), score: 5 });
      }
    }
  }

  const chineseSequences = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const sequence of chineseSequences) {
    for (const part of sequence.split(/[的了和与及以及是在中里上：:，,、（）()【】《》\s]+/u)) {
      const normalized = normalizeForEvidence(part);
      if (normalized.length < 2 || CHINESE_STOP_TERMS.has(normalized)) {
        continue;
      }
      if (normalized.length >= 3) {
        terms.push({ normalized, score: Math.min(8, normalized.length + 2) });
      }
      for (const gram of createChineseNgrams(normalized)) {
        if (!CHINESE_STOP_TERMS.has(gram)) {
          terms.push({ normalized: gram, score: gram.length >= 3 ? 5 : 3 });
        }
      }
    }
  }
  return terms;
}

function createChineseNgrams(text: string): readonly string[] {
  if (text.length <= 2) {
    return [text];
  }
  const grams: string[] = [];
  for (let size = Math.min(4, text.length); size >= 2; size -= 1) {
    for (let index = 0; index + size <= text.length; index += 1) {
      grams.push(text.slice(index, index + size));
    }
  }
  return grams;
}

function dedupeTerms(terms: readonly SearchTerm[]): readonly SearchTerm[] {
  const byText = new Map<string, SearchTerm>();
  for (const term of terms) {
    const existing = byText.get(term.normalized);
    if (!existing || term.score > existing.score) {
      byText.set(term.normalized, term);
    }
  }
  return [...byText.values()].sort((left, right) => right.score - left.score);
}

function isOverlyCommonTerm(term: SearchTerm, cues: readonly EvidenceCue[]): boolean {
  let count = 0;
  for (const cue of cues) {
    if (cue.normalizedText.includes(term.normalized)) {
      count += 1;
    }
  }
  return count > Math.max(12, Math.floor(cues.length * 0.08));
}

function scoreCue(cue: EvidenceCue, terms: readonly SearchTerm[]): number {
  let score = 0;
  for (const term of terms) {
    if (cue.normalizedText.includes(term.normalized)) {
      score += term.score;
    }
  }
  return score;
}

function capSegmentRanges(
  chapters: readonly VideoChapter[],
  duration: number | undefined,
): readonly VideoChapter[] {
  return chapters.map((chapter, chapterIndex) => {
    const nextChapterStart = chapters[chapterIndex + 1]?.timestamp;
    const chapterEnd = firstFinite(
      chapter.endTimestamp,
      nextChapterStart,
      typeof duration === 'number' && duration > 0 ? duration : undefined,
    );
    const segments = chapter.segments.map((segment, segmentIndex) => {
      const nextSegmentStart = chapter.segments[segmentIndex + 1]?.timestamp;
      const cappedEnd = firstFinite(nextSegmentStart, chapterEnd, segment.endTimestamp);
      if (typeof cappedEnd !== 'number' || cappedEnd <= segment.timestamp) {
        const { endTimestamp: _endTimestamp, ...withoutEnd } = segment;
        return withoutEnd;
      }
      const endTimestamp =
        typeof segment.endTimestamp === 'number'
          ? Math.min(segment.endTimestamp, cappedEnd)
          : cappedEnd;
      return endTimestamp > segment.timestamp ? { ...segment, endTimestamp } : segment;
    });
    return {
      ...chapter,
      ...(typeof chapterEnd === 'number' && chapterEnd > chapter.timestamp
        ? { endTimestamp: chapterEnd }
        : {}),
      segments,
    };
  });
}

function firstFinite(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function normalizeForEvidence(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, '');
}

const LATIN_STOP_TERMS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'you',
  'use',
  'code',
  'codex',
  'claude',
  'chatgpt',
  'openai',
  'video',
]);

const CHINESE_STOP_TERMS = new Set([
  '能力',
  '讲解',
  '介绍',
  '演示',
  '使用',
  '视频',
  '教程',
  '部分',
  '章节',
  '开始',
  '继续',
  '这里',
  '这个',
  '我们',
  '他们',
  '方法',
]);
