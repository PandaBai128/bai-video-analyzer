import { z } from 'zod';
import { parseJsonWithRepair } from '@core/analysis/video-analysis-json-repair';
import { stripJsonFence } from '@core/analysis/video-analysis-schema';
import type { LearningReview } from '@core/types';

const rawLearningReviewSchema = z.object({
  coreSummary: z.string().min(1),
  keyIdeas: z
    .array(
      z.object({
        title: z.string().min(1),
        explanation: z.string().min(1),
        evidenceTimestamp: z.number().nonnegative().optional(),
      }),
    )
    .max(6)
    .default([]),
  personalInsights: z.array(z.string().min(1)).max(8).default([]),
  transferReflection: z.string().optional(),
  openQuestions: z.array(z.string().min(1)).max(8).default([]),
  actionItems: z.array(z.string().min(1)).max(8).default([]),
  finalReflection: z.string().optional(),
});

export function parseLearningReviewJson(input: {
  readonly content: string;
  readonly generatedAt: number;
  readonly modelUsed: string;
}): LearningReview {
  const jsonText = stripJsonFence(input.content);
  const parsed = rawLearningReviewSchema.parse(parseJsonWithRepair(jsonText));
  const transferReflection = normalizeOptionalText(parsed.transferReflection);
  return {
    coreSummary: parsed.coreSummary,
    keyIdeas: parsed.keyIdeas.map((idea) => ({
      title: idea.title,
      explanation: idea.explanation,
      ...(idea.evidenceTimestamp !== undefined
        ? { evidenceTimestamp: idea.evidenceTimestamp }
        : {}),
    })),
    personalInsights: parsed.personalInsights,
    ...(transferReflection ? { transferReflection } : {}),
    openQuestions: parsed.openQuestions,
    actionItems: parsed.actionItems,
    finalReflection: normalizeFinalReflection({
      finalReflection: parsed.finalReflection,
      coreSummary: parsed.coreSummary,
      personalInsights: parsed.personalInsights,
    }),
    generatedAt: input.generatedAt,
    modelUsed: input.modelUsed,
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeFinalReflection(input: {
  readonly finalReflection: string | undefined;
  readonly coreSummary: string;
  readonly personalInsights: readonly string[];
}): string {
  const direct = input.finalReflection?.trim();
  if (direct) return collapseWhitespace(direct);

  const coreSummary = input.coreSummary.trim();
  const insight = input.personalInsights.find((item) => item.trim())?.trim();

  return collapseWhitespace(
    insight
      ? `${coreSummary || '这次视频的主要学习价值已经整理到上面的要点中。'} 我可以先带走：${insight}`
      : coreSummary || '这次视频的主要学习价值已经整理到上面的要点中。',
  );
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
