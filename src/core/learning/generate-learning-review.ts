import { createLanguageModelClient } from '@core/llm/language-model-factory';
import { buildLearningReviewPrompt } from '@core/prompts/learning-review';
import type {
  LearningReview,
  LearningSession,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import type { TextProviderSettings } from '@shared/settings';
import { getActiveTextModel } from '@shared/settings';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import { parseLearningReviewJson } from './learning-review-schema';
import { normalizeLearningReview } from './normalize-learning-review';

export async function generateLearningReview(input: {
  readonly settings: TextProviderSettings;
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
  readonly session: LearningSession;
  readonly outputLocale?: UiLocale;
}): Promise<LearningReview> {
  const response = await createLanguageModelClient(input.settings).chat(
    [
      {
        role: 'user',
        content: buildLearningReviewPrompt(input),
      },
    ],
    { model: getActiveTextModel(input.settings), usageFeature: 'notes' },
  );
  const review = parseLearningReviewJson({
    content: response.content,
    generatedAt: Date.now(),
    modelUsed: response.model,
  });
  const normalized = normalizeLearningReview({
    review,
    transcriptCues: input.transcriptCues,
    analysis: input.analysis,
  });
  return { ...normalized, outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE };
}
