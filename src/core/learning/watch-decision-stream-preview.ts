export interface WatchDecisionStreamPreview {
  readonly contentType?: string;
  readonly verdict?: string;
  readonly overallMeaning?: string;
  readonly nodeTitles: readonly string[];
}

const MAX_NODE_TITLES = 8;

export function createWatchDecisionStreamPreview(content: string): WatchDecisionStreamPreview {
  const contentType = firstValue(extractStringValuesForKey(content, 'contentType', 1));
  const verdict = firstValue(extractStringValuesForKey(content, 'verdict', 1));
  const overallMeaning =
    firstValue(extractStringValuesForKey(content, 'overallMeaning', 1)) ??
    firstValue(extractStringValuesForKey(content, 'overview', 1));
  const nodeTitles = dedupeText(extractStringValuesForKey(content, 'title', MAX_NODE_TITLES * 2)).slice(
    0,
    MAX_NODE_TITLES,
  );

  return {
    ...(contentType ? { contentType } : {}),
    ...(verdict ? { verdict } : {}),
    ...(overallMeaning ? { overallMeaning } : {}),
    nodeTitles,
  };
}

export function hasWatchDecisionStreamPreview(preview: WatchDecisionStreamPreview): boolean {
  return Boolean(
    preview.contentType ||
      preview.verdict ||
      preview.overallMeaning ||
      preview.nodeTitles.length > 0,
  );
}

function extractStringValuesForKey(content: string, key: string, limit: number): string[] {
  const values: string[] = [];
  const keyToken = JSON.stringify(key);
  let index = 0;

  while (values.length < limit) {
    const keyIndex = content.indexOf(keyToken, index);
    if (keyIndex < 0) break;

    let cursor = keyIndex + keyToken.length;
    cursor = skipWhitespace(content, cursor);
    if (content[cursor] !== ':') {
      index = cursor + 1;
      continue;
    }

    cursor = skipWhitespace(content, cursor + 1);
    if (content[cursor] !== '"') {
      index = cursor + 1;
      continue;
    }

    const parsed = readCompleteJsonString(content, cursor);
    if (!parsed) {
      index = cursor + 1;
      continue;
    }
    if (!isJsonStringBoundary(content, parsed.endIndex)) {
      index = parsed.endIndex;
      continue;
    }

    const text = parsed.value.trim();
    if (text) values.push(text);
    index = parsed.endIndex;
  }

  return values;
}

function readCompleteJsonString(
  content: string,
  startIndex: number,
): { readonly value: string; readonly endIndex: number } | null {
  let escaped = false;

  for (let index = startIndex + 1; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;

    const raw = content.slice(startIndex, index + 1);
    try {
      const value = JSON.parse(raw);
      return typeof value === 'string' ? { value, endIndex: index + 1 } : null;
    } catch {
      return null;
    }
  }

  return null;
}

function isJsonStringBoundary(content: string, startIndex: number): boolean {
  const index = skipWhitespace(content, startIndex);
  const next = content[index];
  return !next || next === ',' || next === '}' || next === ']';
}

function skipWhitespace(content: string, startIndex: number): number {
  let index = startIndex;
  while (index < content.length && /\s/.test(content[index] ?? '')) {
    index += 1;
  }
  return index;
}

function firstValue(values: readonly string[]): string | undefined {
  return values[0];
}

function dedupeText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
