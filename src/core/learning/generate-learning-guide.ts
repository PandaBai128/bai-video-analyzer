import { createLanguageModelClient } from '@core/llm/language-model-factory';
import { buildLearningGuidePrompt } from '@core/prompts/learning-guide';
import type {
  LearningGuide,
  LearningSession,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
} from '@core/types';
import type { TextProviderSettings } from '@shared/settings';
import { getActiveTextModel } from '@shared/settings';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import { alignLearningGuideWithTimeline } from './align-learning-guide-timeline';
import { parseLearningGuideJson } from './learning-guide-schema';

export const LEARNING_GUIDE_GENERATION_TIMEOUT_MS = 180_000;
export const LEARNING_GUIDE_MAX_TOKENS = 8192;

export class LearningGuideGenerationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`观看判断生成超时：超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成。`);
    this.name = 'LearningGuideGenerationTimeoutError';
  }
}

export async function generateLearningGuide(input: {
  readonly settings: TextProviderSettings;
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly analysis: VideoAnalysis | null;
  readonly session: LearningSession;
  readonly outputLocale?: UiLocale;
}): Promise<LearningGuide> {
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), LEARNING_GUIDE_GENERATION_TIMEOUT_MS);

  try {
    const client = createLanguageModelClient(input.settings);
    const activeModel = getActiveTextModel(input.settings);
    const prompt = buildLearningGuidePrompt(input);
    const response = await client.chat(
      [
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: activeModel,
        signal: abort.signal,
        maxTokens: LEARNING_GUIDE_MAX_TOKENS,
        usageFeature: 'analysis',
      },
    );
    try {
      const guide = parseLearningGuideJson({
        content: response.content,
        generatedAt: Date.now(),
        modelUsed: response.model,
        outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE,
      });
      return alignLearningGuideWithTimeline(
        { ...guide, outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE },
        input.analysis,
      );
    } catch {
      if (abort.signal.aborted) {
        throw new LearningGuideGenerationTimeoutError(LEARNING_GUIDE_GENERATION_TIMEOUT_MS);
      }
      const retryResponse = await client.chat(
        [
          {
            role: 'user',
            content: `${prompt}\n\n上一次输出不是可解析的 JSON。请重新输出完整合法 JSON，不要 Markdown，不要解释，不要省略字段。`,
          },
        ],
        {
          model: activeModel,
          signal: abort.signal,
          maxTokens: LEARNING_GUIDE_MAX_TOKENS,
          usageFeature: 'analysis',
        },
      );
      const guide = parseLearningGuideJson({
        content: retryResponse.content,
        generatedAt: Date.now(),
        modelUsed: retryResponse.model,
        outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE,
      });
      return alignLearningGuideWithTimeline(
        { ...guide, outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE },
        input.analysis,
      );
    }
  } catch (error) {
    if (abort.signal.aborted) {
      throw new LearningGuideGenerationTimeoutError(LEARNING_GUIDE_GENERATION_TIMEOUT_MS);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
