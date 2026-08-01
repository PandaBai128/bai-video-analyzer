/**
 * 重复顶层 key 合并 —— 完整的"保守修复器"，不是微型工具集合。
 *
 * MiniMax / 其他 LLM 偶尔会重复输出 `chapters` / `coreTakeaways` 等顶层字段。
 * JavaScript 语义下 `JSON.parse` 取最后一个值、**静默丢弃**前面的内容——
 * 用户看到的是"时间线从 18 分钟才开始"这类数据丢失。
 *
 * 合并规则（与 `JSON.parse` 默认行为差异）：
 * - 数组：拼接（`[a, b]` + `[c, d]` → `[a, b, c, d]`）
 * - 对象：成员级拼接（同名 key 仍按"后者覆盖前者"递归处理；这是简单实现，
 *   足够覆盖实际场景）
 * - 标量：取最后一个（与 `JSON.parse` 一致）
 *
 * 只处理**顶层**（顶层 object 内部）重复 key——避免误改数组元素 / 段对象。
 *
 * 鲁棒性：
 * - 第一个 array 可能漏 `]`；我们用"下一个 key 的 keyStart 之前"作为 value 边界
 *   来兜底抓取实际内容。
 * - malformed value（顶层 array 缺 `]` + 内部错位等更深层畸形）走 `isWellFormedArrayOrObject`
 *   跳过合并，让上游 `jsonrepair` 单独跑抢救部分数据。
 *
 * 不依赖 `VideoAnalysis`、Zod 或业务类型 —— 只做 JSON 字符串层修复。
 */

export function mergeDuplicateTopLevelKeys(jsonText: string): string {
  const topObjectStart = findTopLevelObjectStart(jsonText);
  if (topObjectStart < 0) {
    return jsonText;
  }
  const topObjectEnd = findMatchingClose(jsonText, topObjectStart, '{', '}');
  if (topObjectEnd < 0) {
    return jsonText;
  }

  const allKeys = findAllTopLevelKeyPositionsInOrder(
    jsonText,
    topObjectStart,
    topObjectEnd,
  );
  if (allKeys.length === 0) {
    return jsonText;
  }

  // Group by key
  const grouped = new Map<string, { keyStart: number; valueStart: number }[]>();
  for (const entry of allKeys) {
    const list = grouped.get(entry.keyName) ?? [];
    list.push({ keyStart: entry.keyStart, valueStart: entry.valueStart });
    grouped.set(entry.keyName, list);
  }

  type Edit = { readonly start: number; readonly end: number; readonly replacement: string };
  const edits: Edit[] = [];

  for (const [key, positions] of grouped) {
    if (positions.length < 2) {
      continue;
    }

    // 收集每个 occurrence 的 value 范围：
    // - occurrence N 的 value 结束于 occurrence N+1 的 keyStart 之前（去掉 `,` 和空白）
    // - 最后一个 occurrence 的 value 结束于"下一个不同 key 的 keyStart"之前
    //   （如果它是文件里最后一个 top-level key，则结束于 topObjectEnd 之前）
    // 这样对"第一个 array 缺 `]`"也鲁棒：那个 value 一直延伸到第二个 key 之前。
    const valueEnds: number[] = [];
    const values: string[] = [];
    for (let index = 0; index < positions.length; index += 1) {
      const pos = positions[index];
      if (!pos) {
        continue;
      }
      const valueStart = pos.valueStart;
      let valueEnd: number;
      // 找下一个 top-level key 的 keyStart —— 不管是相同 key 的下一个 occurrence，
      // 还是不同的 key。从 allKeys 列表里找位置 > 当前 pos.keyStart 的第一个。
      const posIndexInAll = allKeys.findIndex((k) => k.keyStart === pos.keyStart);
      const nextKey =
        posIndexInAll >= 0 ? allKeys[posIndexInAll + 1] : undefined;
      if (nextKey) {
        let lookback = nextKey.keyStart - 1;
        while (lookback > valueStart && /\s/.test(jsonText[lookback] ?? '')) {
          lookback -= 1;
        }
        if (jsonText[lookback] === ',') {
          lookback -= 1;
          while (lookback > valueStart && /\s/.test(jsonText[lookback] ?? '')) {
            lookback -= 1;
          }
        }
        valueEnd = lookback + 1;
      } else {
        // 真正最后一个 top-level key
        let lookback = topObjectEnd - 1;
        while (lookback > valueStart && /[\s,]/.test(jsonText[lookback] ?? '')) {
          lookback -= 1;
        }
        valueEnd = lookback + 1;
      }
      valueEnds.push(valueEnd);
      values.push(jsonText.slice(valueStart, valueEnd));
    }

    // 保守策略：只有当**所有** value 都是严格合法的 array/object 时才做合并。
    // 简单 case（LLM 重复 key 但 JSON 其他地方都合法）会触发；
    // 复杂 case（LLM 写出更严重的畸形 JSON，比如 chapter 内 `}` / `]` 错位）就跳过
    // —— 这种情况 `jsonrepair` 单独跑能从残骸里抢救出部分数据，强行合并反而让
    // 整个 JSON 不可解析。
    const allWellFormed = values.every(isWellFormedArrayOrObject);
    if (!allWellFormed) {
      continue;
    }

    const mergedValue = mergeKeyValues(values);
    const first = positions[0];
    const firstValueEnd = valueEnds[0];
    if (!first || firstValueEnd === undefined) {
      continue;
    }
    // 替换第一个 occurrence（key + ":" + 空白 + value 整体）为合并值
    edits.push({
      start: first.keyStart,
      end: firstValueEnd,
      replacement: `"${key}":${mergedValue}`,
    });

    // 删除后续 occurrences：连同前置 `,` + 整个 value 一起删掉，避免 `,,`
    // 也不让第二个 occurrence 的 value 残留在文本里（mergedValue 已经把它包含进去了）
    for (let index = 1; index < positions.length; index += 1) {
      const pos = positions[index];
      if (!pos) {
        continue;
      }
      let deleteStart = pos.keyStart;
      let lookback = deleteStart - 1;
      while (lookback > 0 && /\s/.test(jsonText[lookback] ?? '')) {
        lookback -= 1;
      }
      if (jsonText[lookback] === ',') {
        deleteStart = lookback;
      }
      const deleteEnd = valueEnds[index] ?? pos.valueStart;
      edits.push({
        start: deleteStart,
        end: deleteEnd,
        replacement: '',
      });
    }
  }

  if (edits.length === 0) {
    return jsonText;
  }

  edits.sort((a, b) => b.start - a.start);
  let result = jsonText;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }

  return result;
}

/**
 * 找所有顶层 key 的**有序**出现位置（含非重复 key）—— 用于给重复 key
 * 算 valueEnd 时知道"下一个 top-level key 在哪"。同样支持 array 缺 `]` 的兜底。
 */
function findAllTopLevelKeyPositionsInOrder(
  jsonText: string,
  topObjectStart: number,
  topObjectEnd: number,
): Array<{ keyName: string; keyStart: number; valueStart: number }> {
  const out: Array<{ keyName: string; keyStart: number; valueStart: number }> = [];
  const collected = new Map<string, { keyStart: number; valueStart: number }[]>();
  let i = topObjectStart + 1;
  while (i < topObjectEnd) {
    // 跳过空白
    while (i < topObjectEnd && /\s/.test(jsonText[i] ?? '')) {
      i += 1;
    }
    if (i >= topObjectEnd) {
      break;
    }
    if (jsonText[i] === '}') {
      break;
    }
    // 第一个 key 紧跟顶层 `{`，没有 `,` 分隔符 —— 直接处理
    if (jsonText[i] === '"') {
      // fall through
    } else {
      const nextBoundary = findNextTopLevelEntryStart(jsonText, i, topObjectEnd);
      if (nextBoundary < 0) {
        const recovered = recoverDuplicateKeyAfterUnclosedArray(
          jsonText,
          i,
          topObjectEnd,
          collected,
        );
        if (!recovered) {
          break;
        }
        // 把 recovered 期间新加进 collected 的项按 keyStart 顺序搬到 out
        for (const [keyName, list] of collected) {
          for (const entry of list) {
            if (!out.find((o) => o.keyStart === entry.keyStart)) {
              out.push({ keyName, keyStart: entry.keyStart, valueStart: entry.valueStart });
            }
          }
        }
        out.sort((a, b) => a.keyStart - b.keyStart);
        collected.clear();
        for (const o of out) {
          const list = collected.get(o.keyName) ?? [];
          list.push({ keyStart: o.keyStart, valueStart: o.valueStart });
          collected.set(o.keyName, list);
        }
        i = recovered;
        continue;
      }
      if (nextBoundary >= topObjectEnd) {
        break;
      }
      if (jsonText[nextBoundary] === '}') {
        break;
      }
      i = nextBoundary + 1;
      while (i < topObjectEnd && /\s/.test(jsonText[i] ?? '')) {
        i += 1;
      }
      if (i >= topObjectEnd || jsonText[i] !== '"') {
        continue;
      }
    }

    const keyStart = i;
    const keyEnd = readStringEnd(jsonText, keyStart + 1);
    if (keyEnd <= keyStart) {
      i = keyEnd;
      continue;
    }
    let afterKey = skipWhitespaceAndCommas(jsonText, keyEnd);
    if (jsonText[afterKey] !== ':') {
      i = afterKey;
      continue;
    }
    const valueStart = skipWhitespaceAndCommas(jsonText, afterKey + 1);
    const keyName = jsonText.slice(keyStart + 1, keyEnd - 1);
    out.push({ keyName, keyStart, valueStart });
    const list = collected.get(keyName) ?? [];
    list.push({ keyStart, valueStart });
    collected.set(keyName, list);
    i = valueStart;
  }
  return out;
}

/**
 * 兜底：当上一个 array 没关、找不到下一个顶层 `,` / `{` 时，从当前位置
 * 扫已收集的 key 名字的 `,"<key>":` 模式（在字符串边界内）—— 把它当作 duplicate
 * 顶层 key 收集。返回这个 fallback 找到的最后一个 occurrence 的 valueStart，
 * 供外层主循环继续推进。
 */
function recoverDuplicateKeyAfterUnclosedArray(
  jsonText: string,
  start: number,
  end: number,
  collected: Map<string, { keyStart: number; valueStart: number }[]>,
): number | null {
  const knownKeys = Array.from(collected.keys());
  if (knownKeys.length === 0) {
    return null;
  }
  let lastValueStart: number | null = null;
  let cursor = start;
  while (cursor < end) {
    // Walk through, tracking string state, to find unescaped `,"<key>":` at any depth
    // but only OUTSIDE strings.
    if (jsonText[cursor] === ',') {
      // Try to match `,"<key>":` at cursor+1
      let probe = cursor + 1;
      while (probe < end && /\s/.test(jsonText[probe] ?? '')) probe += 1;
      if (probe < end && jsonText[probe] === '"') {
        const keyStart = probe;
        const keyEnd = readStringEnd(jsonText, probe + 1);
        if (keyEnd > keyStart) {
          const keyName = jsonText.slice(keyStart + 1, keyEnd - 1);
          if (collected.has(keyName)) {
            let afterKey = skipWhitespaceAndCommas(jsonText, keyEnd);
            if (jsonText[afterKey] === ':') {
              const valueStart = skipWhitespaceAndCommas(jsonText, afterKey + 1);
              const list = collected.get(keyName) ?? [];
              list.push({ keyStart, valueStart });
              collected.set(keyName, list);
              lastValueStart = valueStart;
              cursor = valueStart;
              continue;
            }
          }
        }
      }
    }
    // Skip current char based on state
    if (jsonText[cursor] === '"') {
      const strEnd = readStringEnd(jsonText, cursor + 1);
      cursor = strEnd > 0 ? strEnd : cursor + 1;
      continue;
    }
    cursor += 1;
  }
  return lastValueStart;
}

/**
 * 从 `start` 向前找下一个**顶层**的 `,` 或 `{`（depth 0）。字符串内的 `,` / `{`
 * 不算。如果先遇到顶层 `}` 则返回 -1。
 */
function findNextTopLevelEntryStart(text: string, start: number, end: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < end; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth < 0) {
        return -1;
      }
      continue;
    }
    if (depth === 0 && (ch === ',' || ch === '{')) {
      return i;
    }
  }
  return -1;
}

function mergeKeyValues(values: readonly string[]): string {
  if (values.length === 0) {
    return '';
  }
  // 全部以 `[` 开头（不要求严格以 `]` 结尾 —— 第一个 array 可能漏 `]`）：拼接 inner。
  if (values.every((v) => v.trim().startsWith('['))) {
    const inner = values
      .map((value) => stripArrayLiteral(value.trim()))
      .filter((value) => value.length > 0);
    return `[${inner.join(',')}]`;
  }
  // 全部以 `{` 开头（不要求严格以 `}` 结尾）：浅合并。
  if (values.every((v) => v.trim().startsWith('{'))) {
    return mergeObjectLiterals(values);
  }
  // 混合 / 标量：取最后一个（与 JSON.parse 一致）
  return values[values.length - 1] ?? '';
}

/**
 * 判断 value 是不是结构上严格合法的 array 或 object：
 * - 首字符 `[` 必须有匹配的 `]` 在 depth 0
 * - 首字符 `{` 必须有匹配的 `}` 在 depth 0
 * - 走完整段文本后 depth 回到 0
 * 用作"是否值得做合并"的判据：若 LLM 输出的 JSON 在更深处还有畸形（不光
 * 顶层 key 重复，array 内部 `}` / `]` 也错位），强行合并会破坏整体可解析性，
 * 这种情况不如让 `jsonrepair` 单独跑。
 */
function isWellFormedArrayOrObject(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const first = trimmed[0];
  if (first !== '[' && first !== '{') {
    return false;
  }
  const closeChar = first === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0 && ch === closeChar) {
        // 外层 close 找到了；继续走完，确认后面没有意外
        const rest = trimmed.slice(i + 1).trim();
        return rest.length === 0;
      }
    }
  }
  return false;
}

/**
 * 去掉数组字面量的外层 `[` 和 `]`，但**只剥匹配的最后一个 `]`**：
 *
 * - 形如 `[a, b, c]`：剥头 `[` 剥尾 `]`，inner = `a, b, c`
 * - 形如 `[a, b, c`（malformed，缺尾 `]`）：只剥头 `[`，inner = `a, b, c`
 *   —— 内层 `}` / `]` 必须保留，因为它们是 array 内元素的合法闭括号
 *   （比如 `[{...,"segments":[seg1, seg2]}` 中的 `}]}` 是 seg 1.2 close + segments close + chapter close，
 *    全部是 array 元素的合法 JSON 内容）
 */
function stripArrayLiteral(value: string): string {
  const trimmed = value;
  let start = 0;
  if (trimmed[start] === '[') {
    start += 1;
  }
  // 找匹配的尾部 `]`：从末尾向前，跟踪深度（在 string 里也走），只剥 depth 0 的 `]`
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = trimmed.length;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0 && ch === ']') {
        end = i;
        break;
      }
    }
  }
  return trimmed.slice(start, end).trim();
}

function mergeObjectLiterals(values: readonly string[]): string {
  // 把每个 object literal 解析后再合并在理论上是更稳的，但会让本函数依赖 JSON.parse，
  // 而这里的输入可能就是非法 JSON。改用括号配对扫描：把多个对象的成员直接拼接。
  const members: string[] = [];
  for (const value of values) {
    const inner = value.trim().slice(1, -1).trim();
    if (inner.length > 0) {
      members.push(inner);
    }
  }
  if (members.length === 0) {
    return '{}';
  }
  return `{${members.join(',')}}`;
}

function findTopLevelObjectStart(jsonText: string): number {
  for (let i = 0; i < jsonText.length; i += 1) {
    const ch = jsonText[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      continue;
    }
    return ch === '{' ? i : -1;
  }
  return -1;
}

function findMatchingClose(
  text: string,
  openIndex: number,
  openChar: '{' | '[' | '(',
  closeChar: '}' | ']' | ')',
): number {
  let depth = 1;
  let inString = false;
  let escaped = false;
  for (let i = openIndex + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * 从 `cursor` 开始，跨过空白 / 逗号，返回下一个非空白非逗号的位置。
 */
function skipWhitespaceAndCommas(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * 从 `"` 之后的索引开始，读到一个非转义的 `"` 结束。
 * 返回该 `"` 的下一字符索引（也就是字符串结束的右引号 + 1）。
 */
function readStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      return i + 1;
    }
  }
  return -1;
}
