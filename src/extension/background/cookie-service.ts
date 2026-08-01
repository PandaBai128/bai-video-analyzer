/**
 * B 站登录态读取。
 *
 * B 站登录信息存在 cookie 里：`SESSDATA` / `bili_jct` / `DedeUserID` 等，
 * 域名都是 `bilibili.com`。`chrome.cookies` API 能拿到这些 cookie 并组装成
 * `Cookie:` 头，让 adapter 走 WBI 签名接口时带上登录态。
 *
 * 这层只跟 chrome.* 打交道。adapter 拿到的是拼好的字符串，自己拼到 fetch headers 里。
 */

import type { VideoPlatform } from '@core/types';

const BILIBILI_COOKIE_URL = 'https://www.bilibili.com/';
const BILIBILI_LOGIN_COOKIE_NAMES = ['SESSDATA', 'DedeUserID', 'bili_jct'] as const;

export interface BilibiliCookieSnapshot {
  /** 形如 `SESSDATA=xxx; DedeUserID=yyy; bili_jct=zzz`，可空。 */
  readonly header: string | null;
  /** 仅看 SESSDATA / DedeUserID 是不是有值，给上层做轻量判定。 */
  readonly loggedIn: boolean;
  /** 抓到的 cookie 名清单（debug 用）。 */
  readonly capturedNames: readonly string[];
}

export async function readBilibiliCookieSnapshot(): Promise<BilibiliCookieSnapshot> {
  if (!hasChromeCookiesApi()) {
    return { header: null, loggedIn: false, capturedNames: [] };
  }

  const cookies = await chrome.cookies.getAll({ url: BILIBILI_COOKIE_URL });

  if (cookies.length === 0) {
    return { header: null, loggedIn: false, capturedNames: [] };
  }

  // 按 domain / path / name 去重，保留稳定顺序
  const seen = new Set<string>();
  const pairs: string[] = [];
  const names: string[] = [];

  for (const cookie of cookies) {
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(cookie.name);
    pairs.push(`${cookie.name}=${cookie.value}`);
  }

  const header = pairs.join('; ');
  const loggedIn = BILIBILI_LOGIN_COOKIE_NAMES.some(
    (name) => cookieExists(cookies, name),
  );

  return { header, loggedIn, capturedNames: names };
}

/**
 * 按平台返回拼好的 `Cookie:` 头。**只有 B 站**返回登录态 cookie header，其它
 * 平台返回 `null`（不需要 / 没有登录态）。
 *
 * SG-02K 前此函数在 service-worker.ts；归属为"平台鉴权读取"，与本模块的 B 站
 * cookie 读取同源，迁过来。video-analysis-service 的 `cookieProvider` dep
 * 由 service-worker 注入这个函数。
 */
export async function getCookieHeaderForPlatform(
  platform: VideoPlatform,
): Promise<string | null> {
  if (platform !== 'bilibili') {
    return null;
  }
  const snapshot = await readBilibiliCookieSnapshot();
  return snapshot.header;
}

function cookieExists(cookies: readonly chrome.cookies.Cookie[], name: string): boolean {
  return cookies.some((cookie) => cookie.name === name && cookie.value.length > 0);
}

function hasChromeCookiesApi(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.cookies?.getAll === 'function';
}
