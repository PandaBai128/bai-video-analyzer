/**
 * Round 16 必修 3：解析 LLM 回答里"可点击跳转"的时间点。
 *
 * 支持形式（按 prompt 规定优先支持 bracket）：
 *   - `[03:20]`           → 跳 200s
 *   - `[03:20-04:10]`     → 跳 200s（取开始时间）
 *   - `[1:02:11]`         → 跳 3731s
 *   - `[1:02:11-1:05:30]` → 跳 3731s
 *
 * 保守地不解析：
 *   - 2026-06-12 这种 dash 形式（语义是日期）
 *   - Markdown 链接 URL 里的数字
 *   - 数字 + 单位（"3 分钟前"、"5GB"）
 *   - 1.2 / 0.5 这种带小数点的数字
 *   - 单纯 "3:20"（裸 mm:ss 不带方括号）—— prompt 提示里也是 bracket 形式，
 *     加裸 mm:ss 容易误伤"12:30 后"之类的句尾时间。如果后续真有需求，再加。
 *
 * 函数：
 *   - `parseTimestampToSeconds(text)`：纯函数，把 "mm:ss" / "hh:mm:ss" 解析成秒数。
 *   - `extractTimestampReferences(markdown)`：扫整段 markdown，返回 {start, end?, raw} 数组。
 *
 * 跳转换（render side）由 MarkdownMessage 完成；这个文件只负责解析。
 */

/**
 * 严格 mm:ss 格式：mm ∈ [0-999]，ss ∈ [00-59]。比 select-followup-context 里
 * 的同名 regex 严格，**不**允许 99:99 这种"两位数都过 59"的非法时间。
 */
const MMSS_STRICT = /(\d{1,3}):([0-5]\d)/;
/** 严格 hh:mm:ss 格式：hh ∈ [0-99]，mm/ss ∈ [00-59]。 */
const HHMMSS_STRICT = /(\d{1,2}):([0-5]\d):([0-5]\d)/;

/**
 * Bracket 时间点 + 可选 dash 区间。
 *
 * 不直接用一个大 alternation（HHMMSS|MMSS）×（HHMMSS|MMSS）——会让 capture
 * group 编号极难维护。改用两个独立子串：可选的前缀时间点 + 可选的 `-` 区间。
 * 再用两遍 regex：
 *   1. 先找 `[<ts>]` 或 `[<ts>-<ts>]` 整体
 *   2. 对 start / end 各自 `parseTimestampToSeconds`
 */
const BRACKET_PATTERN = /\[(\d{1,3}(?::[0-5]\d){1,2})(?:-(\d{1,3}(?::[0-5]\d){1,2}))?\]/g;

export interface TimestampReference {
  /** 跳转起始秒数（区间形式时取左端）。 */
  readonly start: number;
  /** 区间右端秒数；单点形式时 undefined。 */
  readonly end?: number;
  /** 原始 markdown 文本，例如 `[03:20-04:10]`。 */
  readonly raw: string;
  /** 在 markdown 字符串里的字符偏移（0-indexed），方便上层替换。 */
  readonly index: number;
}

/**
 * 解析 `mm:ss` / `hh:mm:ss` 字符串为秒数。
 * 解析失败返回 null。
 */
/**
 * 解析 `mm:ss` / `hh:mm:ss` 字符串为秒数。
 * 解析失败返回 null。
 */
export function parseTimestampToSeconds(text: string): number | null {
  if (!text) {
    return null;
  }
  const hhMatch = HHMMSS_STRICT.exec(text);
  if (hhMatch) {
    const h = Number.parseInt(hhMatch[1] ?? '0', 10);
    const m = Number.parseInt(hhMatch[2] ?? '0', 10);
    const s = Number.parseInt(hhMatch[3] ?? '0', 10);
    if (h >= 0 && m >= 0 && s >= 0) {
      return h * 3600 + m * 60 + s;
    }
    return null;
  }
  const mmMatch = MMSS_STRICT.exec(text);
  if (mmMatch) {
    const m = Number.parseInt(mmMatch[1] ?? '0', 10);
    const s = Number.parseInt(mmMatch[2] ?? '0', 10);
    if (m >= 0 && s >= 0) {
      return m * 60 + s;
    }
    return null;
  }
  return null;
}

/**
 * Round 16 必修 3：`bai-seek://{seconds}` 内部协议用纯数字秒数。
 *
 * 单独一个 parser（不复用 `parseTimestampToSeconds`），避免在 urlTransform
 * 白名单里被误以为是 mm:ss 格式而落到"非法"分支。
 */
export function parseSeekSeconds(text: string): number | null {
  if (!text) {
    return null;
  }
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

export function extractTimestampReferences(markdown: string): readonly TimestampReference[] {
  if (!markdown) {
    return [];
  }
  // 跳过 fenced code block（```...```）和 inline code（`...`），避免误伤代码示例。
  // 策略：先把代码块替换成等长空白（保持 index 不偏移），再扫。
  const sanitized = maskCodeRanges(markdown);
  const results: TimestampReference[] = [];
  for (const match of sanitized.matchAll(BRACKET_PATTERN)) {
    const startText = match[1] ?? '';
    const endText = match[2];
    const start = parseTimestampToSeconds(startText);
    if (start === null) {
      continue;
    }
    const end = endText ? parseTimestampToSeconds(endText) : null;
    if (endText && end === null) {
      // 区间右端解析失败 → 整体跳过（避免渲染 [03:20-99:99] 误跳）
      continue;
    }
    results.push({
      start,
      ...(typeof end === 'number' ? { end } : {}),
      raw: match[0],
      index: match.index ?? 0,
    });
  }
  return results;
}

/**
 * 把 markdown 里的 fenced code block（```...```）和 inline code（`...`）替换成
 * 等长空白，让 matchAll 跳过这些区域。
 *
 * 保持 index 不偏移：fenced 用 `\n` 数量对齐，inline code 用 ` ` 数量对齐。
 */
function maskCodeRanges(markdown: string): string {
  let out = '';
  let i = 0;
  while (i < markdown.length) {
    // fenced code: ```...\n...```
    if (markdown.startsWith('```', i)) {
      const end = markdown.indexOf('```', i + 3);
      if (end === -1) {
        // 没闭合的 fence 直接吞掉
        return out + ' '.repeat(markdown.length - i);
      }
      const block = markdown.slice(i, end + 3);
      out += block.replace(/[^\n]/g, ' ');
      i = end + 3;
      continue;
    }
    // inline code: `...`
    if (markdown[i] === '`') {
      // 多个反引号开头（``x``）也视为 inline code 区
      let run = 0;
      while (i + run < markdown.length && markdown[i + run] === '`') {
        run += 1;
      }
      const closing = '`'.repeat(run);
      const end = markdown.indexOf(closing, i + run);
      if (end === -1) {
        return out + ' '.repeat(markdown.length - i);
      }
      out += ' '.repeat(end + run - i);
      i = end + run;
      continue;
    }
    out += markdown[i];
    i += 1;
  }
  return out;
}
