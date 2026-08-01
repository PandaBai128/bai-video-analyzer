import type { UiLocale } from '@shared/locale-settings';
import { localizeUserMessage } from '@extension/ui/localized-error';

/** 内容上下文错误码 → 用户可见文案映射；中文模式保留原始中文，英文模式在 UI 边界本地化。 */
export type PrepareContentContextErrorCode =
  | 'NO_CONTENT_CONTEXT'
  | 'UNSUPPORTED_PLATFORM'
  | 'API_KEY_MISSING'
  | 'NO_PAGE_CONTEXT'
  | 'NO_ACTIVE_TAB';

export function mapPrepareContentContextError(
  code: string | undefined,
  fallbackMessage: string,
  locale: UiLocale,
): string {
  return localizeUserMessage(
    code ? { code, message: fallbackMessage } : fallbackMessage,
    locale,
  );
}
