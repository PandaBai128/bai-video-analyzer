import { z } from 'zod';
import { parseJsonWithRepair } from '@core/analysis/video-analysis-json-repair';
import { stripJsonFence } from '@core/analysis/video-analysis-schema';
import type { LearningMomentCoach } from '@core/types';

const rawLearningMomentCoachSchema = z.object({
  response: z.string().min(1),
  handling: z.enum(['keep', 'ask', 'verify', 'apply', 'release']),
  suggestedQuestions: z.array(z.string().min(1)).max(3).default([]),
  nextAction: z.string().min(1).optional(),
  linkedTimestamps: z
    .array(
      z.object({
        timestamp: z.number().nonnegative(),
        reason: z.string().min(1),
      }),
    )
    .max(3)
    .default([]),
});

export function parseLearningMomentCoachJson(input: {
  readonly content: string;
  readonly generatedAt: number;
  readonly modelUsed: string;
}): LearningMomentCoach {
  const jsonText = stripJsonFence(input.content);
  const parsed = rawLearningMomentCoachSchema.parse(parseJsonWithRepair(jsonText));
  return {
    response: parsed.response,
    handling: parsed.handling,
    suggestedQuestions: parsed.suggestedQuestions,
    ...(parsed.nextAction ? { nextAction: parsed.nextAction } : {}),
    linkedTimestamps: parsed.linkedTimestamps,
    generatedAt: input.generatedAt,
    modelUsed: input.modelUsed,
  };
}
