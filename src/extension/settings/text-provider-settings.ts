import {
  SETTINGS_KEYS,
  getActiveTextProviderId,
  getEffectiveBaiServiceSettings,
  getEffectiveOpenAiCompatibleSettings,
  isDefaultBaiServiceUrl,
  migrateTextProviderSettings,
  toPublicTextProviderSettings,
  type PublicTextProviderSettings,
  type TextProviderSettings,
} from '@shared/settings';

export async function readTextProviderSettings(): Promise<TextProviderSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEYS.textProvider);
  const stored = result[SETTINGS_KEYS.textProvider] as Partial<TextProviderSettings> | undefined;

  return migrateTextProviderSettings(stored);
}

export async function readPublicTextProviderSettings(): Promise<PublicTextProviderSettings> {
  return toPublicTextProviderSettings(await readTextProviderSettings());
}

export async function saveTextProviderSettings(settings: TextProviderSettings): Promise<void> {
  await assertLanguageModelHostPermission(settings);
  await chrome.storage.local.set({
    [SETTINGS_KEYS.textProvider]: {
      ...settings,
      updatedAt: Date.now(),
    },
  });
}

export async function assertLanguageModelHostPermission(
  settings: TextProviderSettings,
): Promise<void> {
  const originPattern = getLanguageModelHostPermissionPattern(settings);
  if (!originPattern) {
    return;
  }

  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) {
    return;
  }

  const alreadyGranted = await permissionsContains(originPattern);
  if (!alreadyGranted) {
    throw new Error(`尚未授权访问模型服务域名：${originPattern}。请在设置页点击保存或测试连接完成授权。`);
  }
}

export async function requestLanguageModelHostPermission(
  settings: TextProviderSettings,
): Promise<void> {
  const originPattern = getLanguageModelHostPermissionPattern(settings);
  if (!originPattern) {
    return;
  }

  if (
    typeof chrome === 'undefined' ||
    !chrome.permissions?.request
  ) {
    return;
  }

  const granted = await permissionsRequest(originPattern);
  if (!granted) {
    throw new Error(`尚未授权访问模型服务域名：${originPattern}`);
  }
}

export function getLanguageModelHostPermissionPattern(
  settings: TextProviderSettings,
): string | null {
  const activeProvider = getActiveTextProviderId(settings);
  if (activeProvider === 'minimax') {
    return null;
  }

  if (activeProvider === 'bai-service') {
    const baiService = getEffectiveBaiServiceSettings(settings);
    if (!baiService.serviceUrl.trim()) {
      return null;
    }
    return createHostPermissionPattern(baiService.serviceUrl, {
      allowPublicHttp: isDefaultBaiServiceUrl(baiService.serviceUrl),
    });
  }

  const openAi = getEffectiveOpenAiCompatibleSettings(settings);
  if (!openAi.baseUrl.trim()) {
    return null;
  }

  return createHostPermissionPattern(openAi.baseUrl);
}

export function createHostPermissionPattern(
  baseUrl: string,
  options: { readonly allowPublicHttp?: boolean } = {},
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('模型服务 Base URL 不是合法 URL。');
  }

  if (parsed.protocol === 'https:') {
    return `https://${parsed.hostname}/*`;
  }
  if (
    parsed.protocol === 'http:' &&
    (options.allowPublicHttp ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1')
  ) {
    return `http://${parsed.hostname}/*`;
  }
  throw new Error('模型服务 Base URL 只允许 https，或本地调试的 http://localhost / http://127.0.0.1。');
}

function permissionsContains(originPattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [originPattern] }, (result) => resolve(result));
  });
}

function permissionsRequest(originPattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: [originPattern] }, (result) => resolve(result));
  });
}
