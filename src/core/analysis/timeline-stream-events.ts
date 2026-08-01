/**
 * Round 24 QA2 必修 B：时间线流式 JSONL 事件解析 + 累积器。
 *
 * 历史：旧版流式只推 `VIDEO_TIMELINE_CHUNK` 原始 JSON 文本给 side panel，
 *   UI 直接 `<pre>` 展示 = 把半截 JSON 倒给用户看。产品不合格（用户手测反馈）。
 *
 * 新版：要求 LLM 输出 **JSON Lines** 格式——每行是一个完整 JSON object，
 *   controller 行 buffer 解析后推结构化 `VIDEO_TIMELINE_PARTIAL` 事件
 *   给 side panel。UI 渲染可读进度 / overview 草稿 / chapter 卡片，
 *   永远不显示原始 JSON。
 *
 * 事件类型（与 handoff §4 JSONL 格式对应）：
 * - `overview`：1 个；含 text（1-2 句视频核心）
 * - `chapter`：N 个；含 startCueId / endCueId / title / summary
 *   + 可选 segments: [{ startCueId, endCueId, title, summary }]
 * - `segment`：N 个；含 chapterId / startCueId / endCueId / title / summary
 *   （**注**：目前设计是 chapter 嵌 segments 优先；顶层 segment 用 chapterId
 *   关联回 chapter）
 * - `done`：1 个；流结束标记
 *
 * 行解析规则（按 handoff §4 不接受方案的反证）：
 * - 接受：每行完整 JSON object
 * - 拒绝：行内有半截 JSON、嵌套对象未闭合
 * - 拒绝：外层 `{chapters: [...]}` 包裹数组
 * - 拒绝：Markdown 包裹
 *
 * 失败 fallback（按 handoff §6）：
 * - JSONL 事件数为 0，但完整流内容能被 `parseVideoAnalysisJson` 解析：
 *   使用旧路径；UI 不展示原始 JSON
 * - JSONL 部分成功、最终转换失败：返回可解释错误
 */

import {
  TIMELINE_CONTENT_TAGS,
  type SubtitleCue,
  type TimelineContentTag,
  type TimelineNode,
  type VideoChapter,
} from '@core/types';

type TimelineImportance = TimelineNode['importance'];
const timelineContentTagSet = new Set<string>(TIMELINE_CONTENT_TAGS);

/** JSONL 事件联合类型（不含 done，因为 done 触发流结束逻辑）。 */
export type TimelineStreamEventBody =
  | {
      readonly type: 'overview';
      readonly text: string;
    }
  | {
      readonly type: 'chapter';
      readonly id: string;
      readonly startCueId: number;
      readonly endCueId: number;
      readonly importance?: VideoChapter['importance'];
      readonly contentTag?: TimelineContentTag;
      readonly title: string;
      readonly summary: string;
    }
  | {
      readonly type: 'segment';
      readonly chapterId: string;
      readonly startCueId: number;
      readonly endCueId: number;
      readonly importance?: TimelineImportance;
      readonly contentTag?: TimelineContentTag;
      readonly title: string;
      readonly summary: string;
    };

/** 流结束标记。 */
export interface TimelineStreamDoneEvent {
  readonly type: 'done';
}

/** 解析后的全部事件类型。 */
export type TimelineStreamEvent = TimelineStreamEventBody | TimelineStreamDoneEvent;

/** 解析失败时的错误（含行号 + 原始文本片段便于诊断）。 */
export class TimelineStreamEventParseError extends Error {
  readonly lineNumber: number;
  readonly rawLine: string;
  override readonly cause: unknown;
  constructor(input: { lineNumber: number; rawLine: string; cause: unknown }) {
    super(
      `JSONL 事件解析失败（第 ${input.lineNumber} 行）：${truncateForError(input.rawLine)}（${describeCause(input.cause)}）`,
    );
    this.name = 'TimelineStreamEventParseError';
    this.lineNumber = input.lineNumber;
    this.rawLine = input.rawLine;
    this.cause = input.cause;
  }
}

function truncateForError(line: string): string {
  if (line.length <= 80) return line;
  return `${line.slice(0, 80)}…`;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * 朴素 JSON parse 的最小封装：
 * - 让 caller 知道是 parse 失败的具体原因（catch 后 re-throw 一个标准 Error）
 * - 不引入 jsonrepair（handoff §6 fallback 路径用旧 parseVideoAnalysisJson
 *   时会调；这里只看是否为合法 JSON object）
 */
function tryParseJsonObject(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // 简单守卫：必须以 { 开头、} 结尾
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new SyntaxError(
      `JSONL 行必须以 { 开头、} 结尾（实际：${truncateForError(trimmed)}）`,
    );
  }
  return JSON.parse(trimmed);
}

function isTimelineStreamEventBody(value: unknown): value is TimelineStreamEventBody {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown };
  if (v.type !== 'overview' && v.type !== 'chapter' && v.type !== 'segment') {
    return false;
  }
  if (v.type === 'overview') {
    const o = value as { text?: unknown };
    return typeof o.text === 'string';
  }
  if (v.type === 'chapter') {
    const c = value as {
      id?: unknown;
      startCueId?: unknown;
      endCueId?: unknown;
      importance?: unknown;
      contentTag?: unknown;
      title?: unknown;
      summary?: unknown;
    };
    return (
      typeof c.id === 'string' &&
      typeof c.startCueId === 'number' &&
      typeof c.endCueId === 'number' &&
      isOptionalTimelineImportance(c.importance) &&
      isOptionalTimelineContentTag(c.contentTag) &&
      typeof c.title === 'string' &&
      typeof c.summary === 'string'
    );
  }
  // segment
  const s = value as {
    chapterId?: unknown;
    startCueId?: unknown;
    endCueId?: unknown;
    importance?: unknown;
    contentTag?: unknown;
    title?: unknown;
    summary?: unknown;
  };
  return (
    typeof s.chapterId === 'string' &&
    typeof s.startCueId === 'number' &&
    typeof s.endCueId === 'number' &&
    isOptionalTimelineImportance(s.importance) &&
    isOptionalTimelineContentTag(s.contentTag) &&
    typeof s.title === 'string' &&
    typeof s.summary === 'string'
  );
}

function isOptionalTimelineImportance(value: unknown): value is TimelineImportance | undefined {
  return (
    value === undefined ||
    value === 'must-watch' ||
    value === 'recommended' ||
    value === 'optional' ||
    value === 'skip'
  );
}

function isOptionalTimelineContentTag(value: unknown): value is TimelineContentTag | undefined {
  return value === undefined || (typeof value === 'string' && timelineContentTagSet.has(value));
}

/**
 * 解析后的"事件"返回类型：
 * - `body` 事件（overview / chapter / segment）→ 进 `events` 列表
 * - `done` 事件 → 单独标记，不进 `events` 列表（流结束信号）
 */
export type ParsedTimelineLine = {
  readonly kind: 'body';
  readonly event: TimelineStreamEventBody;
} | {
  readonly kind: 'done';
} | {
  readonly kind: 'unknown'; // type 字段值不在白名单内（解析错误）
};

/**
 * 行 buffer 状态机。
 *
 * 调用方拿到 `MinimaxStreamChunk` 后调用 `pushChunk()`，函数返回本 chunk 内
 * 解析出来的新事件（可能是 0 / 1 / 多个）。未闭合的行（缺换行符）会留在
 * buffer，等下一个 chunk 拼上。
 *
 * 设计：
 * - 切到 `\n` 切一行
 * - 行内 trim 后**不**为空才尝试 parse
 * - parse 失败抛 `TimelineStreamEventParseError`；caller 决定走 fallback
 *   还是把错误推给 side panel
 */
export interface TimelineLineBuffer {
  /** 推一个 chunk，返回本 chunk 解析出来的新事件（不含 done，由流结束信号触发）。 */
  pushChunk(chunk: string): readonly TimelineStreamEventBody[];
  /** 标记流结束，强制 flush buffer 最后一行（即使没换行）。 */
  flush(): readonly TimelineStreamEventBody[];
  /** 取得当前 buffer 里未闭合的行（用于调试 / 错误信息）。 */
  readonly pending: string;
  /** 当前已解析的总行数（成功 + 失败都算）。 */
  readonly lineNumber: number;
  /** 解析成功的事件数（便于 caller 决定是否走 fallback）。 */
  readonly eventCount: number;
}

export function createTimelineLineBuffer(): TimelineLineBuffer {
  let buffer = '';
  let lineNumber = 0;
  let eventCount = 0;

  function parseLine(rawLine: string, currentLine: number): ParsedTimelineLine | null {
    const trimmed = rawLine.trim();
    if (!trimmed) return null;
    lineNumber = currentLine;
    let parsed: unknown;
    try {
      parsed = tryParseJsonObject(trimmed);
    } catch (cause) {
      throw new TimelineStreamEventParseError({
        lineNumber: currentLine,
        rawLine: trimmed,
        cause,
      });
    }
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== 'object') {
      throw new TimelineStreamEventParseError({
        lineNumber: currentLine,
        rawLine: trimmed,
        cause: new Error('JSONL 行不是 JSON object'),
      });
    }
    const typed = parsed as { type?: unknown };
    if (typed.type === 'done') {
      // done 行不计入 eventCount（不算 body 事件）；返回 kind='done' 让 caller 处理
      return { kind: 'done' };
    }
    if (isTimelineStreamEventBody(parsed)) {
      eventCount += 1;
      return { kind: 'body', event: parsed };
    }
    // type 字段值不在白名单内 → 解析错误
    throw new TimelineStreamEventParseError({
      lineNumber: currentLine,
      rawLine: trimmed,
      cause: new Error(
        'JSONL 行不是合法 TimelineStreamEvent（type 必须是 overview/chapter/segment/done 且字段齐全）',
      ),
    });
  }

  function parseBufferIntoEvents(text: string): TimelineStreamEventBody[] {
    const events: TimelineStreamEventBody[] = [];
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsedLine = parseLine(line, lineNumber + 1);
      if (parsedLine && parsedLine.kind === 'body') {
        events.push(parsedLine.event);
      }
      // done 行：parseLine 不进 eventCount，但 buffer 的 pushChunk 接口
      //   是返回 body 事件列表——caller 想知道"我刚解析到 done"，但
      //   当前的 TimelineLineBuffer 接口只暴露 body 事件。
      //   这里我们仍**不**把 done 暴露到 pushChunk 返回（caller 通过
      //   flush() 时机或 buffer 显式 done signal 知道）——简化设计。
    }
    return events;
  }

  return {
    pushChunk(chunk) {
      buffer += chunk;
      // 找最后一个 \n
      const lastNewlineIndex = buffer.lastIndexOf('\n');
      if (lastNewlineIndex === -1) {
        // 还没切到第一行
        return [];
      }
      const completePart = buffer.slice(0, lastNewlineIndex);
      buffer = buffer.slice(lastNewlineIndex + 1);
      return parseBufferIntoEvents(completePart);
    },
    flush() {
      // 流结束：把 buffer 残留的最后一行也强制解析（即使没有 \n 结尾）
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }
      const events = parseBufferIntoEvents(buffer);
      buffer = '';
      return events;
    },
    get pending() {
      return buffer;
    },
    get lineNumber() {
      return lineNumber;
    },
    get eventCount() {
      return eventCount;
    },
  };
}

/**
 * 把累积的 JSONL 事件列表转换成 `{ overview, chapters, segments }` 草稿。
 *
 * 草稿结构（与 `VideoAnalysis` 不一样——草稿还没经过 cue id 映射、约束
 *   时长、normalize 等完整处理）：
 * - `overview`: string | null
 * - `chapters`: 顶层 chapter 事件列表（按到达顺序）
 *   - 每个 chapter 嵌 segments
 * - `orphanSegments`: chapter 嵌 segments 之外的顶层 segment 事件
 *   （按 chapterId 关联回 chapter；关联不到的当 orphan）
 *
 * 这个函数**不**做 cue id 映射（由 controller 在结束时调 mapCueIdsToTimestamps
 * + normalizeChapterTimelineStructure 转成 `VideoAnalysis`）。它只把事件整理
 * 成 side panel 直接可渲染的草稿。
 */
export interface TimelineStreamDraft {
  readonly overview: string | null;
  readonly chapters: readonly {
    readonly id: string;
    readonly startCueId: number;
    readonly endCueId: number;
    readonly importance?: VideoChapter['importance'];
    readonly contentTag?: TimelineContentTag;
    readonly title: string;
    readonly summary: string;
    readonly segments: readonly {
      readonly startCueId: number;
      readonly endCueId: number;
      readonly importance?: TimelineImportance;
      readonly contentTag?: TimelineContentTag;
      readonly title: string;
      readonly summary: string;
    }[];
  }[];
  /** chapter 事件未嵌 / 顶层 segment 事件无对应 chapter。 */
  readonly orphanSegments: readonly {
    readonly chapterId: string;
    readonly startCueId: number;
    readonly endCueId: number;
    readonly importance?: TimelineImportance;
    readonly contentTag?: TimelineContentTag;
    readonly title: string;
    readonly summary: string;
  }[];
}

export function buildTimelineStreamDraft(
  events: readonly TimelineStreamEventBody[],
): TimelineStreamDraft {
  let overview: string | null = null;
  const chapterMap = new Map<
    string,
    {
      id: string;
      startCueId: number;
      endCueId: number;
      importance?: VideoChapter['importance'];
      contentTag?: TimelineContentTag;
      title: string;
      summary: string;
      segments: {
        startCueId: number;
        endCueId: number;
        importance?: TimelineImportance;
        contentTag?: TimelineContentTag;
        title: string;
        summary: string;
      }[];
    }
  >();
  const orphanSegments: {
    chapterId: string;
    startCueId: number;
    endCueId: number;
    importance?: TimelineImportance;
    contentTag?: TimelineContentTag;
    title: string;
    summary: string;
  }[] = [];

  for (const event of events) {
    if (event.type === 'overview') {
      overview = event.text;
      continue;
    }
    if (event.type === 'chapter') {
      chapterMap.set(event.id, {
        id: event.id,
        startCueId: event.startCueId,
        endCueId: event.endCueId,
        ...(event.importance ? { importance: event.importance } : {}),
        ...(event.contentTag ? { contentTag: event.contentTag } : {}),
        title: event.title,
        summary: event.summary,
        segments: [],
      });
      continue;
    }
    // segment
    const chapter = chapterMap.get(event.chapterId);
    if (chapter) {
      chapter.segments.push({
        startCueId: event.startCueId,
        endCueId: event.endCueId,
        ...(event.importance ? { importance: event.importance } : {}),
        ...(event.contentTag ? { contentTag: event.contentTag } : {}),
        title: event.title,
        summary: event.summary,
      });
    } else {
      orphanSegments.push({
        chapterId: event.chapterId,
        startCueId: event.startCueId,
        endCueId: event.endCueId,
        ...(event.importance ? { importance: event.importance } : {}),
        ...(event.contentTag ? { contentTag: event.contentTag } : {}),
        title: event.title,
        summary: event.summary,
      });
    }
  }

  return {
    overview,
    chapters: Array.from(chapterMap.values()),
    orphanSegments,
  };
}

/**
 * 从非严格 JSONL 文本中提取 Timeline 事件。
 *
 * 真实模型偶发会输出：
 * - ```jsonl 代码块包裹
 * - 前后解释文字
 * - `data: {...}` 前缀
 * - 多个 JSON object 连在一起但没有换行
 *
 * 严格 line buffer 会拒绝这些格式；这里作为最后兜底，只扫描平衡花括号
 * 包住的 JSON object，并只接收合法 TimelineStreamEventBody / done。
 */
export function extractTimelineEventsFromLooseText(text: string): readonly TimelineStreamEventBody[] {
  const events: TimelineStreamEventBody[] = [];
  for (const objectText of extractBalancedJsonObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(objectText);
    } catch {
      continue;
    }
    if (isTimelineStreamEventBody(parsed)) {
      events.push(parsed);
    }
  }
  return events;
}

function extractBalancedJsonObjects(text: string): readonly string[] {
  const objects: string[] = [];
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (startIndex === -1) {
      if (character === '{') {
        startIndex = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return objects;
}

/**
 * 把草稿转换成 VideoAnalysis 输入结构（cue id 锚点格式），复用
 * `parseVideoAnalysisJson` 内部 zod schema + `mapCueIdsToTimestamps` 路径。
 *
 * 这个函数**不**直接产 VideoAnalysis，而是构造 `parseVideoAnalysisJson`
 * 能解析的 `content` 字符串。这样可以：
 * - 复用所有 zod 校验（包括 Round 23 必修 A 缺时间依据抛错）
 * - 复用 `mapCueIdsToTimestamps` 做 cue id → timestamp 映射
 * - 复用 `normalizeChapterTimelineStructure` 排序
 * - 复用 `constrainAnalysisToDuration` 裁剪时长
 *
 * 返回的字符串形如：
 * ```
 * {
 *   "overview": "...",
 *   "chapters": [
 *     { "startCueId": 0, "endCueId": 12, "title": "...", "summary": "...",
 *       "segments": [{ "startCueId": 0, "endCueId": 4, ... }] }
 *   ]
 * }
 * ```
 */
export function draftToJsonlAnalysisContent(draft: TimelineStreamDraft): string {
  const payload = {
    overview: draft.overview ?? '',
    chapters: draft.chapters.map((chapter) => ({
      startCueId: chapter.startCueId,
      endCueId: chapter.endCueId,
      ...(chapter.importance ? { importance: chapter.importance } : {}),
      ...(chapter.contentTag ? { contentTag: chapter.contentTag } : {}),
      title: chapter.title,
      summary: chapter.summary,
      segments: chapter.segments,
    })),
  };
  return JSON.stringify(payload);
}

/**
 * 判断完整流内容能否被 `parseVideoAnalysisJson` 解析（旧路径 fallback）。
 * 直接调 `parseVideoAnalysisJson` 抛错就算 false。
 *
 * 注：这是 controller 内部 helper，**不**抛错给 caller。失败时返回 false
 * 让 caller 走完整 JSONL fallback 失败 → 推错误。
 */
export function canParseAsCompleteJson(
  fullContent: string,
  parseFn: (input: { content: string; modelUsed: string; sourceMode: 'subtitle'; subtitles?: readonly SubtitleCue[] }) => unknown,
  modelUsed: string,
  subtitles: readonly SubtitleCue[],
): boolean {
  try {
    parseFn({ content: fullContent, modelUsed, sourceMode: 'subtitle', subtitles });
    return true;
  } catch {
    return false;
  }
}
