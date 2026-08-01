import { db, type ContentContextRecord } from './db';
import {
  CONTENT_CONTEXT_SCHEMA_VERSION,
  type ContentContext,
  type VideoPlatform,
} from '@core/types';
import { createSubtitlePreferenceKey } from '@core/subtitles/language-preference';

/**
 * Round 29A 必修 A：内容底座缓存模块。
 *
 * 设计原则（SPEC.md "一个内容底座，多种派生产物" + ADR-012）：
 * - 内容底座只存"未加工的内容事实"（metadata + 字幕 cues）。
 * - 派生产物（timelineAnalysis / followupSession / reviewAnalysis）**引用**底座 id。
 * - 用户只点 `提问` 时**不**被强制走时间线生成。
 *
 * 与 analysisCache 的关键差异：
 * - analysisCache 是"派生产物缓存"（metadata + timeline + cues 副本）。
 * - contentContext 是"内容底座缓存"（metadata + cues，**无** timeline）。
 * - 字幕 cues 是大文本，只存**一份**（contentContext）；analysisCache 旧链路的
 *   transcriptCues 副本不参与 contentContext 恢复。
 */

export interface ContentContextCacheValue {
  readonly metadata: ContentContext['metadata'];
  readonly transcriptCues: ContentContext['transcriptCues'];
  readonly transcriptSource: ContentContext['transcriptSource'];
  readonly language?: string;
  /** 生成这份字幕时的浏览器语言偏好；旧测试/调用方缺省时按默认偏好保存。 */
  readonly subtitlePreferenceKey?: string;
}

export function createContentContextId(platform: VideoPlatform, contentKey: string): string {
  // 沿用 analysisCache 的 id 规则前缀（`${platform}:${contentKey}`），
  // 但**不**带 `:${sourceMode}` 后缀——内容底座跟 sourceMode 无关。
  return `${platform}:${contentKey}`;
}

/**
 * 按 `(platform, contentKey)` 查内容底座缓存。
 *
 * 关键不变量：
 * - 命中后**校验 schemaVersion**——不匹配按 null 处理（避免旧字段被新代码误读）。
 * - 不存在**或**过期都返回 null，调用方按"需要重新准备"处理。
 */
export async function getCachedContentContext(input: {
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly subtitlePreferenceKey?: string;
}): Promise<ContentContextCacheValue | null> {
  const id = createContentContextId(input.platform, input.contentKey);
  const record = await db.contentContexts.get(id);
  if (!record) {
    return null;
  }
  if (record.schemaVersion !== CONTENT_CONTEXT_SCHEMA_VERSION) {
    return null;
  }
  const expectedPreferenceKey =
    input.subtitlePreferenceKey ?? createSubtitlePreferenceKey(undefined);
  if (record.subtitlePreferenceKey !== expectedPreferenceKey) {
    return null;
  }
  return {
    metadata: record.metadata,
    transcriptCues: record.transcriptCues,
    transcriptSource: record.transcriptSource,
    ...(record.language ? { language: record.language } : {}),
    subtitlePreferenceKey: record.subtitlePreferenceKey,
  };
}

/**
 * 保存内容底座缓存。
 *
 * 行为：
 * - 已存在**同 id**的记录 → 保留 `createdAt`，刷新 `updatedAt` 和 cues。
 * - 不存在 → 新建。
 * - 总是**覆盖** metadata / transcriptCues / transcriptSource（**不**做字段级 merge）。
 *
 * contentKey 由调用方传（**不**从 metadata 派生，因为 VideoMetadata 当前
 * 没 contentKey 字段；与 `getVideoMetadataContentKey` 同源）。
 */
export async function saveContentContext(
  input: ContentContextCacheValue,
  options: { readonly contentKey: string },
): Promise<void> {
  const platform = input.metadata.platform;
  const videoId = input.metadata.videoId;
  const contentKey = options.contentKey;
  const id = createContentContextId(platform, contentKey);
  const now = Date.now();
  const existing = await db.contentContexts.get(id);
  const record: ContentContextRecord = {
    id,
    schemaVersion: CONTENT_CONTEXT_SCHEMA_VERSION,
    platform,
    contentKey,
    videoId,
    kind: 'video',
    metadata: input.metadata,
    transcriptCues: input.transcriptCues,
    transcriptCueCount: input.transcriptCues.length,
    transcriptSource: input.transcriptSource,
    ...(input.language ? { language: input.language } : {}),
    subtitlePreferenceKey: input.subtitlePreferenceKey ?? createSubtitlePreferenceKey(undefined),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.contentContexts.put(record);
}
