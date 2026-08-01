import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_APPEARANCE_SETTINGS,
  normalizeUiAppearanceSettings,
} from '@shared/appearance-settings';

describe('appearance settings normalization', () => {
  it('returns defaults for empty input', () => {
    expect(normalizeUiAppearanceSettings(undefined)).toEqual(DEFAULT_UI_APPEARANCE_SETTINGS);
  });

  it('keeps valid medium font size settings', () => {
    expect(
      normalizeUiAppearanceSettings({
        visualStyle: 'minimal',
        colorScheme: 'dark',
        fontSize: 'medium',
      }),
    ).toEqual({
      visualStyle: 'minimal',
      colorScheme: 'dark',
      fontSize: 'medium',
    });
  });

  it('keeps valid large font size settings', () => {
    expect(
      normalizeUiAppearanceSettings({
        visualStyle: 'minimal',
        colorScheme: 'dark',
        fontSize: 'large',
      }),
    ).toEqual({
      visualStyle: 'minimal',
      colorScheme: 'dark',
      fontSize: 'large',
    });
  });

  it('migrates older appearance settings to the default medium font size', () => {
    expect(
      normalizeUiAppearanceSettings({
        visualStyle: 'pixel',
        colorScheme: 'light',
      }),
    ).toEqual({
      visualStyle: 'pixel',
      colorScheme: 'light',
      fontSize: 'medium',
    });
  });

  it('drops invalid font size values', () => {
    expect(
      normalizeUiAppearanceSettings({
        visualStyle: 'glass',
        colorScheme: 'system',
        fontSize: 'huge',
      }),
    ).toEqual(DEFAULT_UI_APPEARANCE_SETTINGS);
  });
});
