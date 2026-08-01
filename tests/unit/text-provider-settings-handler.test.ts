import { describe, expect, it, vi } from 'vitest';
import { createTextProviderSettingsHandler } from '@extension/background/handlers/text-provider-settings-handler';
import type {
  TextProviderSettingsHandlerDeps,
  TextProviderSettingsRequest,
} from '@extension/background/handlers/text-provider-settings-handler';
import type { PublicTextProviderSettings, TextProviderSettings } from '@shared/settings';
import { createErrorResponse } from '@shared/messages';
import type { LanguageModelAuthTestResult } from '@core/llm/language-model-client';

/** 构造一个固定的 settings 模板；测试按需覆盖 apiKey 字段。 */
function makeSettings(overrides: Partial<TextProviderSettings> = {}): TextProviderSettings {
  return {
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M2.7-highspeed',
    analysisMode: 'subtitle',
    thinkingMode: 'disabled',
    webSearchEnabled: false,
    updatedAt: 1,
    ...overrides,
  };
}

function makePublicSettings(): PublicTextProviderSettings {
  return {
    textModelAccessMode: 'own-key',
    hasApiKey: false,
    baseUrl: 'https://api.minimaxi.com',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M2.7-highspeed',
    analysisMode: 'subtitle',
    thinkingMode: 'disabled',
    webSearchEnabled: false,
  };
}

/** 最小依赖 mock：每个测试只覆盖它关心的部分，其余返回默认。 */
function makeDeps(
  overrides: Partial<TextProviderSettingsHandlerDeps> = {},
): TextProviderSettingsHandlerDeps {
  return {
    readSettings: vi.fn().mockResolvedValue(makeSettings({ apiKey: 'existing-key' })),
    readPublicSettings: vi.fn().mockResolvedValue(makePublicSettings()),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    testAuth: vi.fn().mockResolvedValue({
      message: 'ok',
      latencyMs: 42,
    } satisfies LanguageModelAuthTestResult),
    getBaiServiceQuota: vi.fn().mockResolvedValue({
      user: { displayName: '测试用户', status: 'active' },
      quota: {
        daily: {
          limit: 30,
          used: 1,
          remaining: 29,
          resetAt: '2026-07-07T00:00:00.000Z',
        },
        weekly: {
          limit: 120,
          used: 3,
          remaining: 117,
          resetAt: '2026-07-13T00:00:00.000Z',
        },
      },
    }),
    // 直接用真实的 createErrorResponse —— 测试不重新 mock 它的内部实现，
    // 避免 mock 形状与 `ExtensionResponse` 联合 type 漂移。
    createErrorResponse,
    ...overrides,
  };
}

describe('createTextProviderSettingsHandler', () => {
  it('GET_TEXT_PROVIDER_SETTINGS 返回 public settings（不暴露 API Key）', async () => {
    const deps = makeDeps();
    const handler = createTextProviderSettingsHandler(deps);
    const request: TextProviderSettingsRequest = { type: 'GET_TEXT_PROVIDER_SETTINGS' };

    const response = await handler(request);

    expect(response).toEqual({
      ok: true,
      type: 'TEXT_PROVIDER_SETTINGS',
      payload: makePublicSettings(),
    });
    expect(deps.readPublicSettings).toHaveBeenCalledTimes(1);
    // 反向断言：response payload **不**含 apiKey（Public settings 已脱敏）
    const responsePayload = (response as { payload: PublicTextProviderSettings }).payload;
    expect('apiKey' in responsePayload).toBe(false);
    expect('hasApiKey' in responsePayload).toBe(true);
  });

  it('SAVE_TEXT_PROVIDER_SETTINGS payload 含非空 Key → 直接保存', async () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ saveSettings });
    const handler = createTextProviderSettingsHandler(deps);
    const incoming = makeSettings({ apiKey: 'new-key' });
    const request: TextProviderSettingsRequest = {
      type: 'SAVE_TEXT_PROVIDER_SETTINGS',
      payload: incoming,
    };

    const response = await handler(request);

    expect(response).toEqual({ ok: true, type: 'DONE' });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith(incoming);
    // 反向断言：payload apiKey 非空时**不**触发 readSettings
    expect(deps.readSettings).not.toHaveBeenCalled();
  });

  it('SAVE_TEXT_PROVIDER_SETTINGS payload Key 为空 → 保留已存 Key', async () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const existing = makeSettings({ apiKey: 'preserved-key' });
    const deps = makeDeps({
      readSettings: vi.fn().mockResolvedValue(existing),
      saveSettings,
    });
    const handler = createTextProviderSettingsHandler(deps);
    const incoming = makeSettings({ apiKey: '' });
    const request: TextProviderSettingsRequest = {
      type: 'SAVE_TEXT_PROVIDER_SETTINGS',
      payload: incoming,
    };

    const response = await handler(request);

    expect(response).toEqual({ ok: true, type: 'DONE' });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({
      ...incoming,
      apiKey: 'preserved-key',
    });
    expect(deps.readSettings).toHaveBeenCalledTimes(1);
  });

  it('SAVE_TEXT_PROVIDER_SETTINGS OpenAI-compatible Key 为空且 Provider 相同 → 保留已存 Key', async () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const existing = makeSettings({
      openAiCompatible: {
        providerId: 'deepseek',
        apiKey: 'stored-openai-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      },
    });
    const deps = makeDeps({
      readSettings: vi.fn().mockResolvedValue(existing),
      saveSettings,
    });
    const handler = createTextProviderSettingsHandler(deps);
    const incoming = makeSettings({
      apiKey: 'mini-key',
      activeTextProvider: 'deepseek',
      openAiCompatible: {
        providerId: 'deepseek',
        apiKey: '',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      },
    });

    const response = await handler({
      type: 'SAVE_TEXT_PROVIDER_SETTINGS',
      payload: incoming,
    });

    expect(response).toEqual({ ok: true, type: 'DONE' });
    expect(saveSettings).toHaveBeenCalledWith({
      ...incoming,
      openAiCompatible: {
        ...incoming.openAiCompatible,
        apiKey: 'stored-openai-key',
      },
    });
  });

  it('SAVE_TEXT_PROVIDER_SETTINGS bAI 服务邀请码为空 → 保留已存邀请码和 token', async () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const existing = makeSettings({
      activeTextProvider: 'bai-service',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun',
        inviteCode: 'stored-invite',
        accessToken: 'stored-token',
        tokenExpiresAt: '2026-07-06T00:00:00.000Z',
        model: 'bai-service',
      },
    });
    const deps = makeDeps({
      readSettings: vi.fn().mockResolvedValue(existing),
      saveSettings,
    });
    const handler = createTextProviderSettingsHandler(deps);
    const incoming = makeSettings({
      activeTextProvider: 'bai-service',
      apiKey: 'mini-key',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun',
        inviteCode: '',
        accessToken: '',
        model: 'bai-service',
      },
    });

    const response = await handler({
      type: 'SAVE_TEXT_PROVIDER_SETTINGS',
      payload: incoming,
    });

    expect(response).toEqual({ ok: true, type: 'DONE' });
    expect(saveSettings).toHaveBeenCalledWith({
      ...incoming,
      baiService: {
        ...incoming.baiService,
        inviteCode: 'stored-invite',
        accessToken: 'stored-token',
        tokenExpiresAt: '2026-07-06T00:00:00.000Z',
      },
    });
  });

  it('SAVE_TEXT_PROVIDER_SETTINGS bAI 服务提交新邀请码 → 清空旧 token', async () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const existing = makeSettings({
      activeTextProvider: 'bai-service',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun',
        inviteCode: 'stored-invite',
        accessToken: 'stored-token',
        tokenExpiresAt: '2026-07-06T00:00:00.000Z',
        model: 'bai-service',
      },
    });
    const deps = makeDeps({
      readSettings: vi.fn().mockResolvedValue(existing),
      saveSettings,
    });
    const handler = createTextProviderSettingsHandler(deps);
    const incoming = makeSettings({
      activeTextProvider: 'bai-service',
      apiKey: 'mini-key',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun',
        inviteCode: 'new-invite',
        accessToken: '',
        model: 'bai-service',
      },
    });

    const response = await handler({
      type: 'SAVE_TEXT_PROVIDER_SETTINGS',
      payload: incoming,
    });

    expect(response).toEqual({ ok: true, type: 'DONE' });
    expect(saveSettings).toHaveBeenCalledWith({
      ...incoming,
      baiService: {
        ...incoming.baiService,
        accessToken: '',
      },
    });
  });

  it('TEST_TEXT_PROVIDER_AUTH 无 payload → 使用已存 settings', async () => {
    const existing = makeSettings({ apiKey: 'stored-key' });
    const testAuth = vi.fn().mockResolvedValue({
      message: 'ok',
      latencyMs: 100,
    } satisfies LanguageModelAuthTestResult);
    const deps = makeDeps({
      readSettings: vi.fn().mockResolvedValue(existing),
      testAuth,
    });
    const handler = createTextProviderSettingsHandler(deps);
    const request: TextProviderSettingsRequest = { type: 'TEST_TEXT_PROVIDER_AUTH' };

    const response = await handler(request);

    expect(response).toEqual({
      ok: true,
      type: 'TEXT_PROVIDER_AUTH_TEST',
      payload: { message: 'ok', latencyMs: 100 },
    });
    expect(testAuth).toHaveBeenCalledTimes(1);
    expect(testAuth).toHaveBeenCalledWith(existing);
    // 无 payload → **不**做合并，**不**调 readPublicSettings
    expect(deps.readPublicSettings).not.toHaveBeenCalled();
  });

  it('TEST_TEXT_PROVIDER_AUTH payload Key 为空 → 合并用已存 Key 再测试', async () => {
    const existing = makeSettings({ apiKey: 'preserved-key' });
    const testAuth = vi.fn().mockResolvedValue({
      message: 'ok',
      latencyMs: 50,
    } satisfies LanguageModelAuthTestResult);
    const deps = makeDeps({
      readSettings: vi.fn().mockResolvedValue(existing),
      testAuth,
    });
    const handler = createTextProviderSettingsHandler(deps);
    const incoming = makeSettings({ apiKey: '' });
    const request: TextProviderSettingsRequest = {
      type: 'TEST_TEXT_PROVIDER_AUTH',
      payload: incoming,
    };

    const response = await handler(request);

    expect(response).toEqual({
      ok: true,
      type: 'TEXT_PROVIDER_AUTH_TEST',
      payload: { message: 'ok', latencyMs: 50 },
    });
    expect(testAuth).toHaveBeenCalledTimes(1);
    expect(testAuth).toHaveBeenCalledWith({
      ...incoming,
      apiKey: 'preserved-key',
    });
  });

  it('TEST_TEXT_PROVIDER_AUTH 最终 Key 为空 → 返回 MINIMAX_API_KEY_MISSING 且不调用 testAuth', async () => {
    const testAuth = vi.fn();
    const deps = makeDeps({
      readSettings: vi.fn().mockResolvedValue(makeSettings({ apiKey: '' })),
      testAuth,
    });
    const handler = createTextProviderSettingsHandler(deps);
    const request: TextProviderSettingsRequest = { type: 'TEST_TEXT_PROVIDER_AUTH' };

    const response = await handler(request);

    // 真实 createErrorResponse 的形状：{ ok: false, error: { code, message } }
    expect(response).toEqual({
      ok: false,
      error: {
        code: 'MINIMAX_API_KEY_MISSING',
        message: '请先在设置中配置当前文本模型 API Key',
      },
    });
    // 关键反向断言：缺失 Key 时**不**调用 testAuth
    expect(testAuth).not.toHaveBeenCalled();
  });

  it('TEST_TEXT_PROVIDER_AUTH payload apiKey 含空格但 trim 后非空 → 视为有 Key', async () => {
    const testAuth = vi.fn().mockResolvedValue({
      message: 'ok',
      latencyMs: 1,
    } satisfies LanguageModelAuthTestResult);
    const deps = makeDeps({ testAuth });
    const handler = createTextProviderSettingsHandler(deps);
    const incoming = makeSettings({ apiKey: '   real-key   ' });
    const request: TextProviderSettingsRequest = {
      type: 'TEST_TEXT_PROVIDER_AUTH',
      payload: incoming,
    };

    await handler(request);

    expect(testAuth).toHaveBeenCalledTimes(1);
    expect(testAuth).toHaveBeenCalledWith(incoming);
    // 反向断言：trim 后非空时**不**调 readSettings
    expect(deps.readSettings).not.toHaveBeenCalled();
  });

  it('GET_BAI_SERVICE_QUOTA 使用 bAI 服务设置读取额度', async () => {
    const getBaiServiceQuota = vi.fn().mockResolvedValue({
      user: { displayName: '用户 A', status: 'active' },
      quota: {
        daily: {
          limit: 30,
          used: 2,
          remaining: 28,
          resetAt: '2026-07-07T00:00:00.000Z',
        },
        weekly: {
          limit: 120,
          used: 5,
          remaining: 115,
          resetAt: '2026-07-13T00:00:00.000Z',
        },
      },
    });
    const deps = makeDeps({ getBaiServiceQuota });
    const handler = createTextProviderSettingsHandler(deps);
    const settings = makeSettings({
      activeTextProvider: 'bai-service',
      baiService: {
        serviceUrl: 'http://io2477kl7316.vicp.fun',
        inviteCode: 'bai-demo',
        accessToken: '',
        model: 'bai-service',
      },
    });

    const response = await handler({
      type: 'GET_BAI_SERVICE_QUOTA',
      payload: settings,
    });

    expect(response).toEqual({
      ok: true,
      type: 'BAI_SERVICE_QUOTA',
      payload: {
        user: { displayName: '用户 A', status: 'active' },
        quota: {
          daily: {
            limit: 30,
            used: 2,
            remaining: 28,
            resetAt: '2026-07-07T00:00:00.000Z',
          },
          weekly: {
            limit: 120,
            used: 5,
            remaining: 115,
            resetAt: '2026-07-13T00:00:00.000Z',
          },
        },
      },
    });
    expect(getBaiServiceQuota).toHaveBeenCalledWith({
      ...settings,
      apiKey: 'existing-key',
    });
  });
});
