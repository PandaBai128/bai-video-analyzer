import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStreamingDisplay } from '@extension/sidepanel/use-streaming-display';

interface FakeClock {
  now: number;
  /** 注册的所有 timer。 */
  readonly timers: Array<{
    cb: () => void;
    intervalMs: number;
    lastFiredAt: number;
    cleared: boolean;
  }>;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** 推进到 now = targetTime。触发所有 lastFiredAt < firePoint <= targetTime 的 timer。 */
  advanceTo: (targetTime: number) => void;
}

function makeFakeClock(): FakeClock {
  const timers: FakeClock['timers'] = [];
  let nextId = 1;
  const handles = new Map<number, FakeClock['timers'][number]>();
  return {
    now: 0,
    timers,
    setInterval: (cb: () => void, ms: number): unknown => {
      const t = {
        cb,
        intervalMs: ms,
        lastFiredAt: 0,
        cleared: false,
      };
      timers.push(t);
      const id = nextId++;
      handles.set(id, t);
      return id;
    },
    clearInterval: (handle: unknown): void => {
      const t = handles.get(handle as number);
      if (t) {
        t.cleared = true;
      }
    },
    advanceTo: (targetTime: number): void => {
      // 真实 setInterval 是周期性的：每个 tick 间隔都触发。
      // 简化：对每个 timer，从 lastFiredAt 开始，按 intervalMs 累加到 targetTime，
      // 期间每跨过一个 firePoint 就调一次 cb。
      for (const t of timers) {
        if (t.cleared) continue;
        const interval = t.intervalMs;
        if (interval <= 0) continue;
        // 下一个 firePoint = lastFiredAt + interval
        let nextFire = t.lastFiredAt + interval;
        while (nextFire <= targetTime) {
          t.lastFiredAt = nextFire;
          t.cb();
          if (t.cleared) break;
          nextFire = t.lastFiredAt + interval;
        }
      }
    },
  };
}

let clock: FakeClock;
let setIntervalSpy: ReturnType<typeof vi.fn>;
let clearIntervalSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clock = makeFakeClock();
  setIntervalSpy = vi.fn((cb: () => void, ms: number) => clock.setInterval(cb, ms));
  clearIntervalSpy = vi.fn((h: unknown) => clock.clearInterval(h));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function clockInject(): {
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
} {
  return {
    setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
    clearIntervalFn: clearIntervalSpy as unknown as typeof clearInterval,
  };
}

describe('useStreamingDisplay (Round 14 建议同轮做：显示层平滑)', () => {
  it('测试 5a：streaming=true 一次来大 chunk，分批吐出，最终内容完整', () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );

    // 起 streaming
    rerender({ content: '', streaming: true });
    // 一次性来 30 字符（小于 50 字符以保证不会在单次 setInterval tick 内被 React 批处理吃光）
    const bigChunk = '这是一段很长的回答，三十个字符，分批测试一下。';
    expect(bigChunk.length).toBeGreaterThan(12);
    rerender({ content: bigChunk, streaming: true });

    // 期望：分批。刚开始 displayed 还应小于 content（分批未追上）
    // 注意：第一次 useEffect 把 content 增量塞 pendingRef；timer 还没开始 tick
    // → 此时 displayed 可能仍然 < content，pendingRef 里有 30 字符
    expect(result.current.displayed.length).toBeLessThanOrEqual(bigChunk.length);

    // 推进一段时间：displayed 应当增加但**仍小于** content（分批效果）
    act(() => {
      clock.advanceTo(60);
    });
    const midLen = result.current.displayed.length;
    expect(midLen).toBeGreaterThan(0);
    expect(midLen).toBeLessThan(bigChunk.length);

    // 推进到足够长：应追上 content，最终内容**完整**（不丢字符）
    act(() => {
      clock.advanceTo(2_000);
    });
    expect(result.current.displayed).toBe(bigChunk);
  });

  it('测试 5b：streaming=false（DONE）立即 drain 剩余 buffer', () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );

    // streaming + 来 30 字符
    rerender({ content: '', streaming: true });
    const text = '一句话回答，二十多个字，足够测试。';
    rerender({ content: text, streaming: true });
    // 推进一点时间
    act(() => {
      clock.advanceTo(24);
    });
    const partiallyShown = result.current.displayed.length;
    expect(partiallyShown).toBeGreaterThan(0);
    expect(partiallyShown).toBeLessThan(text.length);

    // 收尾：streaming=false → drain 立即同步生效
    act(() => {
      rerender({ content: text, streaming: false });
    });
    expect(result.current.displayed).toBe(text);
  });

  it('测试 5c：卸载 / streaming=false 不会留 setInterval（cleanup 验证）', () => {
    const { rerender, unmount } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );

    rerender({ content: 'hello', streaming: true });
    // 注册了 setInterval
    expect(setIntervalSpy).toHaveBeenCalled();
    const initialCalls = setIntervalSpy.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    // 卸载 → clearInterval 必被调用
    unmount();
    // clearInterval 至少被调用过一次（清理 timer）
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('测试 5d：连续多个 chunk 累积，displayed 不超过 content', () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );
    rerender({ content: '', streaming: true });
    rerender({ content: '第一段回答。', streaming: true });
    act(() => clock.advanceTo(48));
    // 不变量：displayed <= content
    expect(result.current.displayed.length).toBeLessThanOrEqual('第一段回答。'.length);
    // 至少追上 1 字符（开始 tick）
    expect(result.current.displayed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Round 29B QA 必修 A：连续 chunk 到达但 displayed 未追上时不重复 pending
// ---------------------------------------------------------------------------

describe('useStreamingDisplay (Round 29B QA 必修 A 修复 P1 重复显示 bug)', () => {
  it('QA-A1: 连续 chunk 到达但 displayed 未追上时不重复 pending', () => {
    // 验收：场景重现 P1 bug 的根因路径
    //   1. content = "视频核心\nA"，displayed 还没 tick（仍是 ''），pending = '视频核心\nA'
    //   2. 立刻 rerender content = "视频核心\nA\n时间线\nB"
    //   3. 旧逻辑用 displayed.length=0 算 delta → '视频核心\nA\n时间线\nB' 全部塞进 pending
    //   4. pending 变成 "视频核心\nA视频核心\nA\n时间线\nB"
    //   5. tick 抽完 displayed = "...视频核心\nA视频核心\nA\n时间线\nB"（重复）
    // 修复后：delta 必须基于"上一次同步进 pending 的 canonical 长度"，不重复。
    const { result, rerender } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );
    // 起 streaming，第一次 chunk
    rerender({ content: '', streaming: true });
    rerender({ content: '视频核心\nA', streaming: true });
    // 不推进 clock，让 displayed 维持空 / 极小（pending 里有"视频核心\nA"待显示）

    // 立刻来第二个 chunk（关键场景：在第一次 tick 前又增长）
    rerender({ content: '视频核心\nA\n时间线\nB', streaming: true });
    // 此时 pending 应该是 "视频核心\nA\n时间线\nB"，**不**应该是
    // "视频核心\nA视频核心\nA\n时间线\nB"（旧 bug 的重复状态）

    // 推进足够时间让 tick 把 pending 抽干
    act(() => {
      clock.advanceTo(2_000);
    });

    // 关键断言：最终 displayed === 完整 finalContent，**不**含重复前缀
    expect(result.current.displayed).toBe('视频核心\nA\n时间线\nB');
    expect(result.current.displayed).not.toMatch(/视频核心[\s\S]*视频核心/);
  });

  it('QA-A2: 连续多个快速 chunk 后 displayed 长度不超过 canonical content.length', () => {
    // 验收：连续 4 次 content 增长，每次 displayed 未必追上，ticking 后
    // 任意时刻 displayed.length ≤ content.length。
    const { result, rerender } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );
    rerender({ content: '', streaming: true });
    const chunks = [
      '视频核心：搜索',
      '视频核心：搜索算法的',
      '视频核心：搜索算法的核心思想',
      '视频核心：搜索算法的核心思想与实',
    ];
    for (const c of chunks) {
      rerender({ content: c, streaming: true });
      // 不推进 clock（模拟"chunk 来太快 tick 没追上"）
    }
    // 推进一段
    act(() => clock.advanceTo(120));
    expect(result.current.displayed.length).toBeLessThanOrEqual(
      chunks[chunks.length - 1]!.length,
    );
    // 推进到完全 drain
    act(() => clock.advanceTo(5_000));
    // 关键：drain 后 displayed === 最终 content，**不**超长、不重复
    expect(result.current.displayed).toBe(chunks[chunks.length - 1]);
  });

  it('QA-A3: DONE/drain 后不保留重复', () => {
    // 验收：streaming=true 时快速增长两次 → 立刻 streaming=false drain
    // 旧 bug 路径：drain 时会把 pending 里**已经**重复的内容再刷一次
    // 修复后：drain 一次性刷出剩余、最终 displayed === finalContent。
    const { result, rerender } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );
    rerender({ content: '', streaming: true });
    rerender({ content: '视频核心\nA', streaming: true });
    // 不推进 clock：保持 pending 里有"视频核心\nA"、displayed 仍空
    rerender({ content: '视频核心\nA\n时间线\nB', streaming: true });
    // 立刻 DONE（关键：tick 一次都没跑就 drain）
    act(() => {
      rerender({ content: '视频核心\nA\n时间线\nB', streaming: false });
    });
    expect(result.current.displayed).toBe('视频核心\nA\n时间线\nB');
    expect(result.current.displayed).not.toMatch(/视频核心[\s\S]*视频核心/);
  });

  it('QA-A4: content 缩短 / reset 后 displayed 立即同步到新 content（不保留旧 pending）', () => {
    // 验收：abort / 重新提交路径 —— content 缩短时立即 reset
    const { result, rerender } = renderHook(
      ({ content, streaming }: { content: string; streaming: boolean }) =>
        useStreamingDisplay({ content, streaming, tickMs: 24, charsPerTick: 4, ...clockInject() }),
      { initialProps: { content: '', streaming: false } },
    );
    rerender({ content: '', streaming: true });
    rerender({ content: '旧内容先填一点', streaming: true });
    act(() => clock.advanceTo(24));
    // 此时 displayed 是 "旧内容先" + 部分 pending
    const before = result.current.displayed;
    expect(before.startsWith('旧内容先')).toBe(true);
    // 重新提交：新 content 更短
    rerender({ content: '新', streaming: true });
    // 缩短 → 清空 pending + displayed 同步到新 content
    expect(result.current.displayed).toBe('新');
  });
});
