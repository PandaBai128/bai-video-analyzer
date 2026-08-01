import { jsonrepair } from 'jsonrepair';
import { MissingTimeAnchorError } from './timeline-cue-mapping';
import { mergeDuplicateTopLevelKeys } from './duplicate-top-level-keys';

/**
 * JSON 字符串层修复 —— fence / thinking 标签剥离、解析层 fallback、松散引号修复、
 * 解析错误上下文与 raw response 诊断。
 *
 * 职责范围：
 * - `stripJsonFence`（导出）：剥 markdown json fence + 思考标签 + 提取首尾 {}。
 * - `parseJsonWithRepair`（内部）：重复 key 合并 → JSON.parse → jsonrepair →
 *   松散引号修复后再次 jsonrepair。
 * - `escapeLooseStringQuotes` / `isLikelyClosingStringQuote`：中文等宽松引号转义。
 * - `extractLikelyJson`：从混合内容里抽取最可能的 JSON。
 * - 解析错误上下文（错误附近内容、位置、原始响应结构诊断）。
 *
 * 不负责：
 * - Zod schema 与字段映射：video-analysis-raw-schema
 * - 章节 / 时间线领域归一化与 fallback：video-analysis-normalize-result
 * - 重复顶层 key 合并：duplicate-top-level-keys（可调用 `mergeDuplicateTopLevelKeys`）
 */

export function stripJsonFence(content: string): string {
  const trimmed = extractLikelyJson(content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * JSON 解析渐进式 fallback：
 * 1. 重复顶层 key 合并（避免 `JSON.parse` 静默取最后一个值）。
 * 2. `JSON.parse` 直接成功则返回。
 * 3. 否则 `jsonrepair` 单次修复。
 * 4. 松散引号修复后再次 `jsonrepair`（处理中文字符串里的"误闭合"）。
 * 5. 全失败 → 抛带"错误附近内容"的 Error（不消耗 rawResponse）。
 */
export function parseJsonWithRepair(jsonText: string): unknown {
  // 顶层重复 key 合并：MiniMax 偶尔会重复输出 chapters / coreTakeaways 等顶层字段。
  // `JSON.parse` 在 JavaScript 语义下会取最后一个值、**静默丢弃**前面的所有内容——
  // 用户实际看到的是"时间线从 18 分钟才开始"这类数据丢失。
  // 这里在 parse 之前先合并：数组拼接、对象深合并、标量取最后一个。
  const merged = mergeDuplicateTopLevelKeys(jsonText);

  try {
    return JSON.parse(merged);
  } catch (firstError) {
    try {
      return JSON.parse(jsonrepair(merged));
    } catch {
      const quoteRepaired = escapeLooseStringQuotes(merged);
      try {
        return JSON.parse(jsonrepair(quoteRepaired));
      } catch {
        throw createJsonParseError(firstError, jsonText);
      }
    }
  }
}

/**
 * 把 JSON 字符串里"宽松引号"转义成 `\"`：当一个 `"` 后面不是结构字符
 *（`: , } ]`）而是内容字符时，认为它是字符串内的误闭合。
 *
 * 专门应对 LLM 在中文文本里写 `"` 但没有转义的场景。
 */
export function escapeLooseStringQuotes(jsonText: string): string {
  let repaired = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < jsonText.length; index += 1) {
    const character = jsonText[index];

    if (!inString) {
      if (character === '"') {
        inString = true;
      }
      repaired += character;
      continue;
    }

    if (escaped) {
      repaired += character;
      escaped = false;
      continue;
    }

    if (character === '\\') {
      repaired += character;
      escaped = true;
      continue;
    }

    if (character === '"') {
      if (isLikelyClosingStringQuote(jsonText, index)) {
        inString = false;
        repaired += character;
      } else {
        repaired += '\\"';
      }
      continue;
    }

    repaired += character;
  }

  return repaired;
}

/**
 * 判断 quoteIndex 处的 `"` 是否为字符串合法闭合。规则：跳过空白后，下一个
 * 非空白字符必须是 `: , } ]` 之一（结构分隔符）；其它字符都视为字符串内容。
 */
export function isLikelyClosingStringQuote(jsonText: string, quoteIndex: number): boolean {
  for (let index = quoteIndex + 1; index < jsonText.length; index += 1) {
    const character = jsonText[index];

    if (!character) {
      return true;
    }

    if (/\s/.test(character)) {
      continue;
    }

    return character === ':' || character === ',' || character === '}' || character === ']';
  }

  return true;
}

/**
 * 从混合内容里抽取最可能的 JSON 段：先看 markdown fence，没有的话找首尾 `{ }`。
 */
export function extractLikelyJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');

  if (start >= 0 && end > start) {
    return content.slice(start, end + 1).trim();
  }

  return content;
}

/**
 * 把 MissingTimeAnchorError 转换成"位置易读"的中文描述（章节/段索引），供上层
 * 错误信息展示用。
 */
export function describeAnchorLocation(error: MissingTimeAnchorError): string {
  if (error.contextLabel === 'segment' && error.chapterIndex !== null && error.segmentIndex !== null) {
    return `chapters[${error.chapterIndex}].segments[${error.segmentIndex}]`;
  }
  if (error.contextLabel === 'chapter' && error.chapterIndex !== null) {
    return `chapters[${error.chapterIndex}]`;
  }
  return error.contextLabel;
}

/**
 * 从 V8 / Firefox 的 JSON parse error 文本里提取 `position N`，把 jsonText
 * 在 N 附近 ±120 字符作为"错误附近内容"拼到错误信息里。无法定位时给前 240 字符。
 */
export function createJsonParseError(error: unknown, jsonText: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/i.exec(message)?.[1];
  const positionNumber = position ? Number(position) : -1;
  const context =
    positionNumber >= 0
      ? jsonText.slice(Math.max(0, positionNumber - 120), positionNumber + 120)
      : jsonText.slice(0, 240);

  return new Error(`模型返回的 JSON 无法解析：${message}。错误附近内容：${context}`);
}

/**
 * 解析失败时把"原始响应结构"也拼进错误信息。这样下次用户报错，
 * side panel 会直接显示响应字段名，方便定位字段名错位。
 */
export function enhanceJsonParseError(error: unknown, jsonText: string, rawResponse: unknown): Error {
  const base = createJsonParseError(error, jsonText);
  if (rawResponse === undefined) {
    return base;
  }
  let dumped = '';
  try {
    dumped = JSON.stringify(rawResponse, null, 2).slice(0, 1500);
  } catch {
    dumped = '[unserializable]';
  }
  const message = base.message + `\n\n原始响应结构（前 1500 字符，方便诊断字段名错位）：\n${dumped}`;
  return new Error(message);
}
