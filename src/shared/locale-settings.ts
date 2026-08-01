export type UiLocale = 'zh-CN' | 'en-US';
export type UiLocaleMode = 'auto' | UiLocale;

export interface UiLocaleSettings {
  readonly mode: UiLocaleMode;
}

export const DEFAULT_UI_LOCALE: UiLocale = 'zh-CN';
export const DEFAULT_UI_LOCALE_SETTINGS: UiLocaleSettings = {
  mode: 'auto',
};

export const UI_LOCALE_STORAGE_KEY = 'bai.uiLocale.v1';

export async function readUiLocaleSettings(): Promise<UiLocaleSettings> {
  const raw = await readRawLocaleSettings();
  return normalizeUiLocaleSettings(raw);
}

export async function saveUiLocaleSettings(settings: UiLocaleSettings): Promise<UiLocaleSettings> {
  const normalized = normalizeUiLocaleSettings(settings);
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [UI_LOCALE_STORAGE_KEY]: normalized });
    return normalized;
  }
  const storage = getLocalStorage();
  if (storage && typeof storage.setItem === 'function') {
    storage.setItem(UI_LOCALE_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function normalizeUiLocaleSettings(raw: unknown): UiLocaleSettings {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_UI_LOCALE_SETTINGS;
  }
  const value = raw as Partial<UiLocaleSettings>;
  return {
    mode: isUiLocaleMode(value.mode) ? value.mode : DEFAULT_UI_LOCALE_SETTINGS.mode,
  };
}

export function resolveUiLocale(
  mode: UiLocaleMode,
  browserLanguages: readonly string[] = getBrowserLanguages(),
): UiLocale {
  if (isUiLocale(mode)) {
    return mode;
  }
  return browserLanguages.some(isChineseLocaleTag) ? 'zh-CN' : 'en-US';
}

export function getBrowserLanguages(): readonly string[] {
  const nav = typeof globalThis.navigator === 'undefined' ? null : globalThis.navigator;
  const languages = Array.isArray(nav?.languages) ? nav.languages.filter(Boolean) : [];
  if (languages.length > 0) {
    return languages;
  }
  return nav?.language ? [nav.language] : [DEFAULT_UI_LOCALE];
}

export function isChineseLocaleTag(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === 'zh' || normalized.startsWith('zh-') || normalized.startsWith('zh_');
}

export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'zh-CN' || value === 'en-US';
}

export function isUiLocaleMode(value: unknown): value is UiLocaleMode {
  return value === 'auto' || isUiLocale(value);
}

export function getLocaleDisplayName(locale: UiLocale): string {
  return locale === 'zh-CN' ? '中文' : 'English';
}

export function detectQuestionLocale(question: string): UiLocale {
  const text = stripQuestionLocaleAnnotations(question.trim()).trim();
  if (!text) {
    return DEFAULT_UI_LOCALE;
  }
  const textWithoutQuotedTerms = stripQuotedTerms(text).trim();
  const localeFromQuestionFrame = detectLocaleFromText(
    textWithoutQuotedTerms.length > 0 ? textWithoutQuotedTerms : text,
  );
  if (localeFromQuestionFrame) {
    return localeFromQuestionFrame;
  }
  return DEFAULT_UI_LOCALE;
}

function detectLocaleFromText(text: string): UiLocale | null {
  const hanCount = countMatches(text, /[\u3400-\u9fff]/g);
  const latinWordCount = countMatches(text, /[A-Za-z]+(?:['-][A-Za-z]+)?/g);
  if (hanCount === 0 && latinWordCount > 0) {
    return 'en-US';
  }
  if (hanCount > 0 && latinWordCount === 0) {
    return 'zh-CN';
  }
  if (hanCount === 0 && latinWordCount === 0) {
    return null;
  }

  const hasChineseQuestionFrame = hasChineseQuestionMarker(text);
  const hasEnglishQuestionFrame = hasEnglishQuestionMarker(text);
  if (hasChineseQuestionFrame && !hasEnglishQuestionFrame) {
    return 'zh-CN';
  }
  if (hasEnglishQuestionFrame && !hasChineseQuestionFrame) {
    return 'en-US';
  }

  return hanCount >= latinWordCount * 2 ? 'zh-CN' : 'en-US';
}

function stripQuestionLocaleAnnotations(question: string): string {
  return question
    .replace(/[（(]\s*当前播放时间\s*[：:]\s*[^）)]*[）)]/giu, '')
    .replace(/[（(]\s*current playback time\s*[：:]\s*[^）)]*[）)]/giu, '');
}

function stripQuotedTerms(question: string): string {
  return question.replace(
    /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》|〈[^〉]*〉|`[^`]*`/gu,
    ' ',
  );
}

function hasChineseQuestionMarker(text: string): boolean {
  return /请|解释|意思|是什么|为什么|怎么|怎样|哪里|哪|吗|呢|这个词|中文|核心|观点|讲什么|讲了什么|在讲|的/u.test(
    text,
  );
}

function hasEnglishQuestionMarker(text: string): boolean {
  return /\b(what|why|how|where|which|who|when|can|could|would|should|does|do|did|is|are|explain|show|tell|mean|means|meaning)\b/iu.test(
    text,
  );
}

export function getArtifactLocale(value: { readonly outputLocale?: UiLocale } | null | undefined): UiLocale {
  return value?.outputLocale && isUiLocale(value.outputLocale) ? value.outputLocale : DEFAULT_UI_LOCALE;
}

export function isGeneratedTextLikelyLocale(text: string, locale: UiLocale): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }
  if (locale === 'zh-CN') {
    return true;
  }
  const hanCount = countMatches(normalized, /[\u3400-\u9fff]/g);
  if (hanCount < 24) {
    return true;
  }
  const latinCount = countMatches(normalized, /[A-Za-z]/g);
  return hanCount <= Math.max(16, Math.floor(latinCount * 0.35));
}

async function readRawLocaleSettings(): Promise<unknown> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(UI_LOCALE_STORAGE_KEY);
    return result[UI_LOCALE_STORAGE_KEY];
  }
  const storage = getLocalStorage();
  if (!storage || typeof storage.getItem !== 'function') return null;
  const stored = storage.getItem(UI_LOCALE_STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

function getLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}
