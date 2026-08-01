export type UiVisualStyle = 'glass' | 'minimal' | 'pixel';
export type UiColorScheme = 'system' | 'light' | 'dark';
export type ResolvedUiColorScheme = 'light' | 'dark';
export type UiFontSize = 'small' | 'medium' | 'large';

export interface UiAppearanceSettings {
  readonly visualStyle: UiVisualStyle;
  readonly colorScheme: UiColorScheme;
  readonly fontSize: UiFontSize;
}

export const DEFAULT_UI_APPEARANCE_SETTINGS: UiAppearanceSettings = {
  visualStyle: 'glass',
  colorScheme: 'system',
  fontSize: 'medium',
};

export const UI_APPEARANCE_STORAGE_KEY = 'bai.uiAppearance.v1';

export async function readUiAppearanceSettings(): Promise<UiAppearanceSettings> {
  const raw = await readRawAppearanceSettings();
  return normalizeUiAppearanceSettings(raw);
}

export async function saveUiAppearanceSettings(
  settings: UiAppearanceSettings,
): Promise<UiAppearanceSettings> {
  const normalized = normalizeUiAppearanceSettings(settings);
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [UI_APPEARANCE_STORAGE_KEY]: normalized });
    return normalized;
  }
  const storage = getLocalStorage();
  if (storage && typeof storage.setItem === 'function') {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function resolveUiColorScheme(
  colorScheme: UiColorScheme,
  prefersDark: boolean,
): ResolvedUiColorScheme {
  if (colorScheme === 'system') {
    return prefersDark ? 'dark' : 'light';
  }
  return colorScheme;
}

export function normalizeUiAppearanceSettings(raw: unknown): UiAppearanceSettings {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_UI_APPEARANCE_SETTINGS;
  }
  const value = raw as Partial<UiAppearanceSettings>;
  const visualStyle = isUiVisualStyle(value.visualStyle)
    ? value.visualStyle
    : DEFAULT_UI_APPEARANCE_SETTINGS.visualStyle;
  const colorScheme = isUiColorScheme(value.colorScheme)
    ? value.colorScheme
    : DEFAULT_UI_APPEARANCE_SETTINGS.colorScheme;
  const fontSize = isUiFontSize(value.fontSize)
    ? value.fontSize
    : DEFAULT_UI_APPEARANCE_SETTINGS.fontSize;
  return { visualStyle, colorScheme, fontSize };
}

async function readRawAppearanceSettings(): Promise<unknown> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(UI_APPEARANCE_STORAGE_KEY);
    return result[UI_APPEARANCE_STORAGE_KEY];
  }
  const storage = getLocalStorage();
  if (!storage || typeof storage.getItem !== 'function') return null;
  const stored = storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
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

function isUiVisualStyle(value: unknown): value is UiVisualStyle {
  return value === 'glass' || value === 'minimal' || value === 'pixel';
}

function isUiColorScheme(value: unknown): value is UiColorScheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isUiFontSize(value: unknown): value is UiFontSize {
  return value === 'small' || value === 'medium' || value === 'large';
}
