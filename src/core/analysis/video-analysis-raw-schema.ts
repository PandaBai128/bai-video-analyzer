import { z } from 'zod';
import { TIMELINE_CONTENT_TAGS, type TimelineContentTag, type TimelineNode, type VideoChapter } from '@core/types';

/**
 * 视频分析响应的 raw schema 与 Zod 解析。
 *
 * 职责范围：
 * - 定义 LLM / provider 返回的"原始"字段（cue id 锚点、importance 非标值映射）。
 * - 暴露 `rawVideoAnalysisSchema.parse` 入口供 video-analysis-schema 公共入口编排。
 *
 * 不负责：
 * - JSON 字符串修复 / fence 剥离：video-analysis-json-repair
 * - 重复顶层 key 合并：duplicate-top-level-keys
 * - 章节 / 时间线领域归一化与 fallback：video-analysis-normalize-result
 *
 * Round 23 必修 B2：cue id 锚点（startCueId / endCueId）作为模型新的时间依据，
 * 优先于 timestamp 字段；缺锚点错误由 mapCueIdsToTimestamps 抛出。
 */

/** 顶层 timeline 节点的原始 schema。 */
export type RawTimelineNode = {
  readonly timestamp: number;
  readonly endTimestamp?: number | undefined;
  readonly title: string;
  readonly summary: string;
  readonly importance: TimelineNode['importance'];
  readonly contentTag?: TimelineContentTag | undefined;
  readonly reasoning?: string | undefined;
  readonly watchPrompt?: string | undefined;
  readonly startCueId?: number | undefined;
  readonly endCueId?: number | undefined;
};

/** 章节的原始 schema。 */
export type RawVideoChapter = {
  readonly timestamp: number;
  readonly endTimestamp?: number | undefined;
  readonly title: string;
  readonly summary: string;
  readonly importance: VideoChapter['importance'];
  readonly contentTag?: TimelineContentTag | undefined;
  readonly watchGuide: string;
  readonly reflectionPrompt?: string | undefined;
  readonly startCueId?: number | undefined;
  readonly endCueId?: number | undefined;
  readonly segments: readonly RawTimelineNode[];
};

/**
 * importance 非标值映射（保留旧 schema 兼容）：
 * - `must-watch` / `recommended` / `optional` / `skip` 直通；
 * - `normal` / `important` 映射为 `recommended`；
 * - 其它一律回落到 `optional`。
 */
export const importanceSchema = z
  .string()
  .transform((value) => {
    if (value === 'must-watch' || value === 'recommended' || value === 'optional' || value === 'skip') {
      return value;
    }
    if (value === 'normal' || value === 'important') {
      return 'recommended';
    }
    return 'optional';
  })
  .pipe(z.enum(['must-watch', 'recommended', 'optional', 'skip']));

const timelineContentTagSet = new Set<string>(TIMELINE_CONTENT_TAGS);

/**
 * 内容类型标签独立于 importance。importance 只表达观看优先级，contentTag 只表达
 * 这一段"在讲什么类型的内容"。解析层允许少量中文/英文别名，避免模型偶发输出
 * 中文标签时整段失败。
 */
export const contentTagSchema = z
  .string()
  .transform((value): TimelineContentTag | undefined => {
    const normalized = value.trim().toLowerCase();
    if (timelineContentTagSet.has(normalized)) {
      return normalized as TimelineContentTag;
    }
    if (/概念|原理|理论|定义|concept|principle|theory/u.test(normalized)) {
      return 'concept';
    }
    if (/方法|步骤|框架|流程|技巧|操作要点|输出循环|手法|打法|method|steps|framework|process/u.test(normalized)) {
      return 'method';
    }
    if (/演示|实操|实战|效果展示|测试过程|demo|demonstration/u.test(normalized)) {
      return 'demo';
    }
    if (/案例|示例|例子|case|example/u.test(normalized)) {
      return 'case';
    }
    if (/配置|安装|设置|装备|配装|专武|武器|驱动盘|圣遗物|遗器|影画|命座|星魂|配队|加点|setup|config|install/u.test(normalized)) {
      return 'setup';
    }
    if (/工具|tool/u.test(normalized)) {
      return 'tool';
    }
    if (/对比|比较|comparison|compare/u.test(normalized)) {
      return 'comparison';
    }
    if (/经验|分享|心得|experience|share|story/u.test(normalized)) {
      return 'experience';
    }
    if (/总结|回顾|结论|summary|recap|conclusion/u.test(normalized)) {
      return 'summary';
    }
    if (/排错|调试|问题|troubleshoot|debug|debugging/u.test(normalized)) {
      return 'troubleshooting';
    }
    if (/过渡|铺垫|背景|引出|transition|background|intro/u.test(normalized)) {
      return 'transition';
    }
    if (/广告|赞助|推广|ad|sponsor/u.test(normalized)) {
      return 'ad';
    }
    return undefined;
  })
  .optional();

/** 顶层分析对象的 Zod schema。timestamp / endTimestamp 改选填让 cue-only 输入能通过。 */
export const rawVideoAnalysisSchema = z.object({
  overview: z.string().optional().default(''),
  watchStrategy: z.array(z.string()).optional().default([]),
  coreTakeaways: z.array(z.string()).default([]),
  reviewSummary: z.string().optional().default(''),
  chapters: z
    .array(
      z.object({
        timestamp: z.number().nonnegative().optional(),
        endTimestamp: z.number().nonnegative().optional(),
        title: z.string(),
        summary: z.string(),
        importance: importanceSchema.optional().default('recommended'),
        contentTag: contentTagSchema,
        watchGuide: z.string().optional().default(''),
        reflectionPrompt: z.string().optional(),
        startCueId: z.number().int().nonnegative().optional(),
        endCueId: z.number().int().nonnegative().optional(),
        segments: z
          .array(
            z.object({
              timestamp: z.number().nonnegative().optional(),
              endTimestamp: z.number().nonnegative().optional(),
              title: z.string(),
              summary: z.string(),
              importance: importanceSchema.optional().default('recommended'),
              contentTag: contentTagSchema,
              reasoning: z.string().optional(),
              watchPrompt: z.string().optional(),
              startCueId: z.number().int().nonnegative().optional(),
              endCueId: z.number().int().nonnegative().optional(),
            }),
          )
          .optional()
          .default([]),
      }),
    )
    .optional()
    .default([]),
  timeline: z
    .array(
      z.object({
        timestamp: z.number().nonnegative(),
        endTimestamp: z.number().nonnegative().optional(),
        title: z.string(),
        summary: z.string(),
        importance: importanceSchema.optional().default('recommended'),
        contentTag: contentTagSchema,
        reasoning: z.string().optional(),
        watchPrompt: z.string().optional(),
      }),
    )
    .default([]),
  quotes: z
    .array(
      z.object({
        timestamp: z.number().nonnegative(),
        text: z.string(),
      }),
    )
    .default([]),
  keyConcepts: z
    .array(
      z.object({
        term: z.string(),
        explanation: z.string(),
      }),
    )
    .default([]),
  inspirations: z.array(z.string()).default([]),
});
