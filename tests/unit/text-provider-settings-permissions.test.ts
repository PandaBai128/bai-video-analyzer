import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLanguageModelHostPermission,
  createHostPermissionPattern,
  getLanguageModelHostPermissionPattern,
  requestLanguageModelHostPermission,
} from '@extension/settings/text-provider-settings';
import {
  DEFAULT_BAI_SERVICE_URL,
  createDefaultTextProviderSettings,
  type TextProviderSettings,
} from '@shared/settings';
import manifest from '../../manifest.json';

function makeOpenAiCompatibleSettings(
  overrides: Partial<TextProviderSettings> = {},
): TextProviderSettings {
  return {
    ...createDefaultTextProviderSettings(),
    activeTextProvider: 'qwen',
    openAiCompatible: {
      providerId: 'qwen',
      apiKey: 'dashscope-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
    },
    ...overrides,
  };
}

function stubChromePermissions(input: {
  readonly containsResult?: boolean;
  readonly requestResult?: boolean;
} = {}): {
  readonly containsMock: ReturnType<typeof vi.fn>;
  readonly requestMock: ReturnType<typeof vi.fn>;
} {
  const containsResult = input.containsResult ?? false;
  const requestResult = input.requestResult ?? true;
  const containsMock = vi.fn(
    (_permissions: { origins?: string[] }, callback: (result: boolean) => void) => {
      callback(containsResult);
    },
  );
  const requestMock = vi.fn(
    (_permissions: { origins?: string[] }, callback: (result: boolean) => void) => {
      callback(requestResult);
    },
  );

  vi.stubGlobal('chrome', {
    permissions: {
      contains: containsMock,
      request: requestMock,
    },
  });

  return { containsMock, requestMock };
}

describe('language model host permissions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates host permission patterns from allowed model base URLs', () => {
    expect(createHostPermissionPattern('https://api.deepseek.com/v1/')).toBe(
      'https://api.deepseek.com/*',
    );
    expect(createHostPermissionPattern('http://localhost:3000/v1')).toBe(
      'http://localhost/*',
    );
    expect(createHostPermissionPattern('http://127.0.0.1:3000/v1')).toBe(
      'http://127.0.0.1/*',
    );
  });

  it('declares a broad optional HTTPS host permission for custom providers', () => {
    expect(manifest.optional_host_permissions).toContain('https://*/*');
  });

  it('declares optional HTTP host permission for bAI service trial endpoints', () => {
    expect(manifest.optional_host_permissions).toContain('http://*/*');
  });

  it('still requests the concrete origin for a custom OpenAI-compatible provider', () => {
    expect(
      getLanguageModelHostPermissionPattern(
        makeOpenAiCompatibleSettings({
          activeTextProvider: 'custom-openai-compatible',
          openAiCompatible: {
            providerId: 'custom-openai-compatible',
            apiKey: 'custom-key',
            baseUrl: 'https://llm.example.com/v1',
            model: 'custom-chat-model',
          },
        }),
      ),
    ).toBe('https://llm.example.com/*');
  });

  it('rejects public HTTP for a custom OpenAI-compatible provider', () => {
    expect(() =>
      getLanguageModelHostPermissionPattern(
        makeOpenAiCompatibleSettings({
          activeTextProvider: 'custom-openai-compatible',
          openAiCompatible: {
            providerId: 'custom-openai-compatible',
            apiKey: 'custom-key',
            baseUrl: 'http://llm.example.com/v1',
            model: 'custom-chat-model',
          },
        }),
      ),
    ).toThrow('模型服务 Base URL 只允许 https');
  });

  it('allows public HTTP host permission for the default bAI service endpoint', () => {
    expect(
      getLanguageModelHostPermissionPattern({
        ...createDefaultTextProviderSettings(),
        activeTextProvider: 'bai-service',
        baiService: {
          serviceUrl: DEFAULT_BAI_SERVICE_URL,
          inviteCode: 'bai-demo',
          accessToken: '',
          model: 'bai-service',
        },
      }),
    ).toBe('http://io2477kl7316.vicp.fun/*');
  });

  it('rejects non-default public HTTP endpoints in bAI service mode', () => {
    expect(() =>
      getLanguageModelHostPermissionPattern({
        ...createDefaultTextProviderSettings(),
        activeTextProvider: 'bai-service',
        baiService: {
          serviceUrl: 'http://other-gateway.example.com',
          inviteCode: 'bai-demo',
          accessToken: '',
          model: 'bai-service',
        },
      }),
    ).toThrow('模型服务 Base URL 只允许 https');
  });

  it('rejects unsupported model base URL protocols', () => {
    expect(() => createHostPermissionPattern('http://api.example.com/v1')).toThrow(
      '模型服务 Base URL 只允许 https',
    );
    expect(() => createHostPermissionPattern('not-a-url')).toThrow(
      '模型服务 Base URL 不是合法 URL',
    );
  });

  it('does not require extra host permission for MiniMax native provider', () => {
    expect(getLanguageModelHostPermissionPattern(createDefaultTextProviderSettings())).toBeNull();
  });

  it('checks existing permission without requesting it in background-safe paths', async () => {
    const { containsMock, requestMock } = stubChromePermissions({ containsResult: false });

    await expect(
      assertLanguageModelHostPermission(makeOpenAiCompatibleSettings()),
    ).rejects.toThrow('尚未授权访问模型服务域名');

    expect(containsMock).toHaveBeenCalledWith(
      { origins: ['https://dashscope.aliyuncs.com/*'] },
      expect.any(Function),
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('requests permission directly from the Options user gesture path', async () => {
    const { containsMock, requestMock } = stubChromePermissions({ requestResult: true });

    await requestLanguageModelHostPermission(makeOpenAiCompatibleSettings());

    expect(containsMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledWith(
      { origins: ['https://dashscope.aliyuncs.com/*'] },
      expect.any(Function),
    );
  });
});
