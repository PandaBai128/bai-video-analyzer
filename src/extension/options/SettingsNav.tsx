type Translate = (zh: string, en: string) => string;

export function SettingsNav(props: { readonly t: Translate }): JSX.Element {
  const { t } = props;
  return (
    <nav className="rounded-md border border-border bg-card p-3 lg:sticky lg:top-6">
      <p className="px-2 pb-2 text-xs font-medium uppercase text-muted-foreground">
        {t('设置分组', 'Sections')}
      </p>
      <div className="space-y-1">
        {[
          {
            href: '#appearance',
            label: t('外观', 'Appearance'),
            hint: t('语言 / 字号 / 风格', 'Language / font / style'),
          },
          {
            href: '#model',
            label: t('模型', 'Model'),
            hint: 'Provider / API Key',
          },
          {
            href: '#vault',
            label: t('导出', 'Export'),
            hint: 'Markdown Vault',
          },
        ].map((item) => (
          <a
            key={item.href}
            className="block rounded-md px-2 py-2 text-sm hover:bg-muted"
            href={item.href}
          >
            <span className="block font-medium">{item.label}</span>
            <span className="block text-xs text-muted-foreground">{item.hint}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}
