/**
 * 追问查询容错匹配 —— 三层匹配中的 ordered_coverage / one_edit 算法。
 *
 * 与 `transcript-retrieval.ts` 的关系：
 * - 主 retrieval 模块负责窗口、评分、去重与选择编排。
 * - 本模块负责字符级 fuzzy 匹配的两个纯函数：`isOrderedCoverageMatch` +
 *   `isOneEditMatch`。无业务编排，可独立测试。
 *
 * 不负责：
 * - 窗口构建 / 多窗口聚合：transcript-retrieval 主模块
 * - 三层降级策略 / 全局停止降级：transcript-retrieval 主模块
 * - 主题提取 / 归一化：followup-query-topic
 */

// ---------------------------------------------------------------------------
// 阈值与预算
// ---------------------------------------------------------------------------

/**
 * 容错匹配最低主题长度阈值。
 *
 * 阈值 5（QA2 恢复值）：
 * - 短主题（"AI" / "鲁迅" 等 2-3 字）即使编辑距离 1 也容易误命中无关文本；
 *   4 字通用词组合（"系统方法"）也能在无关 cue 中凑出 ordered_coverage，
 *   不进入容错层更稳。
 * - 5 字及以上的真专名 / 术语有足够锚点信息进入容错层。
 *
 * 调用层（`scoreQuestionMatchHits`）在调用本模块的 `isOrderedCoverageMatch` /
 * `isOneEditMatch` 前检查 `topic.length >= TOLERANT_MIN_TOPIC_LENGTH`。
 */
export const TOLERANT_MIN_TOPIC_LENGTH = 5;

/**
 * ordered_coverage 插入字符预算（QA2 §B）。
 *
 * 公式 `max(6, topicLength * 2)`：
 * - 6 字符绝对下限：短主题（5 字）能容忍至少 1 字插入扰动（5*2=10 ≥ 6）。
 * - `topicLength * 2`：长主题预算按比例放大。
 *
 * 内部跨度仍受此预算约束：插入字符 = `lastMatchedIndex - firstMatchedIndex + 1 - topic.length`。
 */
export function orderedCoverageInsertionBudget(topicLength: number): number {
  if (topicLength <= 0) {
    return 6;
  }
  return Math.max(6, topicLength * 2);
}

// ---------------------------------------------------------------------------
// ordered_coverage：最佳内部匹配跨度（QA2 §B）
// ---------------------------------------------------------------------------

/**
 * ordered_coverage 字符级 fuzzy substring 匹配 —— 选插入字符最少的完整有序跨度。
 *
 * 算法（QA2 §B 必修修复）：
 * - 枚举所有 firstIdx（text 中 topic[0] 的出现位置）。
 * - 对每个 firstIdx，向右扫描匹配 topic[1..]，记录最后一个 topic 字符的位置 lastIdx。
 * - 跨度 `[firstIdx, lastIdx]` 的插入字符 = `lastIdx - firstIdx + 1 - topic.length`。
 * - 多候选起点中选插入字符最少者；超出预算的候选直接不命中。
 *
 * 关键不变量：
 * - 字符按顺序出现 —— "电...火" 颠倒时不命中（防 9:44 cue "电以太和火的总倍率都是 1900%"）。
 * - 前缀和后缀不计入插入预算 —— `firstIdx` 之前和 `lastIdx` 之后的字符被忽略。
 * - 内部跨度超预算仍不命中 —— 即使每个 firstIdx 都"局部"匹配。
 *
 * @example
 * isOrderedCoverageMatch('今天先看看火电补偿部分倍率具体怎么算', '火电补偿倍率')
 * // → { matched: true, insertedChars: 2 }   // 跳过"部分"2 字符
 *
 * @example
 * isOrderedCoverageMatch('火xy电补偿倍率', '火电补偿倍率')
 * // → { matched: true, insertedChars: 0 }   // 选紧凑起点 idx=4（跳过 xy）
 */
export function isOrderedCoverageMatch(
  text: string,
  topic: string,
  budget?: number,
): { matched: boolean; insertedChars: number } {
  if (!topic || !text) {
    return { matched: false, insertedChars: 0 };
  }
  const effectiveBudget =
    budget ?? orderedCoverageInsertionBudget(topic.length);
  let bestInserted = Number.POSITIVE_INFINITY;

  for (let firstIdx = 0; firstIdx < text.length; firstIdx += 1) {
    if (text[firstIdx] !== topic[0]) continue;

    let pos = firstIdx + 1;
    let topicIdx = 1;
    while (topicIdx < topic.length && pos < text.length) {
      if (text[pos] === topic[topicIdx]) {
        topicIdx += 1;
      }
      pos += 1;
    }
    if (topicIdx !== topic.length) continue;

    const lastIdx = pos - 1;
    const inserted = lastIdx - firstIdx + 1 - topic.length;
    if (inserted < bestInserted) {
      bestInserted = inserted;
    }
  }

  if (bestInserted === Number.POSITIVE_INFINITY) {
    return { matched: false, insertedChars: 0 };
  }
  if (bestInserted > effectiveBudget) {
    return { matched: false, insertedChars: bestInserted };
  }
  return { matched: true, insertedChars: bestInserted };
}

// ---------------------------------------------------------------------------
// one_edit：编辑距离 ≤ 1 + 锚点
// ---------------------------------------------------------------------------

/**
 * 标准 Levenshtein 编辑距离（O(m*n) 时间 / O(n) 空间）。
 *
 * 编辑类型：插入 / 删除 / 替换，每种代价 1。topic 与 text 都较短（≤ 32 字符），
 * 该复杂度完全可接受；不引入第三方库。
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1]!;
      } else {
        curr[j] = 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n]!;
}

/**
 * 检查 text 是否包含 topic 的某个 ≥ minLen 字符子串。
 *
 * 必要性：防止短中文词在完全无关的文本上以编辑距离 ≤ 1 误命中。
 */
function hasTopicSubstringInText(
  text: string,
  topic: string,
  minLen: number,
): boolean {
  if (!text || !topic) return false;
  for (let len = topic.length; len >= minLen; len -= 1) {
    for (let i = 0; i + len <= topic.length; i += 1) {
      const sub = topic.substring(i, i + len);
      if (text.includes(sub)) return true;
    }
  }
  return false;
}

/**
 * one_edit 编辑距离 ≤ 1 的近似匹配。
 *
 * 算法：
 * 1. `text.includes(topic)` → 距离 0（兼容 exact）。
 * 2. 否则滑窗 ±2 chars：窗口大小 `[max(1, topic.length - 2), topic.length + 2]`，对每个
 *    窗口计算 Levenshtein 距离，取最小值。
 * 3. 锚点条件：topic 必须有 ≥ 2 chars 子串在 text 中（防短词误中）。
 * 4. 距离 ≤ 1 + 锚点存在 → 命中。
 *
 * @example
 * isOneEditMatch('维琳娜一命', '维林娜一命')   // 距离 1 + 锚点"一命" → 命中
 * isOneEditMatch('完全不同无关内容', '维林娜一命') // 距离高 + 锚点缺失 → 不命中
 */
export function isOneEditMatch(
  text: string,
  topic: string,
): { matched: boolean; distance: number } {
  if (!topic || !text) {
    return { matched: false, distance: -1 };
  }
  if (text.includes(topic)) {
    return { matched: true, distance: 0 };
  }
  const N = topic.length;
  const minWin = Math.max(1, N - 2);
  const maxWin = Math.min(text.length, N + 2);
  let minDistance = Number.POSITIVE_INFINITY;
  outer: for (let w = minWin; w <= maxWin; w += 1) {
    for (let i = 0; i + w <= text.length; i += 1) {
      const win = text.substring(i, i + w);
      const d = levenshteinDistance(win, topic);
      if (d < minDistance) minDistance = d;
      if (minDistance <= 1) break outer;
    }
  }
  const anchorPresent = hasTopicSubstringInText(text, topic, 2);
  const finalDistance =
    minDistance === Number.POSITIVE_INFINITY ? -1 : minDistance;
  return {
    matched: anchorPresent && finalDistance >= 0 && finalDistance <= 1,
    distance: finalDistance,
  };
}
