import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateSection } from '../../src/extension/options/UpdateSection';
vi.mock('@extension/ui/locale-context', () => ({ useUiText: () => (zh: string) => zh }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([['v0.1.3', '发现新版本：0.1.3'], ['v0.1.2', '当前已是最新版本。'], ['v0.1.1', '当前已是最新版本。']])('检查版本 %s', async (version, message) => {
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.1.2' }) } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version }) }));
  render(<UpdateSection />);
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message));
  expect(screen.getByRole('link', { name: '下载最新版' }).getAttribute('href')).toBe('https://video-analysis.pandabai.com/latest.zip');
});
it('检查失败仍可从官网下载', async () => {
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.1.2' }) } });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  render(<UpdateSection />);
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('暂时无法检查'));
  expect(screen.getByRole('link', { name: '前往官网' })).toBeDefined();
});
