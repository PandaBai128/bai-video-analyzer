import type { UiColorScheme, UiFontSize, UiVisualStyle } from '@shared/appearance-settings';
import type { UiLocale, UiLocaleMode, UiLocaleSettings } from '@shared/locale-settings';

type Translate = (zh: string, en: string) => string;

interface AppearanceSectionProps {
  readonly t: Translate;
  readonly locale: UiLocale;
  readonly localeSettings: UiLocaleSettings;
  readonly localeStatus: string;
  readonly appearanceStatus: string;
  readonly visualStyle: UiVisualStyle;
  readonly colorScheme: UiColorScheme;
  readonly fontSize: UiFontSize;
  readonly onLocaleModeChange: (mode: UiLocaleMode) => void;
  readonly onVisualStyleChange: (style: UiVisualStyle) => void;
  readonly onColorSchemeChange: (scheme: UiColorScheme) => void;
  readonly onFontSizeChange: (size: UiFontSize) => void;
  readonly onSaveAppearance: () => void;
}

export function AppearanceSection(props: AppearanceSectionProps): JSX.Element {
  const { t } = props;
  return (
    <section
      id="appearance"
      className="scroll-mt-6 space-y-4 rounded-md border border-border bg-card p-4"
    >
      <div>
        <h2 className="text-lg font-semibold">{t('外观', 'Appearance')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            '语言、字号、风格和深浅模式只影响本机插件界面。',
            'Language, font size, style, and color scheme only affect this local extension UI.',
          )}
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">
          {t('当前语言：', 'Current language: ')}
          {props.locale === 'zh-CN' ? t('中文', 'Chinese') : 'English'}
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { value: 'auto', label: t('跟随浏览器', 'Follow browser') },
            { value: 'zh-CN', label: t('中文', 'Chinese') },
            { value: 'en-US', label: 'English' },
          ].map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-border p-3"
            >
              <input
                className="mt-1"
                type="radio"
                name="uiLocaleMode"
                checked={props.localeSettings.mode === option.value}
                onChange={() => props.onLocaleModeChange(option.value as UiLocaleMode)}
              />
              <span className="text-sm font-medium">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{props.localeStatus}</p>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t('字体大小', 'Font Size')}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              value: 'small',
              label: t('小', 'Small'),
              hint: t('保持原始高密度。', 'Keep the original compact density.'),
            },
            {
              value: 'medium',
              label: t('中', 'Medium'),
              hint: t(
                '默认字号，兼顾清晰度和信息密度。',
                'Default size, balancing clarity and information density.',
              ),
            },
            {
              value: 'large',
              label: t('大', 'Large'),
              hint: t(
                '明显放大侧边栏正文，适合高分屏阅读。',
                'Clearly enlarges side-panel text for high-resolution displays.',
              ),
            },
          ].map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-border p-3"
            >
              <input
                className="mt-1"
                type="radio"
                name="fontSize"
                checked={props.fontSize === option.value}
                onChange={() => props.onFontSizeChange(option.value as UiFontSize)}
              />
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t('风格', 'Style')}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              value: 'glass',
              label: t('流光', 'Glow'),
              hint: t('通透悬浮、高光层次更强。', 'Translucent layers with stronger highlights.'),
            },
            {
              value: 'minimal',
              label: t('白描', 'Outline'),
              hint: t(
                '低装饰、高密度、专注阅读。',
                'Low decoration, high density, focused reading.',
              ),
            },
            {
              value: 'pixel',
              label: t('方糖', 'Pixel'),
              hint: t(
                '硬边框、轻松复古、识别度更高。',
                'Hard edges, a lighter retro feel, and stronger recognition.',
              ),
            },
          ].map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-border p-3"
            >
              <input
                className="mt-1"
                type="radio"
                name="visualStyle"
                checked={props.visualStyle === option.value}
                onChange={() => props.onVisualStyleChange(option.value as UiVisualStyle)}
              />
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t('深浅模式', 'Color Scheme')}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { value: 'system', label: t('跟随系统', 'Follow system') },
            { value: 'light', label: t('浅色', 'Light') },
            { value: 'dark', label: t('深色', 'Dark') },
          ].map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-border p-3"
            >
              <input
                className="mt-1"
                type="radio"
                name="colorScheme"
                checked={props.colorScheme === option.value}
                onChange={() => props.onColorSchemeChange(option.value as UiColorScheme)}
              />
              <span className="text-sm font-medium">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <button
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        type="button"
        onClick={props.onSaveAppearance}
      >
        {t('保存界面设置', 'Save Appearance')}
      </button>

      <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
        {props.appearanceStatus}
      </p>
    </section>
  );
}
