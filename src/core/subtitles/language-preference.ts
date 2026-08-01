import type { SubtitleTrack } from '@core/types';

export const DEFAULT_SUBTITLE_LANGUAGES = ['zh-CN', 'en-US'] as const;
const FALLBACK_SUBTITLE_FAMILIES = ['zh', 'en'] as const;

export type SubtitleTrackSource = SubtitleTrack['source'];

/**
 * 把浏览器语言和平台字幕语言统一成可比较的稳定形式。
 * B 站的 `ai-zh` / `ai-en` 前缀只表示平台命名，不改变语言族。
 */
export function normalizeSubtitleLanguageTag(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase().replace(/_/g, '-');
}

export function normalizeSubtitleLanguages(
  languages: readonly string[] | undefined,
): readonly string[] {
  const normalized = (languages ?? [])
    .map(normalizeSubtitleLanguageTag)
    .filter((language): language is string => language.length > 0);
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : DEFAULT_SUBTITLE_LANGUAGES.map(normalizeSubtitleLanguageTag);
}

/** 用于 contentContext 的缓存一致性校验，不改变内容 id。 */
export function createSubtitlePreferenceKey(languages: readonly string[] | undefined): string {
  return normalizeSubtitleLanguages(languages).join(',');
}

export function subtitleLanguageFamily(value: unknown): string {
  let normalized = normalizeSubtitleLanguageTag(value);
  if (normalized.startsWith('ai-')) {
    normalized = normalized.slice(3);
  }
  return normalized.split('-')[0] ?? '';
}

interface RankedTrack {
  readonly index: number;
  readonly family: string;
  readonly familyRank: number;
  readonly variantRank: number;
  readonly sourceRank: number;
}

/**
 * 按浏览器语言优先选择字幕语言，再在同一语言内按来源排序。
 *
 * - 有匹配语言时：浏览器语言顺序优先于字幕来源。
 * - 没有匹配语言时：中文 → 英文 → 任意可用语言。
 * - 不对未知平台字段编造“人工 / AI”语义；调用方传入 unknown 即保持稳定顺序。
 */
export function sortSubtitleTracks<
  T extends { readonly language: string; readonly source: SubtitleTrackSource },
>(tracks: readonly T[], languages?: readonly string[]): readonly T[] {
  const preferences = normalizeSubtitleLanguages(languages);
  const preferredLanguagesByFamily = new Map<string, string>();
  for (const language of preferences) {
    const family = subtitleLanguageFamily(language);
    if (family && !preferredLanguagesByFamily.has(family)) {
      preferredLanguagesByFamily.set(family, language);
    }
  }
  const orderedFamilies = [
    ...preferredLanguagesByFamily.keys(),
    ...FALLBACK_SUBTITLE_FAMILIES.filter(
      (family) => !preferredLanguagesByFamily.has(family),
    ),
  ];
  const familyRanks = new Map(orderedFamilies.map((family, index) => [family, index]));

  const ranked = tracks.map((track, index): RankedTrack & { readonly track: T } => {
    const normalizedTrackLanguage = normalizeSubtitleLanguageTag(track.language);
    const family = subtitleLanguageFamily(track.language);
    const familyRank = familyRanks.get(family) ?? orderedFamilies.length;
    const preferredLanguage = preferredLanguagesByFamily.get(family);
    const normalizedTrackComparable = normalizedTrackLanguage.startsWith('ai-')
      ? normalizedTrackLanguage.slice(3)
      : normalizedTrackLanguage;
    const variantRank =
      preferredLanguage && normalizedTrackComparable === preferredLanguage ? 0 : 1;
    const sourceRank = track.source === 'official' ? 0 : track.source === 'unknown' ? 1 : 2;
    return { track, index, family, familyRank, variantRank, sourceRank };
  });

  return ranked
    .sort((left, right) => {
      if (left.familyRank !== right.familyRank) {
        return left.familyRank - right.familyRank;
      }
      if (left.family === right.family && left.family !== '') {
        return left.sourceRank - right.sourceRank || left.variantRank - right.variantRank;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.track);
}
