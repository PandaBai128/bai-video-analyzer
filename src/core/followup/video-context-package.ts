import type {
  SubtitleCue,
  TimelineNode,
  UserAnnotation,
  VideoAnalysis,
  VideoChapter,
  VideoMetadata,
  VideoPlatform,
} from '@core/types';
import { getVideoMetadataContentKey } from '@shared/content-key';

/**
 * 追问时给 LLM 的"当前视频上下文包"。
 *
 * 来源：分析完成后从 `VideoAnalysis` 缓存 + 当前 `VideoMetadata` 构造；
 * 侧边栏追问时通过 `buildVideoContextPackage()` 读缓存组装。
 *
 * 设计原则：
 * - 字段全部 readonly + 来自现有分析结果，**不**新增存储 schema
 * - 写读一对：side panel / background 都可以从缓存还原
 * - 没有分析结果时 `buildVideoContextPackage()` 返回 `null`，让追问 UI
 *   明确显示"请先分析"
 *
 * Round 22 必修 A5：pkg 多了 `contentKey` 字段 —— 用于 B 站多 P 隔离。
 */
export interface VideoContextPackage {
  readonly platform: VideoPlatform;
  readonly videoId: string;
  /**
   * Round 22 必修 A5：内容身份 key。
   * - B 站：`<BV>:p=<page>`（默认 page=1）
   * - YouTube：videoId
   * 从 `metadata` 派生，不需调用方额外传。
   */
  readonly contentKey: string;
  readonly url: string;
  readonly title: string;
  readonly author: string;
  readonly duration?: number;
  readonly analysisMode: VideoAnalysis['sourceMode'];
  readonly overview: string;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly timeline: readonly TimelineNode[];
  readonly chapters: readonly VideoChapter[];
  readonly review: {
    readonly keyPoints: readonly string[];
    readonly summary: string;
  };
  readonly annotations: readonly UserAnnotation[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BuildVideoContextPackageInput {
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis;
  readonly transcriptCues?: readonly SubtitleCue[];
  readonly annotations?: readonly UserAnnotation[];
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

/**
 * 从已有 VideoAnalysis / metadata / transcript 构造 VideoContextPackage。
 *
 * 这是 side panel / background 共用的"组装"步骤：分析完成时构造一次，
 * 追问时读缓存还原。
 *
 * createdAt / updatedAt：调用方可以从缓存 record 拿；不传时 fall back 到
 * `analysis.generatedAt`。
 */
export function buildVideoContextPackage(
  input: BuildVideoContextPackageInput,
): VideoContextPackage {
  const createdAt = input.createdAt ?? input.analysis.generatedAt;
  const updatedAt = input.updatedAt ?? input.analysis.generatedAt;

  const reviewSummary = input.analysis.reviewSummary || '';
  const keyPoints = input.analysis.coreTakeaways;
  const cues = input.transcriptCues ?? [];
  const annotations = input.annotations ?? [];

  // Round 22 必修 A5：派生 contentKey 写入 pkg，方便后续校验。
  const contentKey = getVideoMetadataContentKey(input.metadata);

  const base = {
    platform: input.metadata.platform,
    videoId: input.metadata.videoId,
    contentKey,
    url: input.metadata.url,
    title: input.metadata.title,
    author: input.metadata.author,
    analysisMode: input.analysis.sourceMode,
    overview: input.analysis.overview,
    transcriptCues: cues,
    timeline: input.analysis.timeline,
    chapters: input.analysis.chapters,
    review: { keyPoints, summary: reviewSummary },
    annotations,
    createdAt,
    updatedAt,
  } as const;

  return typeof input.metadata.duration === 'number'
    ? { ...base, duration: input.metadata.duration }
    : base;
}

/**
 * 当前 video 是否已经有可用的追问上下文。空平台/无 videoId 一律视为没有。
 * 实际分析内容是否可用的"严格"判断在调用方做（侧边栏用 `analysis` 字段，
 * background 用 `analysis` 是否非空）。
 *
 * Round 22 必修 A5：expected 支持 `contentKey` 字段以做 B 站多 P 隔离校验。
 * - 调用方在 B 站多 P 场景下传 `contentKey`（形如 `BVxxx:p=10`）。
 * - 校验逻辑：expected.contentKey 跟 pkg.contentKey 比对（pkg.contentKey 在
 *   构造时从 metadata 派生）。
 */
export function isContextPackageValidFor(
  pkg: VideoContextPackage | null,
  expected: {
    readonly platform: VideoPlatform;
    readonly videoId: string;
    readonly contentKey?: string;
  },
): boolean {
  if (!pkg) {
    return false;
  }
  if (!pkg.videoId || !expected.videoId) {
    return false;
  }
  if (pkg.platform !== expected.platform) {
    return false;
  }
  if (expected.contentKey) {
    // B 站多 P：直接用 contentKey 比对。
    return pkg.contentKey === expected.contentKey;
  }
  // 兜底：单 videoId 比较（YouTube / 单 P 场景）。
  return pkg.videoId === expected.videoId;
}
