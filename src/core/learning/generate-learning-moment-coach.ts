import { createLanguageModelClient } from '@core/llm/language-model-factory';
import { buildLearningMomentCoachPrompt } from '@core/prompts/learning-moment-coach';
import type {
  LearningMoment,
  LearningMomentCoach,
  LearningSession,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import type { TextProviderSettings } from '@shared/settings';
import { getActiveTextModel } from '@shared/settings';
import { parseLearningMomentCoachJson } from './learning-moment-coach-schema';
import { normalizeLearningMomentCoach } from './normalize-learning-moment-coach';

export async function generateLearningMomentCoach(input: {
  readonly settings: TextProviderSettings;
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
  readonly session: LearningSession;
  readonly moment: LearningMoment;
}): Promise<LearningMomentCoach> {
  const response = await createLanguageModelClient(input.settings).chat(
    [
      {
        role: 'user',
        content: buildLearningMomentCoachPrompt(input),
      },
    ],
    { model: getActiveTextModel(input.settings), usageFeature: 'notes' },
  );
  const coach = parseLearningMomentCoachJson({
    content: response.content,
    generatedAt: Date.now(),
    modelUsed: response.model,
  });
  return normalizeLearningMomentCoach({
    coach,
    moment: input.moment,
    guide: input.session.guide,
  });
}
