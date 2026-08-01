import Dexie, { type Table } from 'dexie';
import type {
  ContentContext,
  LearningSession,
  AnalysisTiming,
  SubtitleCue,
  VideoAnalysis,
  VideoMetadata,
  VideoPlatform,
} from '@core/types';
import type { UiLocale } from '@shared/locale-settings';

export interface AnalysisCacheRecord {
  readonly id: string;
  readonly schemaVersion?: number;
  readonly platform: VideoPlatform;
  readonly videoId: string;
  /**
   * Round 22 必修 A3：内容身份 key。
   *
   * - B 站多 P 视频：`<BV>:p=<page>`（默认 page=1）
   * - YouTube：videoId
   *
   * 旧缓存（schemaVersion < 11）没有这个字段，按 schema mismatch 处理为过期
   * 缓存，不会被新代码读到。
   */
  readonly contentKey: string;
  readonly sourceMode: VideoAnalysis['sourceMode'];
  readonly outputLocale?: UiLocale;
  readonly metadata: VideoMetadata;
  readonly analysis: VideoAnalysis;
  readonly subtitleCueCount: number;
  /**
   * Round 16 必修 1：缓存完整字幕 cue 列表。schema 升 v10 后旧缓存无此字段会被
   * 视为过期，side panel 提示用户重新分析一次。
   */
  readonly transcriptCues?: readonly SubtitleCue[];
  /** 生成分析时生效的浏览器字幕语言偏好；缺失的旧缓存不可恢复。 */
  readonly subtitlePreferenceKey?: string;
  readonly timings?: readonly AnalysisTiming[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContentContextRecord {
  readonly id: string;
  readonly schemaVersion: number;
  readonly platform: VideoPlatform;
  readonly contentKey: string;
  readonly videoId: string;
  readonly kind: ContentContext['kind'];
  readonly metadata: VideoMetadata;
  readonly transcriptCues: readonly SubtitleCue[];
  readonly transcriptCueCount: number;
  readonly transcriptSource: ContentContext['transcriptSource'];
  readonly language?: string;
  readonly subtitlePreferenceKey?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class BAIDatabase extends Dexie {
  analysisCache!: Table<AnalysisCacheRecord, string>;
  learningSessions!: Table<LearningSession, string>;
  vaultSettings!: Table<VaultSettingsRecord, string>;
  exportRecords!: Table<ExportRecord, string>;
  contentContexts!: Table<ContentContextRecord, string>;

  constructor() {
    super('bai-browser-assistant');

    this.version(1).stores({
      analysisCache: 'id, [platform+videoId], updatedAt',
      annotations: 'id, [platform+videoId], createdAt',
    });

    this.version(2).stores({
      reflectionSessions: 'id, [platform+videoId], updatedAt',
    });

    this.version(3).stores({
      vaultSettings: 'id, updatedAt',
    });

    this.version(4).stores({
      exportRecords: 'id, [platform+videoId], exportedAt',
    });

    this.version(5).stores({
      analysisCache: 'id, [platform+videoId], [platform+videoId+sourceMode], updatedAt',
    });

    // Round 22 必修 A3：analysisCache 引入 [platform+contentKey] 索引。
    this.version(6).stores({
      analysisCache:
        'id, [platform+videoId], [platform+contentKey], [platform+contentKey+sourceMode], updatedAt',
    });

    // Round 24 必修 D + 必修 E：删除 `annotations` 表（边看边记片段记录能力废弃）。
    // Dexie 的 stores() 声明**当前应有的表**；要在新版本里**删除**旧表，
    // 必须显式声明 `<表名>: null`，否则旧表仍保留。
    // （Codex 用 fake-indexeddb 验证过："省略旧表 ≠ 删除旧表"。）
    this.version(7).stores({
      annotations: null,
      analysisCache:
        'id, [platform+videoId], [platform+contentKey], [platform+contentKey+sourceMode], updatedAt',
      reflectionSessions: 'id, [platform+videoId], updatedAt',
      vaultSettings: 'id, updatedAt',
      exportRecords: 'id, [platform+videoId], exportedAt',
    });

    // Round 29A 必修 A：新增 `contentContexts` 表（"一个内容底座，多种派生产物"）。
    // - id 形如 `${platform}:${contentKey}`（B 站多 P / YouTube videoId 隔离）
    // - 索引：[platform+contentKey]（主查询路径）+ updatedAt（按时间排序）
    // - 存 metadata + transcriptCues 大文本 + 字幕来源 / 语言 / 时间戳
    // - 派生产物（timeline / review）**不**存这里；**引用** id 即可
    this.version(8).stores({
      contentContexts: 'id, [platform+contentKey], updatedAt',
      analysisCache:
        'id, [platform+videoId], [platform+contentKey], [platform+contentKey+sourceMode], updatedAt',
      reflectionSessions: 'id, [platform+videoId], updatedAt',
      vaultSettings: 'id, updatedAt',
      exportRecords: 'id, [platform+videoId], exportedAt',
    });

    // 学习笔记重构：旧 reflectionSessions 只保存“问题/回答”，无法承载目标、
    // 时间点记录、提问轨迹和最终学习笔记，因此直接停止使用并删除旧表。
    this.version(9).stores({
      reflectionSessions: null,
      learningSessions: 'id, [platform+videoId], updatedAt',
      contentContexts: 'id, [platform+contentKey], updatedAt',
      analysisCache:
        'id, [platform+videoId], [platform+contentKey], [platform+contentKey+sourceMode], updatedAt',
      vaultSettings: 'id, updatedAt',
      exportRecords: 'id, [platform+videoId], exportedAt',
    });

    this.version(10).stores({
      learningSessions: 'id, [platform+videoId], updatedAt',
      contentContexts: 'id, [platform+contentKey], updatedAt',
      analysisCache:
        'id, [platform+videoId], [platform+contentKey], [platform+contentKey+sourceMode], [platform+contentKey+sourceMode+outputLocale], updatedAt',
      vaultSettings: 'id, updatedAt',
      exportRecords: 'id, [platform+videoId], exportedAt',
    });
  }
}

export const db = new BAIDatabase();

export interface VaultSettingsRecord {
  readonly id: 'default';
  readonly directoryName: string;
  readonly directoryHandle: FileSystemDirectoryHandle;
  readonly updatedAt: number;
}

export interface ExportRecord {
  readonly id: string;
  readonly platform: VideoPlatform;
  readonly videoId: string;
  readonly folderName: string;
  readonly exportedAt: number;
}
