import type { PageContext } from '@shared/page-context';
import type { VideoMetadata } from '@core/types';

/**
 * Round 22 必修 A2：统一取"内容身份 key"的纯函数。
 *
 * 规则（**唯一来源**，不要在别处手写拼接）：
 * - `PageContext.contentKey` 优先（detectPageContext 已经派生好）
 * - B 站 `VideoMetadata`：用 `platformSpecific.page` 拼 `${videoId}:p=${page}`；
 *   缺失时回落 `${videoId}:p=1`
 * - YouTube：用 `videoId`
 * - 其它平台：返回 `videoId`（兜底）
 *
 * 为什么这个函数：
 * - 缓存 key、追问 key、标注 / 反思的 storage identity 都需要它
 * - 用纯函数 + 单元测试覆盖：缺 page、含 page=0、含 page=10 都要正确
 *
 * 注意：PageContext.contentKey 来自 detectPageContext，**已经**对 `?p=abc` 等
 * 无效值回落 1，所以 PageContext 的输入永远比 VideoMetadata 的更稳 —— 后者
 * 是从 adapter 回来的 metadata，需要再次防御。
 */
export function getPageContextContentKey(context: PageContext | null | undefined): string | undefined {
  if (!context) {
    return undefined;
  }
  if (context.contentKey) {
    return context.contentKey;
  }
  if (!context.videoId) {
    return undefined;
  }
  if (context.platform === 'bilibili') {
    const page = readBilibiliPageFromPlatformSpecific(context.platformSpecific);
    return `${context.videoId}:p=${page}`;
  }
  return context.videoId;
}

/**
 * 从 `VideoMetadata` 派生 contentKey。
 *
 * 用于 `saveCachedAnalysis()` / `getCachedAnalysis()` 的保存/读取路径 —— metadata
 * 是缓存的存储主键，contentKey 不能用 PageContext 的 contentKey（怕 PageContext
 * 之后又改），必须基于 metadata 自己派生。
 */
export function getVideoMetadataContentKey(metadata: VideoMetadata): string {
  if (metadata.platform === 'bilibili') {
    const page = readBilibiliPageFromPlatformSpecific(metadata.platformSpecific);
    return `${metadata.videoId}:p=${page}`;
  }
  return metadata.videoId;
}

function readBilibiliPageFromPlatformSpecific(
  platformSpecific: VideoMetadata['platformSpecific'] | undefined,
): number {
  const raw = platformSpecific?.page;
  if (typeof raw !== 'number') {
    return 1;
  }
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Round 29A 必修 C：判断 PageContext.platform 是否支持内容底座。
 * 与 `isSupportedTimelinePlatform` 范围一致（bilibili / youtube），但语义上
 * 内容底座跟"时间线生成"无关——只跟"是否有字幕可抓"有关，所以单独提一个
 * 纯函数让 sidepanel 调用方按需 import，不耦合 timeline-request-context 模块。
 */
export function isSupportedContentContextPlatform(
  platform: PageContext['platform'] | null | undefined,
): platform is 'bilibili' | 'youtube' {
  return platform === 'bilibili' || platform === 'youtube';
}
