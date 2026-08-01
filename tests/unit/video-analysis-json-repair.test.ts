import { describe, expect, it } from 'vitest';
import {
  mergeDuplicateTopLevelKeys,
  stripJsonFence,
} from '@core/analysis/video-analysis-schema';

/**
 * SG-05A：fence / thinking 标签剥离 + 重复顶层 key 合并的行为测例。
 *
 * 仅迁入原 video-analysis-schema.test.ts 中 `stripJsonFence` / `mergeDuplicateTopLevelKeys`
 * 两个 describe 块（共 8 条测例）。这是按职责拆出来的最小集合：
 * - `stripJsonFence`（2 条）：markdown fence + 思考标签剥离；
 * - `mergeDuplicateTopLevelKeys`（6 条）：无重复不动 / 数组拼接 / 跨 key 拼接 /
 *   畸形跳过 / 真实"时间线从 18 分钟才开始"修复 / 非 JSON 不动。
 *
 * 任务单 §5 要求"不为每个私有 helper 建 1:1 测试"——本文件**不**为 json-repair 模块内
 * 的 `parseJsonWithRepair` / `escapeLooseStringQuotes` / `isLikelyClosingStringQuote` /
 * `extractLikelyJson` / `createJsonParseError` / `enhanceJsonParseError` 等私有 helper
 * 单独建测例；这些 helper 的端到端行为已由 `video-analysis-schema.test.ts` 的
 * `parseVideoAnalysisJson` 测例覆盖（含错误信息结构、thinking 标签、raw response 诊断等）。
 *
 * 公共入口 `@core/analysis/video-analysis-schema` 仍 re-export `stripJsonFence` 和
 * `mergeDuplicateTopLevelKeys`，测试**不**锁定内部模块位置。
 */

describe('stripJsonFence', () => {
  it('removes markdown json fences', () => {
    expect(stripJsonFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  it('removes MiniMax thinking tags before json parsing', () => {
    expect(stripJsonFence('<think>先分析一下</think>\n{"ok":true}')).toBe('{"ok":true}');
  });
});

describe('mergeDuplicateTopLevelKeys', () => {
  it('returns input unchanged when there are no duplicates', () => {
    const input = '{"chapters":[1,2,3],"coreTakeaways":["a"]}';
    expect(mergeDuplicateTopLevelKeys(input)).toBe(input);
  });

  it('concatenates well-formed duplicate chapter arrays', () => {
    const input = '{"chapters":[1,2,3],"chapters":[4,5,6],"coreTakeaways":["a"]}';
    const merged = mergeDuplicateTopLevelKeys(input);
    expect(merged).toBe('{"chapters":[1,2,3,4,5,6],"coreTakeaways":["a"]}');
  });

  it('concatenates well-formed duplicate coreTakeaways arrays', () => {
    const input = '{"coreTakeaways":["x"],"coreTakeaways":["y","z"]}';
    const merged = mergeDuplicateTopLevelKeys(input);
    expect(merged).toBe('{"coreTakeaways":["x","y","z"]}');
  });

  it('does not modify the text when values are malformed (jsonrepair fallback handles those)', () => {
    // 第一个 chapters array 缺 `]`，第二个重复 key 写在了第一个 array 里面（更深的畸形）。
    // 这种 case 强行合并会破坏整体可解析性，应该让 jsonrepair 单独跑。
    const input = '{"chapters":[{"ts":0}],"chapters":[{"ts":1}]}';
    const result = mergeDuplicateTopLevelKeys(input);
    // 应该被检测为"至少一个 value 畸形"并跳过合并 —— 输出应当至少能 JSON.parse
    // 出第一个 chapters array 的内容（保留前 9 个 chapters）
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('recovers from the "时间线从 18 分钟才开始" bug: merges a duplicate chapters key back to the first', () => {
    // 用户实际遇到的 case：模型输出两个 `"chapters":` key，第二个被静默忽略，
    // 导致 chapters 从中段开始。本预处理器应该把两个 array 拼起来。
    const input =
      '{"chapters":[{"ts":0},{"ts":1}],"chapters":[{"ts":1112},{"ts":1246}],"coreTakeaways":["x"]}';
    const merged = mergeDuplicateTopLevelKeys(input);
    const parsed = JSON.parse(merged) as { chapters: Array<{ ts: number }>; coreTakeaways: string[] };
    expect(parsed.chapters.map((c) => c.ts)).toEqual([0, 1, 1112, 1246]);
    expect(parsed.coreTakeaways).toEqual(['x']);
  });

  it('returns input unchanged for non-JSON text', () => {
    const input = 'not json at all';
    expect(mergeDuplicateTopLevelKeys(input)).toBe(input);
  });
});
