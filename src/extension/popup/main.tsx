import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { LocaleProvider, useUiText } from '@extension/ui/locale-context';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import { isExtensionRuntimeAvailable, sendRuntimeMessage } from '@shared/extension-runtime';
import { getLanguageModelProviderPreset, type PublicTextProviderSettings } from '@shared/settings';

function Popup(): JSX.Element {
  const t = useUiText();
  const [auth, setAuth] = useState<PublicTextProviderSettings | null>(null);

  useEffect(() => {
    document.title = t('bAI 视频分析助手', 'bAI Video Analysis Assistant');
  }, [t]);

  useEffect(() => {
    void sendRuntimeMessage({ type: 'GET_TEXT_PROVIDER_SETTINGS' } satisfies ExtensionRequest).then(
      (response: ExtensionResponse) => {
        if (response.ok && response.type === 'TEXT_PROVIDER_SETTINGS') {
          setAuth(response.payload);
        }
      },
    );
  }, []);

  function openOptions(): void {
    if (!isExtensionRuntimeAvailable()) {
      return;
    }

    void chrome.runtime.openOptionsPage().catch(() => undefined);
  }

  return (
    <main className="w-72 space-y-3 bg-background p-4 text-foreground">
      <header className="space-y-1">
        <p className="text-xs text-muted-foreground">
          {t('bAI 视频分析助手', 'bAI Video Analysis Assistant')}
        </p>
        <h1 className="text-lg font-semibold">{t('视频分析助手', 'Video Analysis Assistant')}</h1>
      </header>

      <section className="rounded-md border border-border p-3 text-sm">
        <p className="font-medium">{t('文本模型', 'Text Model')}</p>
        <p className="mt-1 text-muted-foreground">
          {t('入口', 'Mode')}: {formatAccessMode(auth, t)}
        </p>
        <p className="mt-1 text-muted-foreground">Provider: {formatProvider(auth, t)}</p>
        <p className="mt-1 text-muted-foreground">
          {hasActiveProviderKey(auth)
            ? auth?.textModelAccessMode === 'bai-free'
              ? t('已配置邀请码', 'Invite code configured')
              : t('已配置 API Key', 'API key configured')
            : auth?.textModelAccessMode === 'bai-free'
              ? t('尚未配置邀请码', 'Invite code not configured')
              : t('尚未配置 API Key', 'API key not configured')}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t('模式', 'Mode')}: {formatAnalysisMode(auth?.analysisMode, t)}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t('文本模型', 'Text model')}: {formatTextModel(auth, t)}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t('思考', 'Thinking')}:{' '}
          {auth?.activeTextProvider === 'minimax' || !auth?.activeTextProvider
            ? auth?.thinkingMode === 'enabled'
              ? t('开启', 'On')
              : t('关闭', 'Off')
            : t('按 Provider / 模型默认', 'Provider/model default')}
        </p>
      </section>

      <button
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        type="button"
        onClick={openOptions}
      >
        {t('打开设置', 'Open Settings')}
      </button>
    </main>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

createRoot(root).render(
  <React.StrictMode>
    <LocaleProvider>
      <Popup />
    </LocaleProvider>
  </React.StrictMode>,
);

function formatAnalysisMode(
  _mode: PublicTextProviderSettings['analysisMode'] | undefined,
  t: (zh: string, en: string) => string,
): string {
  return t('快速分析', 'Fast analysis');
}

function formatProvider(
  settings: PublicTextProviderSettings | null,
  t: (zh: string, en: string) => string,
): string {
  if (!settings) {
    return t('未读取', 'Not loaded');
  }
  if (settings.textModelAccessMode === 'bai-free') {
    return t('bAI 免费服务', 'bAI Free Service');
  }
  return getLanguageModelProviderPreset(settings.activeTextProvider ?? 'minimax').name;
}

function formatAccessMode(
  settings: PublicTextProviderSettings | null,
  t: (zh: string, en: string) => string,
): string {
  if (!settings) {
    return t('未读取', 'Not loaded');
  }
  return settings.textModelAccessMode === 'bai-free'
    ? t('bAI 免费服务', 'bAI Free Service')
    : t('使用自己的大模型', 'Use your own model');
}

function hasActiveProviderKey(settings: PublicTextProviderSettings | null): boolean {
  if (!settings) {
    return false;
  }
  if (settings.textModelAccessMode === 'bai-free') {
    return (
      settings.baiService?.hasInviteCode === true || settings.baiService?.hasAccessToken === true
    );
  }
  if ((settings.activeTextProvider ?? 'minimax') === 'minimax') {
    return settings.hasApiKey;
  }
  return settings.openAiCompatible?.hasApiKey === true;
}

function formatTextModel(
  settings: PublicTextProviderSettings | null,
  t: (zh: string, en: string) => string,
): string {
  if (!settings) {
    return t('未读取', 'Not loaded');
  }
  if (settings.textModelAccessMode === 'bai-free') {
    return t('bAI 标准免费模型', 'bAI standard free model');
  }
  if ((settings.activeTextProvider ?? 'minimax') === 'minimax') {
    return settings.fastModel;
  }
  return settings.openAiCompatible?.model || t('未设置', 'Not set');
}
