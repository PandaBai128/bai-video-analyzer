import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_UI_LOCALE_SETTINGS,
  UI_LOCALE_STORAGE_KEY,
  getBrowserLanguages,
  readUiLocaleSettings,
  resolveUiLocale,
  saveUiLocaleSettings,
  type UiLocale,
  type UiLocaleMode,
  type UiLocaleSettings,
} from '@shared/locale-settings';

export interface LocaleContextValue {
  readonly locale: UiLocale;
  readonly settings: UiLocaleSettings;
  readonly setMode: (mode: UiLocaleMode) => Promise<void>;
  readonly t: (zh: string, en: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

const fallbackLocaleContext: LocaleContextValue = {
  locale: 'zh-CN',
  settings: DEFAULT_UI_LOCALE_SETTINGS,
  setMode: async () => undefined,
  t: (zh) => zh,
};

export function LocaleProvider(props: { readonly children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<UiLocaleSettings>(DEFAULT_UI_LOCALE_SETTINGS);
  const [browserLanguageRevision, setBrowserLanguageRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void readUiLocaleSettings().then((loaded) => {
      if (!cancelled) {
        setSettings(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
      return undefined;
    }
    const handleChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') return;
      if (changes[UI_LOCALE_STORAGE_KEY]) {
        void readUiLocaleSettings().then(setSettings);
      }
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => chrome.storage.onChanged.removeListener(handleChange);
  }, []);

  useEffect(() => {
    const handler = (): void => setBrowserLanguageRevision((current) => current + 1);
    globalThis.addEventListener?.('languagechange', handler);
    return () => globalThis.removeEventListener?.('languagechange', handler);
  }, []);

  const browserLanguages = useMemo(() => {
    void browserLanguageRevision;
    return getBrowserLanguages();
  }, [browserLanguageRevision]);
  const locale = useMemo(
    () => resolveUiLocale(settings.mode, browserLanguages),
    [browserLanguages, settings.mode],
  );

  const setMode = useCallback(async (mode: UiLocaleMode): Promise<void> => {
    const saved = await saveUiLocaleSettings({ mode });
    setSettings(saved);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      settings,
      setMode,
      t: (zh, en) => (locale === 'en-US' ? en : zh),
    }),
    [locale, setMode, settings],
  );

  return <LocaleContext.Provider value={value}>{props.children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? fallbackLocaleContext;
}

export function useUiLocale(): UiLocale {
  return useLocale().locale;
}

export function useUiText(): (zh: string, en: string) => string {
  return useLocale().t;
}
