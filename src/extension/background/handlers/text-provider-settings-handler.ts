/**
 * 文本 Provider 设置消息 handler。
 *
 * 处理 `GET_TEXT_PROVIDER_SETTINGS` / `SAVE_TEXT_PROVIDER_SETTINGS` /
 * `TEST_TEXT_PROVIDER_AUTH`。
 * 业务逻辑从 service-worker.ts 迁出；handler 不调用 chrome.*，依赖由工厂注入。
 */
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import {
  createTextProviderMissingMessage,
  getActiveTextProviderId,
  hasConfiguredTextProvider,
  type BaiServiceQuotaSnapshot,
  type PublicTextProviderSettings,
  type TextProviderSettings,
} from '@shared/settings';
import type { LanguageModelAuthTestResult } from '@core/llm/language-model-client';

/**
 * handler 接受的窄 request 类型；service-worker 顶层 switch 已分流，
 * 此处不再处理其它 type —— 也**不**做运行时 type 校验（TypeScript 已保证）。
 */
export type TextProviderSettingsRequest = Extract<
  ExtensionRequest,
  {
    type:
      | 'GET_TEXT_PROVIDER_SETTINGS'
      | 'SAVE_TEXT_PROVIDER_SETTINGS'
      | 'TEST_TEXT_PROVIDER_AUTH'
      | 'GET_BAI_SERVICE_QUOTA';
  }
>;

export interface TextProviderSettingsHandlerDeps {
  readonly readSettings: () => Promise<TextProviderSettings>;
  readonly readPublicSettings: () => Promise<PublicTextProviderSettings>;
  readonly saveSettings: (settings: TextProviderSettings) => Promise<void>;
  readonly testAuth: (settings: TextProviderSettings) => Promise<LanguageModelAuthTestResult>;
  readonly getBaiServiceQuota: (settings: TextProviderSettings) => Promise<BaiServiceQuotaSnapshot>;
  readonly createErrorResponse: (code: string, message: string) => ExtensionResponse;
}

export type TextProviderSettingsHandler = (
  request: TextProviderSettingsRequest,
) => Promise<ExtensionResponse>;

/**
 * 工厂：依赖在模块初始化时组装一次，service-worker 持有闭包；
 * 后续消息分发只调用 `handleTextProviderSettingsMessage(request)`，不再重新构造依赖。
 */
export function createTextProviderSettingsHandler(
  deps: TextProviderSettingsHandlerDeps,
): TextProviderSettingsHandler {
  return async (request) => {
    switch (request.type) {
      case 'GET_TEXT_PROVIDER_SETTINGS':
        return {
          ok: true,
          type: 'TEXT_PROVIDER_SETTINGS',
          payload: await deps.readPublicSettings(),
        };

      case 'SAVE_TEXT_PROVIDER_SETTINGS':
        await deps.saveSettings(await resolveProviderSecrets(request.payload, deps));
        return { ok: true, type: 'DONE' };

      case 'TEST_TEXT_PROVIDER_AUTH': {
        const settings = request.payload
          ? await resolveProviderSecrets(request.payload, deps)
          : await deps.readSettings();
        if (!hasConfiguredTextProvider(settings)) {
          return deps.createErrorResponse(
            'MINIMAX_API_KEY_MISSING',
            createTextProviderMissingMessage(settings),
          );
        }
        const result = await deps.testAuth(settings);
        return { ok: true, type: 'TEXT_PROVIDER_AUTH_TEST', payload: result };
      }

      case 'GET_BAI_SERVICE_QUOTA': {
        const settings = request.payload
          ? await resolveProviderSecrets(request.payload, deps)
          : await deps.readSettings();
        if (getActiveTextProviderId(settings) !== 'bai-service') {
          return deps.createErrorResponse('BAI_SERVICE_NOT_ACTIVE', '当前未选择 bAI 免费服务。');
        }
        if (!hasConfiguredTextProvider(settings)) {
          return deps.createErrorResponse(
            'BAI_SERVICE_INVITE_MISSING',
            createTextProviderMissingMessage(settings),
          );
        }
        return {
          ok: true,
          type: 'BAI_SERVICE_QUOTA',
          payload: await deps.getBaiServiceQuota(settings),
        };
      }
    }
  };
}

/**
 * payload apiKey 非空 → 原样；为空 → 用已存 apiKey 填充。
 */
async function resolveProviderSecrets(
  incoming: TextProviderSettings,
  deps: Pick<TextProviderSettingsHandlerDeps, 'readSettings'>,
): Promise<TextProviderSettings> {
  const incomingOpen = incoming.openAiCompatible;
  const incomingBaiService = incoming.baiService;
  const shouldReadExisting =
    !incoming.apiKey.trim() ||
    (incomingOpen !== undefined && !incomingOpen.apiKey.trim()) ||
    (incomingBaiService !== undefined &&
      (!incomingBaiService.inviteCode.trim() || !incomingBaiService.accessToken.trim()));

  if (!shouldReadExisting) {
    return incoming;
  }

  const existing = await deps.readSettings();
  const withMiniMaxKey = incoming.apiKey.trim()
    ? incoming
    : { ...incoming, apiKey: existing.apiKey };

  const resolvedIncomingOpen = withMiniMaxKey.openAiCompatible;
  const existingOpen = existing.openAiCompatible;
  const withOpenAiKey =
    resolvedIncomingOpen &&
    existingOpen &&
    resolvedIncomingOpen.providerId === existingOpen.providerId &&
    !resolvedIncomingOpen.apiKey.trim()
      ? {
          ...withMiniMaxKey,
          openAiCompatible: {
            ...resolvedIncomingOpen,
            apiKey: existingOpen.apiKey,
          },
        }
      : withMiniMaxKey;

  const resolvedIncomingBaiService = withOpenAiKey.baiService;
  const existingBaiService = existing.baiService;
  if (!resolvedIncomingBaiService || !existingBaiService) {
    return withOpenAiKey;
  }

  const incomingInviteCode = resolvedIncomingBaiService.inviteCode.trim();
  const existingInviteCode = existingBaiService.inviteCode.trim();
  const incomingAccessToken = resolvedIncomingBaiService.accessToken.trim();
  const canReuseExistingBaiToken =
    !incomingInviteCode || incomingInviteCode === existingInviteCode;
  const resolvedBaiAccessToken = incomingAccessToken
    ? resolvedIncomingBaiService.accessToken
    : canReuseExistingBaiToken
      ? existingBaiService.accessToken
      : '';
  const resolvedBaiTokenExpiresAt = incomingAccessToken
    ? resolvedIncomingBaiService.tokenExpiresAt
    : canReuseExistingBaiToken
      ? existingBaiService.tokenExpiresAt
      : undefined;
  const resolvedBaiServiceWithoutTokenExpiry = { ...resolvedIncomingBaiService };
  delete resolvedBaiServiceWithoutTokenExpiry.tokenExpiresAt;

  return {
    ...withOpenAiKey,
    baiService: {
      ...resolvedBaiServiceWithoutTokenExpiry,
      inviteCode: incomingInviteCode
        ? resolvedIncomingBaiService.inviteCode
        : existingBaiService.inviteCode,
      accessToken: resolvedBaiAccessToken,
      ...(resolvedBaiTokenExpiresAt ? { tokenExpiresAt: resolvedBaiTokenExpiresAt } : {}),
    },
  };
}
