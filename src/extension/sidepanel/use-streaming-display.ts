import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 流式输出的显示层缓冲。
 * canonical content 仍由状态机完整保存；这里仅让 UI 按固定节奏吐字。
 *
 * 不变量：
 * - `displayed.length <= content.length`。
 * - DONE / ERROR / abort 后会 drain，最终 `displayed === content`。
 * - delta 基于上一次同步进 pending 的 canonical 长度，不能用 `displayed.length`，
 *   否则快速连续 chunk 会把已经在 pending 中但尚未显示的内容重复加入。
 */
export interface UseStreamingDisplayOptions {
  /** canonical 完整 content，由 followup-state 更新。 */
  readonly content: string;
  /** 是否还在流式阶段。`false` 时立即 drain 剩余 buffer 并停 timer。 */
  readonly streaming: boolean;
  /** 每次 tick 抽多少个字符。中文字符按 1 个算，emoji / 表情按 1 个算。默认 4。 */
  readonly charsPerTick?: number;
  /** tick 间隔（ms）。默认 24ms，落在 16-40ms 区间中段。 */
  readonly tickMs?: number;
  /** 测试可注入：替代 setInterval（默认全局 setInterval）。 */
  readonly setIntervalFn?: typeof setInterval;
  /** 测试可注入：替代 clearInterval。 */
  readonly clearIntervalFn?: typeof clearInterval;
}

export interface UseStreamingDisplayResult {
  /** 当前应该渲染到 UI 的内容。 */
  readonly displayed: string;
}

export function useStreamingDisplay(options: UseStreamingDisplayOptions): UseStreamingDisplayResult {
  const {
    content,
    streaming,
    charsPerTick = DEFAULT_CHARS_PER_TICK,
    tickMs = DEFAULT_TICK_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  const [displayed, setDisplayed] = useState<string>(content);
  // pending 累计 = "canonical 走到这里后还没显示" 的字符。
  // 用 ref 避免 setState 异步导致 buffer 丢失。
  const pendingRef = useRef<string>('');
  /** 上一次同步进 pending 的 canonical content 长度。 */
  const lastSyncedContentLengthRef = useRef<number>(content.length);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearIntervalFn(timerRef.current);
      timerRef.current = null;
    }
  }, [clearIntervalFn]);

  // 把"canonical 增长但还没显示"的部分塞进 buffer。
  // 用 effect 同步当前 canonical 到 pendingRef / displayed。
  // 故意不在 deps 里加 displayed——它会因 tick 反复变，导致 effect 反复跑挂起无限循环。
  // 真正的同步点是 content 变化。displayed 的变化由 setDisplayed 自己处理。
  useEffect(() => {
    const previousLength = lastSyncedContentLengthRef.current;
    if (content.length > previousLength) {
      // 正常追加：用 lastSyncedContentLength 算 delta，不能用 displayed.length。
      const delta = content.slice(previousLength);
      pendingRef.current = pendingRef.current + delta;
      lastSyncedContentLengthRef.current = content.length;
    } else if (content.length < previousLength) {
      // 缩短 / 重置：清空 buffer、displayed 直接同步到新 content、ref 重置
      pendingRef.current = '';
      lastSyncedContentLengthRef.current = content.length;
      setDisplayed(content);
    }
    // content.length === previousLength：内容**没**增长，**不**做任何处理（避免
    // 同长度不同内容时误判为 reset）。如果上层重传了等长但内容不同，应走其他
    // 路径（如 abort + 重新提交）。
  }, [content]);

  // streaming / tick 参数变化时维护 timer。
  // 关键：deps 里**不放** content。content 变化时新 chunk 由第一个 effect 同步进
  // pendingRef；这里只需要关心"是否要起 / 停 timer"。
  useEffect(() => {
    if (!streaming) {
      // drain：把 buffer 一次性刷出，再停 timer。
      stopTimer();
      if (pendingRef.current.length > 0) {
        const drained = pendingRef.current;
        pendingRef.current = '';
        // 重要：drain 用 functional update 拿到最新 displayed，避免覆盖 tick 期间的增长。
        setDisplayed((current) => current + drained);
      }
      // 即使 pending 为空，也要确保 displayed 跟 content 对齐（防御：上层已经把
      // content 推到位但 pending 当时是空的话，displayed 也可能落后 0..n 字符）。
      setDisplayed((current) => (current === content ? current : content));
      return;
    }

    // 已经在 tick：内容变化时新 chunks 自动入 buffer，timer 会追上。
    if (timerRef.current !== null) {
      return;
    }

    // 开 tick：每 tickMs 从 buffer 抽 charsPerTick 个字符
    timerRef.current = setIntervalFn(() => {
      if (pendingRef.current.length === 0) {
        // 临时 idle：buffer 空但还在 streaming（等下一 chunk），不关 timer（成本可忽略）
        return;
      }
      const slice = pendingRef.current.slice(0, charsPerTick);
      pendingRef.current = pendingRef.current.slice(slice.length);
      setDisplayed((current) => current + slice);
    }, tickMs);

    return () => {
      stopTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, tickMs, charsPerTick, setIntervalFn, stopTimer]);

  // 卸载兜底：即使上层忘了把 streaming 设 false，组件 unmount 也会清掉 timer。
  useEffect(() => {
    return () => {
      stopTimer();
      pendingRef.current = '';
      lastSyncedContentLengthRef.current = 0;
    };
  }, [stopTimer]);

  return { displayed };
}

const DEFAULT_CHARS_PER_TICK = 4;
const DEFAULT_TICK_MS = 24;
