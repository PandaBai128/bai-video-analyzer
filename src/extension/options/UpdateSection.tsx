import { useState } from 'react';
import { useUiText } from '@extension/ui/locale-context';

const HOME = 'https://video-analysis.pandabai.com';
export function UpdateSection(): JSX.Element {
  const t = useUiText();
  const current = chrome.runtime.getManifest().version;
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function check(): Promise<void> {
    setBusy(true);
    setStatus('');
    try {
      const response = await fetch(HOME + '/latest.json', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('http');
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !('version' in data) ||
        typeof data.version !== 'string' ||
        !/^v?\d+\.\d+\.\d+$/.test(data.version)
      )
        throw new Error('version');
      const latest = data.version.replace(/^v/, '');
      const parts = latest.split('.').map(Number);
      const installed = current.split('.').map(Number);
      const differing = parts.findIndex((part, i) => part !== installed[i]);
      const newer = differing >= 0 && parts[differing]! > installed[differing]!;
      setStatus(
        newer
          ? t('发现新版本：', 'New version: ') + latest
          : t('当前已是最新版本。', 'You are up to date.'),
      );
    } catch {
      setStatus(
        t(
          '暂时无法检查，请前往官网下载页查看。',
          'Unable to check. Please visit the download page.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      id="updates"
      className="scroll-mt-6 space-y-4 rounded-md border border-border bg-card p-5"
    >
      <div>
        <h2 className="text-lg font-semibold">{t('更新插件版本', 'Extension updates')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('当前版本', 'Current version')} · {current}
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void check()}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-60"
        >
          {busy ? t('检查中…', 'Checking…') : t('检查更新', 'Check for updates')}
        </button>
        <a
          href={HOME + '/latest.zip'}
          className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
        >
          {t('下载最新版', 'Download latest')}
        </a>
        <a
          href={HOME + '/#install'}
          target="_blank"
          rel="noopener noreferrer"
          className="px-1 py-2 text-sm text-primary underline"
        >
          {t('前往官网', 'Visit website')}
        </a>
      </div>
      <p role="status" className="text-sm">
        {status}
      </p>
      <p className="text-sm leading-6 text-muted-foreground">
        {t(
          '下载后解压，覆盖原插件文件夹，再到 Chrome 扩展管理页点击“重新加载”。请保留原文件夹和扩展，不要先卸载。',
          'Unzip and replace the files in the original extension folder, then click Reload in Chrome Extensions. Keep the original folder and do not uninstall the extension.',
        )}
      </p>
    </section>
  );
}
