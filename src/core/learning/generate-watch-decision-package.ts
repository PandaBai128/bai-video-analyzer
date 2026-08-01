import { createLanguageModelClient } from '@core/llm/language-model-factory';
import { LanguageModelStreamUnsupportedError } from '@core/llm/language-model-client';
import { buildWatchDecisionPackagePrompt } from '@core/prompts/watch-decision-package';
import type { LearningSession, SubtitleCue, VideoMetadata } from '@core/types';
import type { TextProviderSettings } from '@shared/settings';
import { getActiveTextModel } from '@shared/settings';
import {
  LearningGuideGenerationTimeoutError,
  LEARNING_GUIDE_GENERATION_TIMEOUT_MS,
} from './generate-learning-guide';
import { createContentContextDigest } from './content-context-digest';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@shared/locale-settings';
import {
  parseWatchDecisionPackageJson,
  type WatchDecisionPackage,
} from './watch-decision-package-schema';

export const WATCH_DECISION_PACKAGE_MAX_TOKENS = 8192;

export async function generateWatchDecisionPackage(input: {
  readonly settings: TextProviderSettings;
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly session: LearningSession;
  readonly outputLocale?: UiLocale;
  readonly signal?: AbortSignal;
}): Promise<WatchDecisionPackage> {
  const abort = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, LEARNING_GUIDE_GENERATION_TIMEOUT_MS);
  const abortFromInput = (): void => abort.abort();
  if (input.signal?.aborted) {
    abort.abort();
  } else {
    input.signal?.addEventListener('abort', abortFromInput, { once: true });
  }
  const contextDigest = createContentContextDigest({
    metadata: input.metadata,
    transcriptCues: input.transcriptCues,
  });

  try {
    const response = await createLanguageModelClient(input.settings).chat(
      [
        {
          role: 'user',
          content: buildWatchDecisionPackagePrompt(input),
        },
      ],
      {
        model: getActiveTextModel(input.settings),
        signal: abort.signal,
        maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
        usageFeature: 'analysis',
      },
    );
    const parsed = parseWatchDecisionPackageJson({
      content: response.content,
      metadata: input.metadata,
      transcriptCues: input.transcriptCues,
      generatedAt: Date.now(),
      modelUsed: response.model,
      contextDigest,
      outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE,
    });
    const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
    return {
      analysis: { ...parsed.analysis, outputLocale },
      guide: { ...parsed.guide, outputLocale },
    };
  } catch (error) {
    if (abort.signal.aborted) {
      if (timedOut) {
        throw new LearningGuideGenerationTimeoutError(LEARNING_GUIDE_GENERATION_TIMEOUT_MS);
      }
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromInput);
  }
}

export async function generateWatchDecisionPackageStream(input: {
  readonly settings: TextProviderSettings;
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly session: LearningSession;
  readonly outputLocale?: UiLocale;
  readonly signal: AbortSignal;
  readonly fallbackToNonStream?: boolean;
  readonly onStatus?: (text: string) => void;
  readonly onChunk?: (chunk: {
    readonly text: string;
    readonly receivedCharacters: number;
  }) => void;
}): Promise<WatchDecisionPackage> {
  const contextDigest = createContentContextDigest({
    metadata: input.metadata,
    transcriptCues: input.transcriptCues,
  });
  const prompt = buildWatchDecisionPackagePrompt(input);
  const client = createLanguageModelClient(input.settings);
  const activeModel = getActiveTextModel(input.settings);
  const fallbackToNonStream = input.fallbackToNonStream ?? true;

  let content = '';
  let modelUsed = activeModel;
  let usedNonStreamFallback = false;

  try {
    for await (const chunk of client.streamChat(
      [
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: activeModel,
        signal: input.signal,
        maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
        usageFeature: 'analysis',
      },
    )) {
      if (input.signal.aborted) {
        throw new LearningGuideGenerationTimeoutError(LEARNING_GUIDE_GENERATION_TIMEOUT_MS);
      }
      if (!chunk.text) continue;
      content += chunk.text;
      input.onChunk?.({ text: chunk.text, receivedCharacters: content.length });
    }
  } catch (error) {
    if (input.signal.aborted) {
      throw new LearningGuideGenerationTimeoutError(LEARNING_GUIDE_GENERATION_TIMEOUT_MS);
    }
    if (error instanceof LanguageModelStreamUnsupportedError && fallbackToNonStream) {
      input.onStatus?.('流式输出不可用，已切换为普通生成');
      const response = await client.chat(
        [
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          model: activeModel,
          signal: input.signal,
          maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
          usageFeature: 'analysis',
        },
      );
      usedNonStreamFallback = true;
      content = response.content;
      modelUsed = response.model;
      if (content) {
        input.onChunk?.({ text: content, receivedCharacters: content.length });
      }
    } else {
      throw error;
    }
  }

  if (!content.trim() && fallbackToNonStream) {
    input.onStatus?.('流式输出为空，已切换为普通生成');
    const response = await client.chat(
      [
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: activeModel,
        signal: input.signal,
        maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
        usageFeature: 'analysis',
      },
    );
    usedNonStreamFallback = true;
    content = response.content;
    modelUsed = response.model;
    if (content) {
      input.onChunk?.({ text: content, receivedCharacters: content.length });
    }
  }

  try {
    const parsed = parseWatchDecisionPackageJson({
      content,
      metadata: input.metadata,
      transcriptCues: input.transcriptCues,
      generatedAt: Date.now(),
      modelUsed,
      contextDigest,
      outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE,
    });
    const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
    return {
      analysis: { ...parsed.analysis, outputLocale },
      guide: { ...parsed.guide, outputLocale },
    };
  } catch (error) {
    if (!fallbackToNonStream || usedNonStreamFallback || input.signal.aborted) {
      throw error;
    }
    input.onStatus?.('流式结果格式异常，已切换为普通生成');
    const response = await client.chat(
      [
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: activeModel,
        signal: input.signal,
        maxTokens: WATCH_DECISION_PACKAGE_MAX_TOKENS,
        usageFeature: 'analysis',
      },
    );
    content = response.content;
    modelUsed = response.model;
    if (content) {
      input.onChunk?.({ text: content, receivedCharacters: content.length });
    }
    const parsed = parseWatchDecisionPackageJson({
      content,
      metadata: input.metadata,
      transcriptCues: input.transcriptCues,
      generatedAt: Date.now(),
      modelUsed,
      contextDigest,
      outputLocale: input.outputLocale ?? DEFAULT_UI_LOCALE,
    });
    const outputLocale = input.outputLocale ?? DEFAULT_UI_LOCALE;
    return {
      analysis: { ...parsed.analysis, outputLocale },
      guide: { ...parsed.guide, outputLocale },
    };
  }
}
