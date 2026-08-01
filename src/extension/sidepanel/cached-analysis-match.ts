import type { AnalysisMode } from '@shared/settings';
import type { PageContext } from '@shared/page-context';
import type { VideoMetadata } from '@core/types';
import type { VideoAnalysis } from '@core/types';
import { getPageContextContentKey, getVideoMetadataContentKey } from '@shared/content-key';

interface CachedAnalysisShape {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis;
}

/**
 * 决定给定的缓存分析结果是否仍属于当前 side panel 视图（页面 + 模式）。
 *
 * 同平台、同视频、同 contentKey、同分析模式才命中；B 站多 P 依赖 contentKey 隔离。
 */
export function isCachedAnalysisForCurrentView(
  cached: CachedAnalysisShape | null | undefined,
  context: PageContext | null,
  analysisMode: AnalysisMode,
): boolean {
  if (!cached) {
    return false;
  }
  if (!context) {
    return false;
  }
  if (!context.videoId) {
    return false;
  }
  if (cached.metadata.platform !== context.platform) {
    return false;
  }
  if (cached.metadata.videoId !== context.videoId) {
    return false;
  }
  // 任一侧缺 contentKey 时降级；正常缓存会带 contentKey，用于多 P 隔离。
  const cachedKey = getVideoMetadataContentKey(cached.metadata);
  const contextKey = getPageContextContentKey(context);
  if (contextKey && contextKey !== cachedKey) {
    return false;
  }
  // 公开版只恢复当前字幕分析缓存；旧 transcript / multimodal 缓存不进入当前视图。
  if (cached.analysis.sourceMode !== analysisMode) {
    return false;
  }
  return true;
}
