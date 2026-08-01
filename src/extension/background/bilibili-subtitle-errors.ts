import type { PageContext } from '@shared/page-context';

const BILIBILI_LOGIN_REQUIRED_SUBTITLE_MESSAGE =
  '当前 B 站未登录时没有返回字幕。如果播放器提示“登录可享”，请登录 B 站后刷新页面再试。';

export function createNoSubtitleMessageForContext(input: {
  readonly context: PageContext;
  readonly bilibiliCookieHeader: string | null | undefined;
  readonly fallback: string;
}): string {
  if (input.context.platform !== 'bilibili') {
    return input.fallback;
  }
  if (input.bilibiliCookieHeader === undefined) {
    return input.fallback;
  }

  return hasBilibiliLoginCookie(input.bilibiliCookieHeader)
    ? input.fallback
    : BILIBILI_LOGIN_REQUIRED_SUBTITLE_MESSAGE;
}

function hasBilibiliLoginCookie(header: string | null | undefined): boolean {
  if (!header) {
    return false;
  }
  return /(?:^|;\s*)SESSDATA=/.test(header);
}
