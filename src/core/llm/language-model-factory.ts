import {
  getActiveTextProviderId,
  getEffectiveBaiServiceSettings,
  getEffectiveOpenAiCompatibleSettings,
  type TextProviderSettings,
} from '@shared/settings';
import { BaiServiceClient } from './bai-service-client';
import { MinimaxClient } from './minimax-client';
import { OpenAiCompatibleClient } from './openai-compatible-client';
import type { LanguageModelClient } from './language-model-client';

export function createLanguageModelClient(settings: TextProviderSettings): LanguageModelClient {
  const providerId = getActiveTextProviderId(settings);
  if (providerId === 'minimax') {
    return new MinimaxClient(settings);
  }
  if (providerId === 'bai-service') {
    return new BaiServiceClient(getEffectiveBaiServiceSettings(settings));
  }
  return new OpenAiCompatibleClient(getEffectiveOpenAiCompatibleSettings(settings));
}
