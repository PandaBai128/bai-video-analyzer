import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BAI_SERVICE_MODEL,
  DEFAULT_BAI_SERVICE_URL,
  DEFAULT_MINIMAX_FAST_MODEL,
  LANGUAGE_MODEL_PROVIDER_PRESETS,
  MINIMAX_FAST_MODEL_OPTIONS,
  SETTINGS_KEYS,
  createDefaultTextProviderSettings,
  createTextProviderMissingMessage,
  getActiveTextModel,
  getActiveTextProviderId,
  getEffectiveBaiServiceSettings,
  getEffectiveOpenAiCompatibleSettings,
  hasConfiguredTextProvider,
  isLanguageModelProviderId,
  isOpenAiCompatibleProviderId,
  isValidFastModel,
  migrateTextProviderSettings,
  normalizeMinimaxBaseUrl,
  normalizeOpenAiCompatibleBaseUrl,
  toPublicTextProviderSettings,
} from '@shared/settings';

describe('Text provider settings', () => {
  it('uses the neutral storage key for text provider settings', () => {
    expect(SETTINGS_KEYS.textProvider).toBe('settings.textProvider');
  });

  it('supports the neutral migration helpers for non-MiniMax providers', () => {
    const settings = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'deepseek',
      openAiCompatible: {
        providerId: 'deepseek',
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com/',
        model: 'deepseek-v4-flash',
      },
    });

    expect(getActiveTextProviderId(settings)).toBe('deepseek');
    expect(getActiveTextModel(settings)).toBe('deepseek-v4-flash');
    expect(toPublicTextProviderSettings(settings).openAiCompatible).toEqual({
      providerId: 'deepseek',
      hasApiKey: true,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
  });
});

describe('Text provider settings migration', () => {
  it('returns defaults for empty input (new user gets M2.7-highspeed fast model)', () => {
    const settings = migrateTextProviderSettings(undefined);
    // 完全空的 storage 必须是 fallback fastModel（M2.7-highspeed），不依赖 fallback.model
    const expected: ReturnType<typeof migrateTextProviderSettings> =
      createDefaultTextProviderSettings();
    expect(settings.fastModel).toBe(DEFAULT_MINIMAX_FAST_MODEL);
    // 容忍时间戳差异
    expect({ ...settings, updatedAt: expected.updatedAt }).toEqual(expected);
  });

  it('returns defaults for null input (new user gets M2.7-highspeed fast model)', () => {
    const settings = migrateTextProviderSettings(null);
    expect(settings.fastModel).toBe(DEFAULT_MINIMAX_FAST_MODEL);
  });

  it('defaults webSearchEnabled to false', () => {
    const settings = migrateTextProviderSettings(undefined);
    expect(settings.webSearchEnabled).toBe(false);
  });

  it('defaults text provider to MiniMax and seeds OpenAI-compatible defaults', () => {
    const settings = migrateTextProviderSettings(undefined);
    expect(getActiveTextProviderId(settings)).toBe('minimax');
    expect(getActiveTextModel(settings)).toBe(DEFAULT_MINIMAX_FAST_MODEL);
    expect(settings.openAiCompatible).toEqual({
      providerId: 'deepseek',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    expect(settings.baiService).toEqual({
      serviceUrl: DEFAULT_BAI_SERVICE_URL,
      inviteCode: '',
      accessToken: '',
      model: DEFAULT_BAI_SERVICE_MODEL,
    });
  });

  it('preserves existing fastModel when valid', () => {
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      fastModel: 'MiniMax-M3',
      analysisMode: 'subtitle',
      thinkingMode: 'disabled',
      updatedAt: 1_700_000_000,
    });

    expect(settings.fastModel).toBe('MiniMax-M3');
    expect(settings.analysisMode).toBe('subtitle');
  });

  it('migrates legacy settings with model=MiniMax-M3 to fastModel=M3', () => {
    // 模拟旧版本：没有 fastModel 字段，但 model 是 M3
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      analysisMode: 'subtitle',
      thinkingMode: 'enabled',
    } as never);

    expect(settings.fastModel).toBe('MiniMax-M3');
    expect(settings.model).toBe('MiniMax-M3');
    expect(settings.analysisMode).toBe('subtitle');
  });

  it('drops legacy auto analysisMode and falls back to subtitle', () => {
    // 旧版本 analysisMode='auto' 已经被彻底删除，遇到则归到 'subtitle'（快速分析）
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      analysisMode: 'auto',
    } as never);

    expect(settings.analysisMode).toBe('subtitle');
  });

  it('drops unknown analysisMode values and falls back to subtitle', () => {
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      analysisMode: 'something-else',
    } as never);

    expect(settings.analysisMode).toBe('subtitle');
  });

  it('drops paused transcript analysisMode and falls back to subtitle', () => {
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      analysisMode: 'transcript',
    } as never);

    expect(settings.analysisMode).toBe('subtitle');
  });

  it('migrates legacy settings with non-M3 model to fastModel=M2.7-highspeed (fallback)', () => {
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'some-custom-model',
      analysisMode: 'subtitle',
    } as never);

    expect(settings.fastModel).toBe(DEFAULT_MINIMAX_FAST_MODEL);
  });

  it('falls back to M3 when fastModel is invalid string but stored model is M3 (legacy explicit choice)', () => {
    // 旧 storage 显式存了 model=M3 但 fastModel 字段被改坏（譬如迁移脚本出 bug），
    // 应该保留用户的 M3 选择意图
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      fastModel: 'MiniMax-M4-unknown',
      analysisMode: 'subtitle',
    } as never);

    expect(settings.fastModel).toBe('MiniMax-M3');
  });

  it('falls back to M2.7-highspeed when fastModel is invalid string and stored model is non-M3', () => {
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'some-custom-model',
      fastModel: 'MiniMax-M4-unknown',
      analysisMode: 'subtitle',
    } as never);

    expect(settings.fastModel).toBe(DEFAULT_MINIMAX_FAST_MODEL);
  });

  it('normalizes base URL with trailing slashes without changing the configured domain', () => {
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com////',
      model: 'MiniMax-M3',
      analysisMode: 'subtitle',
    } as never);

    expect(settings.baseUrl).toBe('https://api.minimaxi.com');
  });

  it('normalizes OpenAI-compatible /v1 base URL to the native endpoint origin', () => {
    expect(normalizeMinimaxBaseUrl('https://api.minimaxi.com/v1')).toBe('https://api.minimaxi.com');
    expect(normalizeMinimaxBaseUrl('https://api.minimaxi.com/v1////')).toBe(
      'https://api.minimaxi.com',
    );

    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com/v1',
      model: 'MiniMax-M3',
      analysisMode: 'subtitle',
    } as never);

    expect(settings.baseUrl).toBe('https://api.minimaxi.com');
  });

  it('migrates legacy .io MiniMax base URL back to the verified .com domain', () => {
    expect(normalizeMinimaxBaseUrl('https://api.minimax.io')).toBe('https://api.minimaxi.com');
    expect(normalizeMinimaxBaseUrl('https://api.minimax.io/v1')).toBe('https://api.minimaxi.com');

    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimax.io',
      model: 'MiniMax-M3',
      analysisMode: 'subtitle',
    } as never);

    expect(settings.baseUrl).toBe('https://api.minimaxi.com');
  });

  it('preserves explicitly stored MiniMax base URL instead of forcing a domain migration', () => {
    const settings = migrateTextProviderSettings({
      apiKey: 'sk-test',
      baseUrl: 'https://api.minimaxi.com',
      model: 'MiniMax-M3',
      analysisMode: 'subtitle',
    } as never);

    expect(settings.baseUrl).toBe('https://api.minimaxi.com');
  });

  it('keeps fastModel field through round-trip', () => {
    const initial = {
      ...createDefaultTextProviderSettings(),
      apiKey: 'sk-test',
      fastModel: 'MiniMax-M3' as const,
    };

    const migrated = migrateTextProviderSettings(initial);
    expect(migrated.fastModel).toBe('MiniMax-M3');
  });

  it('keeps webSearchEnabled through migration and public settings', () => {
    const migrated = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      webSearchEnabled: true,
    });

    expect(migrated.webSearchEnabled).toBe(true);
    expect(toPublicTextProviderSettings(migrated).webSearchEnabled).toBe(true);
  });

  it('migrates OpenAI-compatible provider settings without leaking API key publicly', () => {
    const migrated = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'qwen',
      openAiCompatible: {
        providerId: 'qwen',
        apiKey: 'dashscope-key',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
        model: 'qwen-plus',
      },
    });

    expect(getActiveTextProviderId(migrated)).toBe('qwen');
    expect(getActiveTextModel(migrated)).toBe('qwen-plus');
    expect(getEffectiveOpenAiCompatibleSettings(migrated)).toEqual({
      providerId: 'qwen',
      apiKey: 'dashscope-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
    });

    const publicSettings = toPublicTextProviderSettings(migrated);
    expect(publicSettings.openAiCompatible).toEqual({
      providerId: 'qwen',
      hasApiKey: true,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
    });
    expect('apiKey' in (publicSettings.openAiCompatible ?? {})).toBe(false);
  });

  it('preserves legacy custom OpenAI-compatible provider settings', () => {
    const migrated = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'custom-openai-compatible',
      openAiCompatible: {
        providerId: 'custom-openai-compatible',
        apiKey: 'custom-key',
        baseUrl: 'https://llm.example.com/v1/',
        model: 'custom-chat-model',
      },
    });

    expect(getActiveTextProviderId(migrated)).toBe('custom-openai-compatible');
    expect(getEffectiveOpenAiCompatibleSettings(migrated)).toEqual({
      providerId: 'custom-openai-compatible',
      apiKey: 'custom-key',
      baseUrl: 'https://llm.example.com/v1',
      model: 'custom-chat-model',
    });
    expect(getActiveTextModel(migrated)).toBe('custom-chat-model');
  });

  it('prefers active OpenAI-compatible provider over stale stored provider settings', () => {
    const migrated = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'qwen',
      openAiCompatible: {
        providerId: 'deepseek',
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      },
    });

    expect(getActiveTextProviderId(migrated)).toBe('qwen');
    expect(getEffectiveOpenAiCompatibleSettings(migrated)).toEqual({
      providerId: 'qwen',
      apiKey: '',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
    });
    expect(getActiveTextModel(migrated)).toBe('qwen-plus');
  });

  it('falls back to stored OpenAI-compatible provider when active provider is MiniMax', () => {
    const migrated = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'minimax',
      openAiCompatible: {
        providerId: 'deepseek',
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      },
    });

    expect(getActiveTextProviderId(migrated)).toBe('minimax');
    expect(getEffectiveOpenAiCompatibleSettings(migrated).providerId).toBe('deepseek');
    expect(getEffectiveOpenAiCompatibleSettings(migrated).apiKey).toBe('deepseek-key');
  });

  it('migrates bAI service settings without exposing invite code publicly', () => {
    const migrated = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'bai-service',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun///',
        inviteCode: 'bai-demo',
        accessToken: 'saved-token',
        tokenExpiresAt: '2026-07-06T00:00:00.000Z',
        model: 'bai-route-a',
      },
    });

    expect(getActiveTextProviderId(migrated)).toBe('bai-service');
    expect(getActiveTextModel(migrated)).toBe('bai-route-a');
    expect(getEffectiveBaiServiceSettings(migrated)).toEqual({
      serviceUrl: 'http://io2477kl7316.vicp.fun',
      inviteCode: 'bai-demo',
      accessToken: 'saved-token',
      tokenExpiresAt: '2026-07-06T00:00:00.000Z',
      model: 'bai-route-a',
    });

    const publicSettings = toPublicTextProviderSettings(migrated);
    expect(publicSettings.baiService).toEqual({
      hasInviteCode: true,
      hasAccessToken: true,
      tokenExpiresAt: '2026-07-06T00:00:00.000Z',
    });
    expect('inviteCode' in (publicSettings.baiService ?? {})).toBe(false);
    expect('accessToken' in (publicSettings.baiService ?? {})).toBe(false);
    expect('serviceUrl' in (publicSettings.baiService ?? {})).toBe(false);
    expect('model' in (publicSettings.baiService ?? {})).toBe(false);
  });

  it('validates configured text provider by active provider', () => {
    const minimax = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      apiKey: 'minimax-key',
    });
    expect(hasConfiguredTextProvider(minimax)).toBe(true);

    const missingDefaultProvider = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      apiKey: '',
    });
    expect(hasConfiguredTextProvider(missingDefaultProvider)).toBe(false);
    expect(createTextProviderMissingMessage(missingDefaultProvider)).toBe(
      '请先在设置中配置当前文本模型 API Key',
    );

    const deepseek = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'deepseek',
      openAiCompatible: {
        providerId: 'deepseek',
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      },
    });
    expect(hasConfiguredTextProvider(deepseek)).toBe(true);

    const baiService = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'bai-service',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun',
        inviteCode: 'bai-demo',
        accessToken: '',
        model: 'bai-service',
      },
    });
    expect(hasConfiguredTextProvider(baiService)).toBe(true);

    const missingModel = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'openai',
      openAiCompatible: {
        providerId: 'openai',
        apiKey: 'openai-key',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
      },
    });
    expect(hasConfiguredTextProvider(missingModel)).toBe(false);
    expect(createTextProviderMissingMessage(missingModel)).toBe(
      '请先在设置中填写 OpenAI 的模型名称。',
    );

    const missingBaiInvite = migrateTextProviderSettings({
      ...createDefaultTextProviderSettings(),
      activeTextProvider: 'bai-service',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun',
        inviteCode: '',
        accessToken: '',
        model: 'bai-service',
      },
    });
    expect(hasConfiguredTextProvider(missingBaiInvite)).toBe(false);
    expect(createTextProviderMissingMessage(missingBaiInvite)).toBe(
      '请先在设置中填写 bAI 免费服务邀请码。',
    );
  });
});

describe('Minimax fast model whitelist', () => {
  it('only allows M2.7-highspeed and M3 as fast models', () => {
    expect(MINIMAX_FAST_MODEL_OPTIONS).toEqual(['MiniMax-M2.7-highspeed', 'MiniMax-M3']);
  });

  it('isValidFastModel accepts whitelist values', () => {
    expect(isValidFastModel('MiniMax-M2.7-highspeed')).toBe(true);
    expect(isValidFastModel('MiniMax-M3')).toBe(true);
  });

  it('isValidFastModel rejects everything else', () => {
    expect(isValidFastModel('MiniMax-M4')).toBe(false);
    expect(isValidFastModel('')).toBe(false);
    expect(isValidFastModel(null)).toBe(false);
    expect(isValidFastModel(undefined)).toBe(false);
    expect(isValidFastModel(123)).toBe(false);
  });
});

describe('language model provider presets', () => {
  it('contains the main provider presets', () => {
    expect(LANGUAGE_MODEL_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      'minimax',
      'bai-service',
      'deepseek',
      'qwen',
      'kimi',
      'glm',
      'baidu-qianfan',
      'tencent-hunyuan',
      'openai',
      'gemini',
      'claude',
      'custom-openai-compatible',
    ]);
    expect(
      LANGUAGE_MODEL_PROVIDER_PRESETS.find((preset) => preset.id === 'custom-openai-compatible'),
    ).toMatchObject({
      name: '自定义 OpenAI-compatible',
      baseUrl: '',
      defaultModel: '',
      requiresCustomModel: true,
      supportsThinkingControl: false,
      supportsBaiLabs: false,
    });
  });

  it('recognizes provider ids and OpenAI-compatible provider ids', () => {
    expect(isLanguageModelProviderId('minimax')).toBe(true);
    expect(isLanguageModelProviderId('bai-service')).toBe(true);
    expect(isLanguageModelProviderId('deepseek')).toBe(true);
    expect(isLanguageModelProviderId('custom-openai-compatible')).toBe(true);
    expect(isLanguageModelProviderId('unknown')).toBe(false);
    expect(isOpenAiCompatibleProviderId('minimax')).toBe(false);
    expect(isOpenAiCompatibleProviderId('bai-service')).toBe(false);
    expect(isOpenAiCompatibleProviderId('qwen')).toBe(true);
    expect(isOpenAiCompatibleProviderId('custom-openai-compatible')).toBe(true);
  });

  it('normalizes OpenAI-compatible base URL without removing provider-specific /v1 path', () => {
    expect(normalizeOpenAiCompatibleBaseUrl('https://api.deepseek.com////')).toBe(
      'https://api.deepseek.com',
    );
    expect(
      normalizeOpenAiCompatibleBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1////'),
    ).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });
});
