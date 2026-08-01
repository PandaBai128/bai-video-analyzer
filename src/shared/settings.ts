export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimaxi.com';
export const ALTERNATE_MINIMAX_BASE_URL = 'https://api.minimax.io';
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M3';
export const DEFAULT_MINIMAX_FAST_MODEL = 'MiniMax-M2.7-highspeed';
export const DEFAULT_BAI_SERVICE_URL = 'http://io2477kl7316.vicp.fun';
export const DEFAULT_BAI_SERVICE_MODEL = 'bai-service';

export type TextModelAccessMode = 'bai-free' | 'own-key';
export type AnalysisMode = 'subtitle';
export type LegacyAnalysisMode = AnalysisMode | 'auto' | 'transcript' | 'multimodal';
export type MinimaxThinkingMode = 'disabled' | 'enabled';
export type LanguageModelProviderId =
  | 'minimax'
  | 'bai-service'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'glm'
  | 'baidu-qianfan'
  | 'tencent-hunyuan'
  | 'openai'
  | 'gemini'
  | 'claude'
  | 'custom-openai-compatible';

export type OpenAiCompatibleProviderId = Exclude<
  LanguageModelProviderId,
  'minimax' | 'bai-service'
>;

export interface LanguageModelProviderPreset {
  readonly id: LanguageModelProviderId;
  readonly name: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly supportsStreaming: boolean;
  readonly supportsThinkingControl: boolean;
  readonly supportsBaiLabs: boolean;
  readonly requiresCustomModel?: boolean;
  readonly note?: string;
}

/** 快速分析可用的模型白名单。 */
export type MinimaxFastModel = 'MiniMax-M2.7-highspeed' | 'MiniMax-M3';

export const MINIMAX_FAST_MODEL_OPTIONS: readonly MinimaxFastModel[] = [
  'MiniMax-M2.7-highspeed',
  'MiniMax-M3',
];

export const LANGUAGE_MODEL_PROVIDER_PRESETS: readonly LanguageModelProviderPreset[] = [
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: DEFAULT_MINIMAX_BASE_URL,
    defaultModel: DEFAULT_MINIMAX_FAST_MODEL,
    supportsStreaming: true,
    supportsThinkingControl: true,
    supportsBaiLabs: true,
    note: '使用 bAI 已验证的 MiniMax 原生接口；联网搜索仅此 Provider 支持。',
  },
  {
    id: 'bai-service',
    name: 'bAI 免费服务',
    baseUrl: DEFAULT_BAI_SERVICE_URL,
    defaultModel: DEFAULT_BAI_SERVICE_MODEL,
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
    note: '使用 bAI 提供的免费后端服务；插件只保存邀请码和临时 token，不保存真实模型 API Key。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
  },
  {
    id: 'qwen',
    name: '通义千问 / Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.6',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.2',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
  },
  {
    id: 'baidu-qianfan',
    name: '百度千帆',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    defaultModel: '',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
    requiresCustomModel: true,
  },
  {
    id: 'tencent-hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: '',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
    requiresCustomModel: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
    requiresCustomModel: true,
    note: '第一版仅使用 Chat Completions，不接 Responses API。',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.5-flash',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
  },
  {
    id: 'claude',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: '',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
    requiresCustomModel: true,
    note: '使用 Anthropic 的 OpenAI SDK 兼容层；高级能力仍以 Claude 原生 API 为准。',
  },
  {
    id: 'custom-openai-compatible',
    name: '自定义 OpenAI-compatible',
    baseUrl: '',
    defaultModel: '',
    supportsStreaming: true,
    supportsThinkingControl: false,
    supportsBaiLabs: false,
    requiresCustomModel: true,
    note: '填写兼容 Chat Completions 的 Base URL、模型名和 API Key。',
  },
];

export interface OpenAiCompatibleSettings {
  readonly providerId: OpenAiCompatibleProviderId;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface PublicOpenAiCompatibleSettings {
  readonly providerId: OpenAiCompatibleProviderId;
  readonly hasApiKey: boolean;
  readonly baseUrl: string;
  readonly model: string;
}

export interface BaiServiceSettings {
  readonly serviceUrl: string;
  readonly inviteCode: string;
  readonly accessToken: string;
  readonly tokenExpiresAt?: string;
  readonly model: string;
}

export interface PublicBaiServiceSettings {
  readonly hasInviteCode: boolean;
  readonly hasAccessToken: boolean;
  readonly tokenExpiresAt?: string;
}

export interface BaiServiceQuotaWindow {
  readonly limit: number | null;
  readonly used: number;
  readonly remaining: number | null;
  readonly resetAt: string;
}

export interface BaiServiceQuotaSnapshot {
  readonly user: {
    readonly displayName: string;
    readonly status: 'active' | 'disabled';
  };
  readonly quota: {
    readonly daily: BaiServiceQuotaWindow;
    readonly weekly: BaiServiceQuotaWindow;
  };
  readonly service?: {
    readonly mode?: string;
    readonly upstreamConfigured?: boolean;
  };
}

export interface TextProviderSettings {
  /** 顶层使用方式：bAI 免费服务或用户自己的模型 Key。 */
  readonly textModelAccessMode?: TextModelAccessMode;
  readonly apiKey: string;
  readonly baseUrl: string;
  /**
   * 历史字段：单模型配置。当前 MiniMax 原生分支以 `fastModel` 为准；
   * 任何调用点都不应该再读它来判断"用哪个模型"。
   */
  readonly model: string;
  /** 快速分析模型。可在 M2.7-highspeed 和 M3 之间切换。 */
  readonly fastModel: MinimaxFastModel;
  readonly analysisMode: AnalysisMode;
  readonly thinkingMode: MinimaxThinkingMode;
  /** 实验室功能：是否允许在追问里调用 MiniMax 联网搜索。默认关闭。 */
  readonly webSearchEnabled: boolean;
  /** 文本主链路使用的 Provider。缺省使用 MiniMax 原生 Provider。 */
  readonly activeTextProvider?: LanguageModelProviderId;
  /** 非 MiniMax Provider 统一走 OpenAI-compatible Chat Completions。 */
  readonly openAiCompatible?: OpenAiCompatibleSettings;
  /** bAI 服务模式：邀请码换 token 后由 NAS/服务端保管真实模型 Key。 */
  readonly baiService?: BaiServiceSettings;
  readonly updatedAt: number;
}

export interface PublicTextProviderSettings {
  readonly textModelAccessMode: TextModelAccessMode;
  readonly hasApiKey: boolean;
  readonly baseUrl: string;
  readonly model: string;
  readonly fastModel: MinimaxFastModel;
  readonly analysisMode: AnalysisMode;
  readonly thinkingMode: MinimaxThinkingMode;
  readonly webSearchEnabled: boolean;
  readonly activeTextProvider?: LanguageModelProviderId;
  readonly openAiCompatible?: PublicOpenAiCompatibleSettings;
  readonly baiService?: PublicBaiServiceSettings;
  readonly updatedAt?: number;
}

export const SETTINGS_KEYS = {
  textProvider: 'settings.textProvider',
} as const;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl);
}

export function normalizeBaiServiceUrl(serviceUrl: string): string {
  return normalizeBaseUrl(serviceUrl);
}

export function isDefaultBaiServiceUrl(serviceUrl: string): boolean {
  return normalizeBaiServiceUrl(serviceUrl) === normalizeBaiServiceUrl(DEFAULT_BAI_SERVICE_URL);
}

export function normalizeMinimaxBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  // 设置页保存的是 MiniMax 原生 v2 接口的 origin。官网 OpenAI-compatible 示例常写
  // OPENAI_BASE_URL=https://api.minimaxi.com/v1；这里若照填，客户端再拼
  // /v1/text/chatcompletion_v2 会变成重复 /v1。
  const withoutOpenAiCompatiblePath = normalized.replace(/\/v1$/i, '');
  // `.io` 是上一轮联网搜索排查中误写进配置的域名；MiniMax 语言模型主链路固定回到
  // `.com`，旧 storage 读出来时直接迁回默认值，避免设置页继续显示错误域名。
  if (withoutOpenAiCompatiblePath === ALTERNATE_MINIMAX_BASE_URL) {
    return DEFAULT_MINIMAX_BASE_URL;
  }
  return withoutOpenAiCompatiblePath;
}

export function createDefaultTextProviderSettings(): TextProviderSettings {
  return {
    textModelAccessMode: 'own-key',
    apiKey: '',
    baseUrl: DEFAULT_MINIMAX_BASE_URL,
    model: DEFAULT_MINIMAX_MODEL,
    fastModel: DEFAULT_MINIMAX_FAST_MODEL,
    analysisMode: 'subtitle',
    thinkingMode: 'disabled',
    webSearchEnabled: false,
    activeTextProvider: 'minimax',
    openAiCompatible: createDefaultOpenAiCompatibleSettings('deepseek'),
    baiService: createDefaultBaiServiceSettings(),
    updatedAt: Date.now(),
  };
}

export function isTextModelAccessMode(value: unknown): value is TextModelAccessMode {
  return value === 'bai-free' || value === 'own-key';
}

export function isValidFastModel(value: unknown): value is MinimaxFastModel {
  return value === 'MiniMax-M2.7-highspeed' || value === 'MiniMax-M3';
}

export function isLanguageModelProviderId(value: unknown): value is LanguageModelProviderId {
  return (
    typeof value === 'string' &&
    LANGUAGE_MODEL_PROVIDER_PRESETS.some((preset) => preset.id === value)
  );
}

export function isOpenAiCompatibleProviderId(value: unknown): value is OpenAiCompatibleProviderId {
  return isLanguageModelProviderId(value) && value !== 'minimax' && value !== 'bai-service';
}

export function getLanguageModelProviderPreset(
  providerId: LanguageModelProviderId,
): LanguageModelProviderPreset {
  return (
    LANGUAGE_MODEL_PROVIDER_PRESETS.find((preset) => preset.id === providerId) ??
    LANGUAGE_MODEL_PROVIDER_PRESETS[0]!
  );
}

export function createDefaultOpenAiCompatibleSettings(
  providerId: OpenAiCompatibleProviderId,
): OpenAiCompatibleSettings {
  const preset = getLanguageModelProviderPreset(providerId);
  return {
    providerId,
    apiKey: '',
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
  };
}

export function createDefaultBaiServiceSettings(): BaiServiceSettings {
  return {
    serviceUrl: DEFAULT_BAI_SERVICE_URL,
    inviteCode: '',
    accessToken: '',
    model: DEFAULT_BAI_SERVICE_MODEL,
  };
}

export function migrateOpenAiCompatibleSettings(
  input: Partial<OpenAiCompatibleSettings> | undefined | null,
  activeProvider: LanguageModelProviderId = 'minimax',
): OpenAiCompatibleSettings {
  const inputProviderId = input?.providerId;
  const providerId = isOpenAiCompatibleProviderId(activeProvider)
    ? activeProvider
    : isOpenAiCompatibleProviderId(inputProviderId)
      ? inputProviderId
      : 'deepseek';
  const fallback = createDefaultOpenAiCompatibleSettings(providerId);
  const canReuseInput =
    input !== undefined &&
    input !== null &&
    (!isOpenAiCompatibleProviderId(inputProviderId) || inputProviderId === providerId);
  const source = canReuseInput ? input : undefined;
  return {
    providerId,
    apiKey: typeof source?.apiKey === 'string' ? source.apiKey : fallback.apiKey,
    baseUrl:
      typeof source?.baseUrl === 'string' && source.baseUrl.trim()
        ? normalizeOpenAiCompatibleBaseUrl(source.baseUrl)
        : fallback.baseUrl,
    model:
      typeof source?.model === 'string' && source.model.trim()
        ? source.model.trim()
        : fallback.model,
  };
}

export function getActiveTextProviderId(settings: TextProviderSettings): LanguageModelProviderId {
  return isLanguageModelProviderId(settings.activeTextProvider)
    ? settings.activeTextProvider
    : 'minimax';
}

export function getTextModelAccessMode(settings: TextProviderSettings): TextModelAccessMode {
  if (isTextModelAccessMode(settings.textModelAccessMode)) {
    return settings.textModelAccessMode;
  }
  return getActiveTextProviderId(settings) === 'bai-service' ? 'bai-free' : 'own-key';
}

export function getEffectiveOpenAiCompatibleSettings(
  settings: TextProviderSettings,
): OpenAiCompatibleSettings {
  return migrateOpenAiCompatibleSettings(
    settings.openAiCompatible,
    getActiveTextProviderId(settings),
  );
}

export function migrateBaiServiceSettings(
  input: Partial<BaiServiceSettings> | undefined | null,
): BaiServiceSettings {
  const fallback = createDefaultBaiServiceSettings();
  const serviceUrl =
    typeof input?.serviceUrl === 'string' && input.serviceUrl.trim()
      ? normalizeBaiServiceUrl(input.serviceUrl)
      : fallback.serviceUrl;
  const model =
    typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model;
  const tokenExpiresAt =
    typeof input?.tokenExpiresAt === 'string' && input.tokenExpiresAt.trim()
      ? input.tokenExpiresAt.trim()
      : undefined;

  return {
    serviceUrl,
    inviteCode: typeof input?.inviteCode === 'string' ? input.inviteCode : fallback.inviteCode,
    accessToken: typeof input?.accessToken === 'string' ? input.accessToken : fallback.accessToken,
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    model,
  };
}

export function getEffectiveBaiServiceSettings(settings: TextProviderSettings): BaiServiceSettings {
  return migrateBaiServiceSettings(settings.baiService);
}

export function getActiveTextModel(settings: TextProviderSettings): string {
  const providerId = getActiveTextProviderId(settings);
  if (providerId === 'minimax') {
    return settings.fastModel;
  }
  if (providerId === 'bai-service') {
    return getEffectiveBaiServiceSettings(settings).model;
  }
  return getEffectiveOpenAiCompatibleSettings(settings).model;
}

export function hasConfiguredTextProvider(settings: TextProviderSettings): boolean {
  const providerId = getActiveTextProviderId(settings);
  if (providerId === 'minimax') {
    return settings.apiKey.trim().length > 0;
  }
  if (providerId === 'bai-service') {
    const baiService = getEffectiveBaiServiceSettings(settings);
    return (
      baiService.serviceUrl.trim().length > 0 &&
      (baiService.inviteCode.trim().length > 0 || baiService.accessToken.trim().length > 0)
    );
  }
  const openAi = getEffectiveOpenAiCompatibleSettings(settings);
  return (
    openAi.apiKey.trim().length > 0 &&
    openAi.baseUrl.trim().length > 0 &&
    openAi.model.trim().length > 0
  );
}

export function createTextProviderMissingMessage(settings: TextProviderSettings): string {
  const providerId = getActiveTextProviderId(settings);
  if (providerId === 'minimax') {
    return '请先在设置中配置当前文本模型 API Key';
  }
  if (providerId === 'bai-service') {
    const baiService = getEffectiveBaiServiceSettings(settings);
    if (!baiService.serviceUrl.trim()) {
      return 'bAI 免费服务地址暂不可用，请稍后再试。';
    }
    return '请先在设置中填写 bAI 免费服务邀请码。';
  }
  const preset = getLanguageModelProviderPreset(providerId);
  const openAi = getEffectiveOpenAiCompatibleSettings(settings);
  if (!openAi.model.trim()) {
    return `请先在设置中填写 ${preset.name} 的模型名称。`;
  }
  if (!openAi.baseUrl.trim()) {
    return `请先在设置中填写 ${preset.name} 的 OpenAI-compatible Base URL。`;
  }
  return `请先在设置中配置 ${preset.name} API Key。`;
}

/**
 * 从 chrome.storage 读出来的部分字段补齐成完整 `TextProviderSettings`。
 *
 * 迁移策略：
 *  - 缺 `fastModel`：仅当 storage 显式存了 `model === 'MiniMax-M3'` 时推到 M3
 *    （保留老用户的选择）；其它情况（含空 storage）一律用 `fallback.fastModel`
 *    （`MiniMax-M2.7-highspeed`），**不再**从 `fallback.model` 推导——否则完全空
 *    storage 会被推到 M3，违反"快速分析默认 M2.7-highspeed"的契约。
 *  - 缺 `model`：默认 `MiniMax-M3`（保留旧字段占位，不再被任何调用点读）
 *  - 其他字段：缺啥补啥
 *
 * UI 读到部分字段不会崩，settings service 写入时已经带 fastModel。
 */
export function migrateTextProviderSettings(
  input: Partial<TextProviderSettings> | undefined | null,
): TextProviderSettings {
  const fallback = createDefaultTextProviderSettings();
  const stored = input ?? {};

  // 只在 storage **真的存了** model 字段时才把它当作用户的显式选择。
  // 空 storage / null storage 走 fallback.model 占位即可。
  const hasStoredModel = typeof stored.model === 'string' && stored.model.trim().length > 0;
  const rawModel = hasStoredModel ? stored.model : fallback.model;
  const rawFastModel: MinimaxFastModel = isValidFastModel(stored.fastModel)
    ? stored.fastModel
    : hasStoredModel && stored.model === 'MiniMax-M3'
      ? 'MiniMax-M3'
      : fallback.fastModel;
  const activeTextProvider = isLanguageModelProviderId(stored.activeTextProvider)
    ? stored.activeTextProvider
    : 'minimax';
  const textModelAccessMode = isTextModelAccessMode(stored.textModelAccessMode)
    ? stored.textModelAccessMode
    : activeTextProvider === 'bai-service'
      ? 'bai-free'
      : (fallback.textModelAccessMode ?? 'own-key');
  const rawAnalysisMode = (stored as { readonly analysisMode?: unknown }).analysisMode;

  return {
    textModelAccessMode,
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : fallback.apiKey,
    baseUrl:
      typeof stored.baseUrl === 'string' && stored.baseUrl.trim()
        ? normalizeMinimaxBaseUrl(stored.baseUrl)
        : fallback.baseUrl,
    model: rawModel,
    fastModel: rawFastModel,
    // 公开版只保留快速字幕分析。旧版本的 auto / transcript / multimodal
    // 一律迁回 subtitle，避免触发本地 helper 或视频理解实验链路。
    analysisMode: rawAnalysisMode === 'subtitle' ? rawAnalysisMode : fallback.analysisMode,
    thinkingMode: stored.thinkingMode ?? fallback.thinkingMode,
    webSearchEnabled: stored.webSearchEnabled === true,
    activeTextProvider,
    openAiCompatible: migrateOpenAiCompatibleSettings(stored.openAiCompatible, activeTextProvider),
    baiService: migrateBaiServiceSettings(stored.baiService),
    updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : fallback.updatedAt,
  };
}

export function toPublicTextProviderSettings(
  settings: TextProviderSettings,
): PublicTextProviderSettings {
  const openAiCompatible = getEffectiveOpenAiCompatibleSettings(settings);
  const baiService = getEffectiveBaiServiceSettings(settings);
  return {
    textModelAccessMode: getTextModelAccessMode(settings),
    hasApiKey: settings.apiKey.trim().length > 0,
    baseUrl: settings.baseUrl,
    model: settings.model,
    fastModel: settings.fastModel,
    analysisMode: settings.analysisMode,
    thinkingMode: settings.thinkingMode,
    webSearchEnabled: settings.webSearchEnabled,
    activeTextProvider: getActiveTextProviderId(settings),
    openAiCompatible: {
      providerId: openAiCompatible.providerId,
      hasApiKey: openAiCompatible.apiKey.trim().length > 0,
      baseUrl: openAiCompatible.baseUrl,
      model: openAiCompatible.model,
    },
    baiService: {
      hasInviteCode: baiService.inviteCode.trim().length > 0,
      hasAccessToken: baiService.accessToken.trim().length > 0,
      ...(baiService.tokenExpiresAt ? { tokenExpiresAt: baiService.tokenExpiresAt } : {}),
    },
    updatedAt: settings.updatedAt,
  };
}
