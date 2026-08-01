import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { LocaleProvider, useLocale } from '@extension/ui/locale-context';
import { localizeUnknownError, localizeUserMessage } from '@extension/ui/localized-error';
import { AppearanceSection } from './AppearanceSection';
import { SettingsNav } from './SettingsNav';
import {
  checkVaultPermission,
  readVaultSettings,
  requestVaultDirectory,
  type VaultPermissionState,
} from '@core/storage/vault-settings';
import { requestLanguageModelHostPermission } from '@extension/settings/text-provider-settings';
import type { ExtensionRequest, ExtensionResponse } from '@shared/messages';
import { sendRuntimeMessage } from '@shared/extension-runtime';
import {
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_BAI_SERVICE_URL,
  DEFAULT_BAI_SERVICE_MODEL,
  DEFAULT_MINIMAX_FAST_MODEL,
  DEFAULT_MINIMAX_MODEL,
  LANGUAGE_MODEL_PROVIDER_PRESETS,
  MINIMAX_FAST_MODEL_OPTIONS,
  createDefaultBaiServiceSettings,
  createDefaultOpenAiCompatibleSettings,
  getLanguageModelProviderPreset,
  isOpenAiCompatibleProviderId,
  type BaiServiceQuotaSnapshot,
  type LanguageModelProviderId,
  type MinimaxFastModel,
  type MinimaxThinkingMode,
  type OpenAiCompatibleProviderId,
  type PublicTextProviderSettings,
  type TextModelAccessMode,
  type TextProviderSettings,
} from '@shared/settings';
import {
  DEFAULT_UI_APPEARANCE_SETTINGS,
  readUiAppearanceSettings,
  saveUiAppearanceSettings,
  type UiColorScheme,
  type UiFontSize,
  type UiVisualStyle,
} from '@shared/appearance-settings';
import { type UiLocaleMode } from '@shared/locale-settings';

function Options(): JSX.Element {
  const { locale, settings: localeSettings, setMode: setLocaleMode, t } = useLocale();
  const [apiKey, setApiKey] = useState('');
  const [textModelAccessMode, setTextModelAccessMode] = useState<TextModelAccessMode>('own-key');
  const [activeTextProvider, setActiveTextProvider] = useState<LanguageModelProviderId>('minimax');
  const [openAiProviderId, setOpenAiProviderId] = useState<OpenAiCompatibleProviderId>('deepseek');
  const [openAiApiKey, setOpenAiApiKey] = useState('');
  const [openAiBaseUrl, setOpenAiBaseUrl] = useState('');
  const [openAiModel, setOpenAiModel] = useState('');
  const [baiInviteCode, setBaiInviteCode] = useState('');
  const [hasSavedBaiInviteCode, setHasSavedBaiInviteCode] = useState(false);
  const [baiQuota, setBaiQuota] = useState<BaiServiceQuotaSnapshot | null>(null);
  const [baiQuotaStatus, setBaiQuotaStatus] = useState('');
  const [fastModel, setFastModel] = useState<MinimaxFastModel>(DEFAULT_MINIMAX_FAST_MODEL);
  const [thinkingMode, setThinkingMode] = useState<MinimaxThinkingMode>('disabled');
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [visualStyle, setVisualStyle] = useState<UiVisualStyle>(
    DEFAULT_UI_APPEARANCE_SETTINGS.visualStyle,
  );
  const [colorScheme, setColorScheme] = useState<UiColorScheme>(
    DEFAULT_UI_APPEARANCE_SETTINGS.colorScheme,
  );
  const [fontSize, setFontSize] = useState<UiFontSize>(DEFAULT_UI_APPEARANCE_SETTINGS.fontSize);
  const [appearanceStatus, setAppearanceStatus] = useState(
    t('正在读取界面设置...', 'Reading appearance settings...'),
  );
  const [localeStatus, setLocaleStatus] = useState(
    t('正在读取语言设置...', 'Reading language settings...'),
  );
  const [status, setStatus] = useState(t('正在读取设置...', 'Reading settings...'));
  const [isBusy, setIsBusy] = useState(false);
  const [vaultDirectoryName, setVaultDirectoryName] = useState('');
  const [vaultPermission, setVaultPermission] = useState<VaultPermissionState>('missing');
  const [vaultStatus, setVaultStatus] = useState(
    t('正在读取 Vault 设置...', 'Reading Vault settings...'),
  );

  useEffect(() => {
    setLocaleStatus(t('已读取语言设置。', 'Language settings loaded.'));
  }, [locale, t]);

  useEffect(() => {
    document.title = t('bAI 视频分析助手设置', 'bAI Video Analysis Assistant Settings');
  }, [t]);

  useEffect(() => {
    void Promise.all([loadSettings(), loadAppearanceSettings(), loadVaultSettings()]);
    // 初始化读取只在打开设置页时执行；后续保存动作会单独刷新对应状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSettings(): Promise<void> {
    const response = await sendMessage({ type: 'GET_TEXT_PROVIDER_SETTINGS' });

    if (!response.ok) {
      setStatus(localizeUserMessage(response.error, locale));
      return;
    }

    if (response.type === 'TEXT_PROVIDER_SETTINGS') {
      const provider = response.payload.activeTextProvider ?? 'minimax';
      const accessMode = response.payload.textModelAccessMode;
      const openAi = response.payload.openAiCompatible ?? {
        ...createDefaultOpenAiCompatibleSettings('deepseek'),
        hasApiKey: false,
      };
      const baiService = response.payload.baiService ?? {
        ...createDefaultBaiServiceSettings(),
        hasInviteCode: false,
        hasAccessToken: false,
      };
      setTextModelAccessMode(accessMode);
      setActiveTextProvider(provider === 'bai-service' ? 'minimax' : provider);
      setOpenAiProviderId(openAi.providerId);
      setOpenAiBaseUrl(openAi.baseUrl);
      setOpenAiModel(openAi.model);
      setHasSavedBaiInviteCode(baiService.hasInviteCode);
      setFastModel(response.payload.fastModel);
      setThinkingMode(response.payload.thinkingMode);
      setWebSearchEnabled(response.payload.webSearchEnabled);
      setStatus(createLoadedSettingsStatus(response.payload, t));
      if (accessMode === 'bai-free' && (baiService.hasInviteCode || baiService.hasAccessToken)) {
        void loadBaiServiceQuota();
      }
    }
  }

  async function loadAppearanceSettings(): Promise<void> {
    const settings = await readUiAppearanceSettings();
    setVisualStyle(settings.visualStyle);
    setColorScheme(settings.colorScheme);
    setFontSize(settings.fontSize);
    setAppearanceStatus(t('已读取界面设置。', 'Appearance settings loaded.'));
  }

  function createSettings(): TextProviderSettings {
    const usingBaiFree = textModelAccessMode === 'bai-free';
    const ownProvider = activeTextProvider === 'bai-service' ? 'minimax' : activeTextProvider;
    const provider = usingBaiFree ? 'bai-service' : ownProvider;
    return {
      textModelAccessMode,
      apiKey: apiKey.trim(),
      baseUrl: DEFAULT_MINIMAX_BASE_URL,
      model: DEFAULT_MINIMAX_MODEL,
      fastModel,
      analysisMode: 'subtitle',
      thinkingMode,
      webSearchEnabled: !usingBaiFree && provider === 'minimax' ? webSearchEnabled : false,
      activeTextProvider: provider,
      openAiCompatible: {
        providerId: openAiProviderId,
        apiKey: openAiApiKey.trim(),
        baseUrl: openAiBaseUrl.trim(),
        model: openAiModel.trim(),
      },
      baiService: {
        serviceUrl: DEFAULT_BAI_SERVICE_URL,
        inviteCode: baiInviteCode.trim(),
        accessToken: '',
        model: DEFAULT_BAI_SERVICE_MODEL,
      },
      updatedAt: Date.now(),
    };
  }

  async function saveSettings(): Promise<void> {
    setIsBusy(true);
    setStatus(t('正在保存...', 'Saving...'));

    try {
      const settings = createSettings();
      await requestLanguageModelHostPermission(settings);

      const response = await sendMessage({
        type: 'SAVE_TEXT_PROVIDER_SETTINGS',
        payload: settings,
      });

      setStatus(
        response.ok
          ? t('模型设置已保存。', 'Model settings saved.')
          : localizeUserMessage(response.error, locale),
      );
      if (response.ok && settings.activeTextProvider === 'bai-service') {
        void loadBaiServiceQuota(settings);
      }
    } catch (error) {
      setStatus(localizeUnknownError(error, locale));
    } finally {
      setIsBusy(false);
    }
  }

  async function testAuth(): Promise<void> {
    setIsBusy(true);
    setStatus(t('正在测试当前文本模型连接...', 'Testing current text model connection...'));

    try {
      const settings = createSettings();
      await requestLanguageModelHostPermission(settings);

      const response = await sendMessage({
        type: 'TEST_TEXT_PROVIDER_AUTH',
        payload: settings,
      });

      if (!response.ok) {
        setStatus(localizeUserMessage(response.error, locale));
        return;
      }

      if (response.type === 'TEXT_PROVIDER_AUTH_TEST') {
        setStatus(
          t(
            `连接成功：${response.payload.message}（${response.payload.latencyMs}ms）`,
            `Connection succeeded: ${response.payload.message} (${response.payload.latencyMs}ms)`,
          ),
        );
        if (settings.activeTextProvider === 'bai-service') {
          void loadBaiServiceQuota(settings);
        }
      }
    } catch (error) {
      setStatus(localizeUnknownError(error, locale));
    } finally {
      setIsBusy(false);
    }
  }

  async function loadBaiServiceQuota(settings?: TextProviderSettings): Promise<void> {
    setBaiQuotaStatus(t('正在读取 bAI 免费服务额度...', 'Reading bAI free service quota...'));
    const response = await sendMessage({
      type: 'GET_BAI_SERVICE_QUOTA',
      ...(settings ? { payload: settings } : {}),
    });
    if (response.ok && response.type === 'BAI_SERVICE_QUOTA') {
      setBaiQuota(response.payload);
      setBaiQuotaStatus(t('已读取 bAI 免费服务额度。', 'bAI free service quota loaded.'));
      return;
    }
    setBaiQuota(null);
    setBaiQuotaStatus(
      response.ok
        ? t('暂未读取到 bAI 免费服务额度。', 'No bAI free service quota loaded yet.')
        : localizeUserMessage(response.error, locale),
    );
  }

  async function saveAppearance(): Promise<void> {
    const saved = await saveUiAppearanceSettings({ visualStyle, colorScheme, fontSize });
    setVisualStyle(saved.visualStyle);
    setColorScheme(saved.colorScheme);
    setFontSize(saved.fontSize);
    setAppearanceStatus(t('界面设置已保存。', 'Appearance settings saved.'));
  }

  async function changeLocaleMode(mode: UiLocaleMode): Promise<void> {
    await setLocaleMode(mode);
    setLocaleStatus(
      t(
        mode === 'auto' ? '语言已设为跟随浏览器。' : '语言设置已保存。',
        mode === 'auto' ? 'Language now follows the browser.' : 'Language setting saved.',
      ),
    );
  }

  async function loadVaultSettings(): Promise<void> {
    const settings = await readVaultSettings();

    if (!settings) {
      setVaultDirectoryName('');
      setVaultPermission('missing');
      setVaultStatus(
        t('尚未授权 Markdown Vault 目录。', 'No Markdown Vault folder authorized yet.'),
      );
      return;
    }

    const permission = await checkVaultPermission();
    setVaultDirectoryName(settings.directoryName);
    setVaultPermission(permission);
    setVaultStatus(createVaultStatus(settings.directoryName, permission, t));
  }

  async function chooseVaultDirectory(): Promise<void> {
    try {
      setVaultStatus(t('正在请求目录授权...', 'Requesting folder authorization...'));
      const settings = await requestVaultDirectory();
      const permission = await checkVaultPermission({ request: true });
      setVaultDirectoryName(settings.directoryName);
      setVaultPermission(permission);
      setVaultStatus(createVaultStatus(settings.directoryName, permission, t));
    } catch (error) {
      setVaultStatus(localizeUnknownError(error, locale));
    }
  }

  async function restoreVaultPermission(): Promise<void> {
    const permission = await checkVaultPermission({ request: true });
    setVaultPermission(permission);
    setVaultStatus(createVaultStatus(vaultDirectoryName, permission, t));
  }

  function changeProvider(providerId: LanguageModelProviderId): void {
    setActiveTextProvider(providerId);
    if (providerId !== 'minimax') {
      setWebSearchEnabled(false);
    }
    if (isOpenAiCompatibleProviderId(providerId)) {
      setOpenAiProviderId(providerId);
      const defaults = createDefaultOpenAiCompatibleSettings(providerId);
      setOpenAiBaseUrl(defaults.baseUrl);
      setOpenAiModel(defaults.model);
      setOpenAiApiKey('');
    }
  }

  const isUsingBaiFree = textModelAccessMode === 'bai-free';
  const isMiniMaxProvider = !isUsingBaiFree && activeTextProvider === 'minimax';
  const activeProviderPreset = getLanguageModelProviderPreset(activeTextProvider);
  const openAiProviderPreset = getLanguageModelProviderPreset(openAiProviderId);
  const ownKeyProviderOptions = LANGUAGE_MODEL_PROVIDER_PRESETS.filter(
    (provider) => provider.id !== 'bai-service',
  );

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t('bAI 视频分析助手', 'bAI Video Analysis Assistant')}
          </p>
          <h1 className="text-2xl font-semibold">{t('设置', 'Settings')}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              'API Key 只保存到本机 Chrome storage，不会写入仓库，也不会发送到 bAI 后端。',
              'API keys are stored only in local Chrome storage. They are not written to the repository or sent to a bAI backend.',
            )}
          </p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[190px_minmax(0,1fr)] lg:items-start">
          <SettingsNav t={t} />

          <div className="min-w-0 space-y-6">
            <AppearanceSection
              t={t}
              locale={locale}
              localeSettings={localeSettings}
              localeStatus={localeStatus}
              appearanceStatus={appearanceStatus}
              visualStyle={visualStyle}
              colorScheme={colorScheme}
              fontSize={fontSize}
              onLocaleModeChange={(mode) => void changeLocaleMode(mode)}
              onVisualStyleChange={setVisualStyle}
              onColorSchemeChange={setColorScheme}
              onFontSizeChange={setFontSize}
              onSaveAppearance={() => void saveAppearance()}
            />

            <section
              id="model"
              className="scroll-mt-6 space-y-4 rounded-md border border-border bg-card p-4"
            >
              <h2 className="text-lg font-semibold">{t('模型服务', 'Model Service')}</h2>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex cursor-pointer gap-3 rounded-md border border-border p-3">
                  <input
                    className="mt-1"
                    type="radio"
                    name="textModelAccessMode"
                    checked={textModelAccessMode === 'bai-free'}
                    onChange={() => {
                      setTextModelAccessMode('bai-free');
                      setWebSearchEnabled(false);
                    }}
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      {t('bAI 免费服务', 'bAI Free Service')}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        '只填写邀请码，使用 bAI 提供的标准免费模型和后台额度。',
                        'Enter only an invite code and use the standard free model provided by bAI.',
                      )}
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer gap-3 rounded-md border border-border p-3">
                  <input
                    className="mt-1"
                    type="radio"
                    name="textModelAccessMode"
                    checked={textModelAccessMode === 'own-key'}
                    onChange={() => setTextModelAccessMode('own-key')}
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      {t('使用自己的大模型', 'Use Your Own Model')}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        '填写自己的 Provider、模型和 API Key，请求不经过 bAI 免费服务。',
                        'Enter your own provider, model, and API key. Requests bypass the bAI free service.',
                      )}
                    </span>
                  </span>
                </label>
              </div>

              {!isUsingBaiFree ? (
                <label className="block space-y-2">
                  <span className="text-sm font-medium">Provider</span>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                    value={activeTextProvider}
                    onChange={(event) =>
                      changeProvider(event.target.value as LanguageModelProviderId)
                    }
                  >
                    {ownKeyProviderOptions.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {formatProviderName(provider.id, t)}
                      </option>
                    ))}
                  </select>
                  <span className="block text-xs text-muted-foreground">
                    {t(
                      '字幕导航、提问、视频分析和学习笔记使用这个自带 Key 的文本模型。',
                      'Subtitle navigation, questions, video analysis, and study notes use this self-managed text model.',
                    )}
                  </span>
                </label>
              ) : null}

              {isUsingBaiFree ? (
                <>
                  <div className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground">
                    {t(
                      'bAI 免费服务通过邀请码换取临时 token；真实模型 API Key 只保存在服务端。联网实验室功能不对免费服务开放。',
                      'The bAI free service exchanges an invite code for a temporary token. The real model API key stays on the server. Labs web search is not available for the free service.',
                    )}
                  </div>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium">{t('邀请码', 'Invite Code')}</span>
                    <input
                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                      type="password"
                      value={baiInviteCode}
                      placeholder={
                        hasSavedBaiInviteCode
                          ? t(
                              '留空表示保留已保存的邀请码',
                              'Leave blank to keep the saved invite code',
                            )
                          : t('输入 bAI 免费服务邀请码', 'Enter the bAI free service invite code')
                      }
                      onChange={(event) => setBaiInviteCode(event.target.value)}
                    />
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <QuotaCard
                      title={t('今日额度', "Today's quota")}
                      quota={baiQuota?.quota.daily}
                      t={t}
                    />
                    <QuotaCard
                      title={t('本周额度', "This week's quota")}
                      quota={baiQuota?.quota.weekly}
                      t={t}
                    />
                  </div>
                  <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                    {baiQuota
                      ? t(
                          `当前账号：${baiQuota.user.displayName}。${baiQuotaStatus}`,
                          `Current account: ${baiQuota.user.displayName}. ${baiQuotaStatus}`,
                        )
                      : baiQuotaStatus ||
                        t(
                          '保存或测试连接后显示可用额度。',
                          'Save or test the connection to show quota.',
                        )}
                  </p>
                </>
              ) : activeTextProvider === 'minimax' ? (
                <>
                  <label className="block space-y-2">
                    <span className="text-sm font-medium">API Key</span>
                    <input
                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                      type="password"
                      value={apiKey}
                      placeholder={t(
                        '留空表示保留已保存的 Key',
                        'Leave blank to keep the saved key',
                      )}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  </label>

                  <div className="rounded-md border border-border bg-muted/40 p-3">
                    <p className="text-sm font-medium">
                      {t('MiniMax 服务地址', 'MiniMax Service URL')}
                    </p>
                    <p className="mt-1 font-mono text-sm">{DEFAULT_MINIMAX_BASE_URL}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(
                        '固定使用 MiniMax 原生接口；联网搜索只接入自己的 MiniMax Key。',
                        'Uses the native MiniMax API. Web search is wired only to your own MiniMax key.',
                      )}
                    </p>
                  </div>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium">
                      {t('快速分析模型', 'Fast Analysis Model')}
                    </span>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                      value={fastModel}
                      onChange={(event) => setFastModel(event.target.value as MinimaxFastModel)}
                    >
                      {MINIMAX_FAST_MODEL_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {formatFastModelLabel(option, t)}
                        </option>
                      ))}
                    </select>
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        `快速分析（基于字幕）使用的模型。默认 ${DEFAULT_MINIMAX_FAST_MODEL}，可切到 M3 换取更深的总结。`,
                        `Model used for fast subtitle-based analysis. Default is ${DEFAULT_MINIMAX_FAST_MODEL}; switch to M3 for deeper summaries.`,
                      )}
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                    {t(
                      '当前 Provider 走 OpenAI-compatible Chat Completions，只用于文本链路；联网搜索暂不支持。',
                      'The current provider uses OpenAI-compatible Chat Completions for text flows only. Web search is not supported yet.',
                    )}
                    {activeProviderPreset.note
                      ? ` ${formatProviderNote(activeProviderPreset.id, t)}`
                      : ''}
                  </div>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium">OpenAI-compatible Base URL</span>
                    <input
                      className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                      type="url"
                      value={openAiBaseUrl}
                      placeholder={openAiProviderPreset.baseUrl || 'https://example.com/v1'}
                      onChange={(event) => setOpenAiBaseUrl(event.target.value)}
                    />
                  </label>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium">{t('模型', 'Model')}</span>
                    <input
                      className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                      value={openAiModel}
                      placeholder={
                        openAiProviderPreset.defaultModel ||
                        t('填写 Provider 文档中的模型名', 'Enter the model name from provider docs')
                      }
                      onChange={(event) => setOpenAiModel(event.target.value)}
                    />
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        '预设只填推荐值，不锁定模型；如果需要 thinking / non-thinking 行为，请按 Provider 文档选择对应模型。',
                        'Presets provide recommended values but do not lock the model. Choose a model from provider docs if you need thinking or non-thinking behavior.',
                      )}
                    </span>
                  </label>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium">
                      {formatProviderName(activeProviderPreset.id, t)} API Key
                    </span>
                    <input
                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                      type="password"
                      value={openAiApiKey}
                      placeholder={t(
                        `留空表示保留已保存的 ${formatProviderName(activeProviderPreset.id, t)} Key`,
                        `Leave blank to keep the saved ${formatProviderName(activeProviderPreset.id, t)} key`,
                      )}
                      onChange={(event) => setOpenAiApiKey(event.target.value)}
                    />
                  </label>
                </>
              )}

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">
                  {t('默认分析策略', 'Default Analysis Strategy')}
                </legend>
                <p className="text-xs text-muted-foreground">
                  {t(
                    '公开版只保留稳定字幕主路；无字幕能力暂不开放。',
                    'The public build keeps only the stable subtitle path. No-subtitle analysis is not available yet.',
                  )}
                </p>
                <div className="grid gap-3">
                  <label className="flex cursor-pointer gap-3 rounded-md border border-border p-3">
                    <input className="mt-1" type="radio" name="analysisMode" checked readOnly />
                    <span>
                      <span className="block text-sm font-medium">
                        {t('快速分析（推荐）', 'Fast Analysis (Recommended)')}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t(
                          '读取 B 站/YouTube 字幕，速度快、成本低，适合播客、访谈、课程。默认模式。',
                          'Reads Bilibili/YouTube subtitles. Fast and low-cost, suitable for podcasts, interviews, and courses. This is the default.',
                        )}
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>

              <fieldset className="space-y-3" disabled={!isMiniMaxProvider}>
                <legend className="text-sm font-medium">
                  {t('调试：思考模式', 'Debug: Thinking Mode')}
                </legend>
                <p className="text-xs text-muted-foreground">
                  {isMiniMaxProvider
                    ? fastModel === 'MiniMax-M3'
                      ? t(
                          '仅 MiniMax-M3 支持前端显式开关；M2.7 系列服务端会始终保留 thinking。',
                          'Only MiniMax-M3 supports an explicit frontend toggle. The M2.7 series keeps thinking on the server side.',
                        )
                      : t(
                          '当前 MiniMax M2.7 系列服务端会始终保留 thinking，前端无法关闭。',
                          'The current MiniMax M2.7 series keeps thinking on the server side and cannot be disabled from the frontend.',
                        )
                    : isUsingBaiFree
                      ? t(
                          'bAI 免费服务由服务端固定关闭 thinking，前端不可修改。',
                          'The bAI free service keeps thinking disabled on the server and cannot be changed here.',
                        )
                      : t(
                          'OpenAI-compatible Provider 第一版不发送通用 thinking 参数，请通过模型名选择对应能力。',
                          'The first OpenAI-compatible provider version does not send a generic thinking parameter. Choose model capabilities through the model name.',
                        )}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex cursor-pointer gap-3 rounded-md border border-border p-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
                    <input
                      className="mt-1"
                      type="radio"
                      name="thinkingMode"
                      checked={thinkingMode === 'disabled'}
                      onChange={() => setThinkingMode('disabled')}
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        {t('关闭思考', 'Thinking Off')}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t(
                          '当前默认值。通常更快，也更容易稳定输出 JSON。',
                          'Current default. Usually faster and more stable for JSON output.',
                        )}
                      </span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer gap-3 rounded-md border border-border p-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
                    <input
                      className="mt-1"
                      type="radio"
                      name="thinkingMode"
                      checked={thinkingMode === 'enabled'}
                      onChange={() => setThinkingMode('enabled')}
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        {t('开启思考', 'Thinking On')}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t(
                          '用来对比总结深度和耗时；可能更慢，返回内容也可能带思考标签。',
                          'Use this to compare summary depth and latency. It may be slower and responses may include thinking tags.',
                        )}
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">{t('实验室功能', 'Labs')}</legend>
                {!isMiniMaxProvider ? (
                  <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                    {isUsingBaiFree
                      ? t(
                          'bAI 免费服务不开放联网实验室功能。',
                          'Labs web search is not available for the bAI free service.',
                        )
                      : t(
                          '追问联网搜索当前仅支持自己的 MiniMax Key。切回 MiniMax 后可继续使用。',
                          'Follow-up web search currently only supports your own MiniMax key. Switch back to MiniMax to use it.',
                        )}
                  </p>
                ) : null}
                <label className="flex cursor-pointer gap-3 rounded-md border border-border p-3">
                  <input
                    className="mt-1"
                    type="checkbox"
                    disabled={!isMiniMaxProvider}
                    checked={isMiniMaxProvider && webSearchEnabled}
                    onChange={(event) => setWebSearchEnabled(event.target.checked)}
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      {t('启用追问联网搜索', 'Enable Follow-up Web Search')}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        '目前仅接入 MiniMax /v1/coding_plan/search。适合查和当前视频紧密相关的事实与来源，结果质量取决于网页来源。',
                        'Currently only wired to MiniMax /v1/coding_plan/search. Useful for facts and sources closely related to the current video; quality depends on web sources.',
                      )}
                    </span>
                  </span>
                </label>
              </fieldset>

              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                  type="button"
                  disabled={isBusy}
                  onClick={() => void saveSettings()}
                >
                  {t('保存', 'Save')}
                </button>
                <button
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-60"
                  type="button"
                  disabled={isBusy}
                  onClick={() => void testAuth()}
                >
                  {t('测试连接', 'Test Connection')}
                </button>
              </div>

              <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{status}</p>
            </section>

            <section
              id="vault"
              className="scroll-mt-6 space-y-4 rounded-md border border-border bg-card p-4"
            >
              <div>
                <h2 className="text-lg font-semibold">Markdown Vault</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(
                    '目录授权只保存在本机 IndexedDB，用于后续导出 Obsidian 兼容 Markdown。',
                    'Folder authorization is stored only in local IndexedDB for exporting Obsidian-compatible Markdown later.',
                  )}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">{t('目录', 'Folder')}</p>
                  <p className="mt-1 break-words text-sm font-medium">
                    {vaultDirectoryName || t('尚未选择', 'Not selected')}
                  </p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">{t('权限', 'Permission')}</p>
                  <p className="mt-1 text-sm font-medium">
                    {formatVaultPermission(vaultPermission, t)}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  type="button"
                  onClick={() => void chooseVaultDirectory()}
                >
                  {t('选择 Vault 目录', 'Choose Vault Folder')}
                </button>
                <button
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-60"
                  type="button"
                  disabled={!vaultDirectoryName}
                  onClick={() => void restoreVaultPermission()}
                >
                  {t('恢复权限', 'Restore Permission')}
                </button>
              </div>

              <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{vaultStatus}</p>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

async function sendMessage(message: ExtensionRequest): Promise<ExtensionResponse> {
  return sendRuntimeMessage(message);
}

type TranslateText = (zh: string, en: string) => string;

function formatFastModelLabel(model: MinimaxFastModel, t: TranslateText): string {
  if (model === 'MiniMax-M2.7-highspeed') {
    return t(
      'MiniMax-M2.7-highspeed（默认，速度优先）',
      'MiniMax-M2.7-highspeed (default, speed first)',
    );
  }
  return t('MiniMax-M3（总结更深）', 'MiniMax-M3 (deeper summaries)');
}

function createLoadedSettingsStatus(
  settings: PublicTextProviderSettings,
  t: TranslateText,
): string {
  if (settings.textModelAccessMode === 'bai-free') {
    const hasCredential =
      settings.baiService?.hasInviteCode === true || settings.baiService?.hasAccessToken === true;
    return hasCredential
      ? t(
          '已读取设置。bAI 免费服务邀请码已配置。',
          'Settings loaded. The bAI free service invite code is configured.',
        )
      : t(
          '尚未配置 bAI 免费服务邀请码。',
          'The bAI free service invite code is not configured yet.',
        );
  }

  const providerId = settings.activeTextProvider ?? 'minimax';
  if (providerId === 'minimax') {
    return settings.hasApiKey
      ? t(
          '已读取设置。当前文本模型 API Key 已配置。',
          'Settings loaded. The text model API key is configured.',
        )
      : t('尚未配置当前文本模型 API Key。', 'The text model API key is not configured yet.');
  }
  const providerName = formatProviderName(providerId, t);
  const hasApiKey = settings.openAiCompatible?.hasApiKey === true;
  return hasApiKey
    ? t(
        `已读取设置。${providerName} Key 已配置。`,
        `Settings loaded. ${providerName} key is configured.`,
      )
    : t(`尚未配置 ${providerName} Key。`, `${providerName} key is not configured yet.`);
}

function QuotaCard(input: {
  readonly title: string;
  readonly quota: BaiServiceQuotaSnapshot['quota']['daily'] | undefined;
  readonly t: TranslateText;
}): JSX.Element {
  const { title, quota, t } = input;
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1 text-lg font-semibold">
        {quota ? `${quota.used} / ${formatQuotaLimit(quota.limit, t)}` : t('未读取', 'Not loaded')}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {quota
          ? t(
              `剩余 ${formatQuotaRemaining(quota.remaining, t)}，${formatResetAt(quota.resetAt)}`,
              `${formatQuotaRemaining(quota.remaining, t)} left, ${formatResetAt(quota.resetAt)}`,
            )
          : t('保存或测试连接后刷新。', 'Refresh after saving or testing the connection.')}
      </p>
    </div>
  );
}

function formatQuotaLimit(limit: number | null, t: TranslateText): string {
  return limit === null ? t('不限', 'Unlimited') : String(limit);
}

function formatQuotaRemaining(remaining: number | null, t: TranslateText): string {
  return remaining === null ? t('不限', 'Unlimited') : String(remaining);
}

function formatResetAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatVaultPermission(permission: VaultPermissionState, t: TranslateText): string {
  switch (permission) {
    case 'granted':
      return t('已授权', 'Granted');
    case 'prompt':
      return t('需要重新确认', 'Needs confirmation');
    case 'denied':
      return t('已拒绝', 'Denied');
    case 'unsupported':
      return t('浏览器不支持', 'Unsupported');
    case 'missing':
      return t('未设置', 'Not set');
  }
}

function createVaultStatus(
  directoryName: string,
  permission: VaultPermissionState,
  t: TranslateText,
): string {
  if (!directoryName) {
    return t('尚未授权 Markdown Vault 目录。', 'No Markdown Vault folder authorized yet.');
  }

  if (permission === 'granted') {
    return t(`Vault 目录已就绪：${directoryName}`, `Vault folder ready: ${directoryName}`);
  }

  if (permission === 'prompt') {
    return t(
      `已保存目录：${directoryName}。导出前需要重新确认权限。`,
      `Saved folder: ${directoryName}. Confirm permission again before export.`,
    );
  }

  if (permission === 'denied') {
    return t(
      `已保存目录：${directoryName}，但当前权限被拒绝。`,
      `Saved folder: ${directoryName}, but permission is currently denied.`,
    );
  }

  return t(
    '当前浏览器不支持本地目录授权。',
    'This browser does not support local folder authorization.',
  );
}

function formatProviderName(providerId: LanguageModelProviderId, t: TranslateText): string {
  switch (providerId) {
    case 'qwen':
      return t('通义千问 / Qwen', 'Qwen');
    case 'glm':
      return t('智谱 GLM', 'Zhipu GLM');
    case 'baidu-qianfan':
      return t('百度千帆', 'Baidu Qianfan');
    case 'tencent-hunyuan':
      return t('腾讯混元', 'Tencent Hunyuan');
    case 'custom-openai-compatible':
      return t('自定义 OpenAI-compatible', 'Custom OpenAI-compatible');
    case 'bai-service':
      return t('bAI 免费服务', 'bAI Free Service');
    default:
      return getLanguageModelProviderPreset(providerId).name;
  }
}

function formatProviderNote(providerId: LanguageModelProviderId, t: TranslateText): string {
  switch (providerId) {
    case 'minimax':
      return t(
        '使用 bAI 已验证的 MiniMax 原生接口；联网搜索仅此 Provider 支持。',
        'Uses the bAI-verified native MiniMax API. Web search is supported only on this provider.',
      );
    case 'bai-service':
      return t(
        '使用 bAI 提供的免费后端服务；插件只保存邀请码和临时 token，不保存真实模型 API Key。',
        'Uses the free backend service provided by bAI. The extension stores only the invite code and temporary token, not the real model API key.',
      );
    case 'openai':
      return t(
        '第一版仅使用 Chat Completions，不接 Responses API。',
        'The first version only uses Chat Completions, not the Responses API.',
      );
    case 'claude':
      return t(
        '使用 Anthropic 的 OpenAI SDK 兼容层；高级能力仍以 Claude 原生 API 为准。',
        "Uses Anthropic's OpenAI SDK compatibility layer. Advanced capabilities still follow the native Claude API.",
      );
    case 'custom-openai-compatible':
      return t(
        '填写兼容 Chat Completions 的 Base URL、模型名和 API Key。',
        'Enter a Chat Completions-compatible base URL, model name, and API key.',
      );
    default:
      return getLanguageModelProviderPreset(providerId).note ?? '';
  }
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

createRoot(root).render(
  <React.StrictMode>
    <LocaleProvider>
      <Options />
    </LocaleProvider>
  </React.StrictMode>,
);
