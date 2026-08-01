import { getBrowserLanguages } from '@shared/locale-settings';
import { normalizeSubtitleLanguages } from '@core/subtitles/language-preference';

/**
 * 扩展层唯一读取浏览器字幕语言偏好的入口。
 *
 * chrome.i18n.getAcceptLanguages() 比页面 navigator.languages 更接近扩展实际
 * 生效顺序；测试环境或旧浏览器没有该 API 时才回退到 navigator。
 */
export async function getBrowserSubtitleLanguages(): Promise<readonly string[]> {
  try {
    const languages = await chrome.i18n.getAcceptLanguages();
    return normalizeSubtitleLanguages(languages);
  } catch {
    return normalizeSubtitleLanguages(getBrowserLanguages());
  }
}
