import { describe, expect, it } from 'vitest';
import {
  buildTimelineStreamDraft,
  canParseAsCompleteJson,
  createTimelineLineBuffer,
  draftToJsonlAnalysisContent,
  extractTimelineEventsFromLooseText,
  TimelineStreamEventParseError,
  type TimelineStreamEventBody,
} from '@core/analysis/timeline-stream-events';
import { parseVideoAnalysisJson } from '@core/analysis/video-analysis-schema';

describe('createTimelineLineBuffer (Round 24 QA2 必修 B: JSONL 行 buffer)', () => {
  it('单 chunk 含一行完整 overview → 解析成 1 个 event', () => {
    const buf = createTimelineLineBuffer();
    const events = buf.pushChunk(
      '{"type":"overview","text":"这个视频主要讲 AI 学习。"}\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('overview');
    if (events[0]?.type === 'overview') {
      expect(events[0].text).toBe('这个视频主要讲 AI 学习。');
    }
    expect(buf.eventCount).toBe(1);
    expect(buf.pending).toBe('');
  });

  it('多 chunk 累计 → 每行独立解析', () => {
    const buf = createTimelineLineBuffer();
    expect(buf.pushChunk('{"type":"overview","text":"hello"}\n')).toHaveLength(1);
    const chapterEvents = buf.pushChunk(
      '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"开场","summary":"开场白","importance":"must-watch","contentTag":"concept"}\n',
    );
    expect(chapterEvents).toHaveLength(1);
    expect(chapterEvents[0]).toMatchObject({
      type: 'chapter',
      importance: 'must-watch',
      contentTag: 'concept',
    });
    expect(
      buf.pushChunk(
        '{"type":"segment","chapterId":"c1","startCueId":0,"endCueId":2,"title":"提出问题","summary":"先抛疑问","importance":"optional","contentTag":"method"}\n',
      ),
    ).toHaveLength(1);
    expect(
      buf.pushChunk('{"type":"done"}\n'),
    ).toHaveLength(0);
    // done 行是流结束信号——不计入 eventCount，也不进 body events 列表
    // （controller 通过 `flush()` 拿到 done 让 side panel 知道流结束）
    expect(buf.eventCount).toBe(3);
    expect(buf.pending).toBe('');
  });

  it('chunk 切半行：第一个 chunk 给半行，第二个 chunk 补全 → 第二个 chunk 解析出 1 个 event', () => {
    // 这是最关键的边界 case：MiniMax streamChat() 经常按 token 切 chunk，
    // 一行 JSONL 会被切成 2 个 chunk。line buffer 必须等拼全才解析。
    const buf = createTimelineLineBuffer();
    expect(buf.pushChunk('{"type":"overview","text":"这个')).toHaveLength(0);
    expect(buf.pending).toBe('{"type":"overview","text":"这个');
    expect(buf.eventCount).toBe(0);
    // 第二个 chunk 补全 + 换行 → 解析
    const events = buf.pushChunk('视频主要讲 AI 学习。"}\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('overview');
    if (events[0]?.type === 'overview') {
      expect(events[0].text).toBe('这个视频主要讲 AI 学习。');
    }
    expect(buf.pending).toBe('');
    expect(buf.eventCount).toBe(1);
  });

  it('同一 chunk 多行 → 一次返回多个 events', () => {
    const buf = createTimelineLineBuffer();
    const events = buf.pushChunk(
      '{"type":"overview","text":"主题"}\n' +
        '{"type":"chapter","id":"c1","startCueId":0,"endCueId":5,"title":"开场","summary":"白"}\n',
    );
    expect(events).toHaveLength(2);
    expect(buf.eventCount).toBe(2);
  });

  it('非法 JSON 行 → 抛 TimelineStreamEventParseError（含行号 + 原文）', () => {
    const buf = createTimelineLineBuffer();
    // 非法 JSON 语法（缺 }）→ 切到完整行时抛错
    expect(() =>
      buf.pushChunk('{"type":"overview","text":"hello"\n'),
    ).toThrowError(TimelineStreamEventParseError);
    // 非法 type 字段值 → 抛错
    expect(() =>
      buf.pushChunk('{"type":"unknown","foo":1}\n'),
    ).toThrowError(TimelineStreamEventParseError);
  });

  it('非法 JSON 语法（缺开始花括号）→ 抛 TimelineStreamEventParseError', () => {
    const buf = createTimelineLineBuffer();
    expect(() =>
      buf.pushChunk('"type":"chapter","id":"c1"\n'),
    ).toThrowError(TimelineStreamEventParseError);
  });

  it('flush() 强制收尾：流结束但 buffer 残留最后一行无换行', () => {
    const buf = createTimelineLineBuffer();
    // 推一个无换行结尾的 JSONL 行
    buf.pushChunk('{"type":"overview","text":"hello"}');
    expect(buf.pending).toBe('{"type":"overview","text":"hello"}');
    expect(buf.eventCount).toBe(0);
    // 流结束，强制 flush
    const events = buf.flush();
    expect(events).toHaveLength(1);
    expect(buf.pending).toBe('');
    expect(buf.eventCount).toBe(1);
  });

  it('flush() 空 buffer 不抛错', () => {
    const buf = createTimelineLineBuffer();
    expect(buf.flush()).toHaveLength(0);
  });

  it('行内 trim 后空行跳过', () => {
    const buf = createTimelineLineBuffer();
    const events = buf.pushChunk(
      '\n' +
        '{"type":"overview","text":"hello"}\n' +
        '\n' +
        '   \n',
    );
    expect(events).toHaveLength(1);
    expect(buf.eventCount).toBe(1);
  });
});

describe('extractTimelineEventsFromLooseText (松散 JSONL fallback)', () => {
  it('从代码块、说明文字和连续 JSON object 中提取合法 timeline 事件', () => {
    const text = [
      '下面是结果：',
      '```jsonl',
      '{"type":"overview","text":"主题"}{"type":"chapter","id":"c1","startCueId":0,"endCueId":1,"title":"开场","summary":"说明"}',
      '```',
      '{"type":"done"}',
    ].join('\n');

    const events = extractTimelineEventsFromLooseText(text);

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('overview');
    expect(events[1]?.type).toBe('chapter');
  });

  it('忽略非 timeline object，避免把完整 JSON 分析对象误当 JSONL 事件', () => {
    const text = '{"overview":"完整 JSON","chapters":[]}';
    expect(extractTimelineEventsFromLooseText(text)).toHaveLength(0);
  });
});

describe('buildTimelineStreamDraft (Round 24 QA2 必修 B: 草稿累积)', () => {
  it('overview + chapter + segment 按顺序累积', () => {
    const events: TimelineStreamEventBody[] = [
      { type: 'overview', text: '主题' },
      {
        type: 'chapter',
        id: 'c1',
        startCueId: 0,
        endCueId: 5,
        contentTag: 'concept',
        title: '开场',
        summary: '白',
      },
      {
        type: 'segment',
        chapterId: 'c1',
        startCueId: 0,
        endCueId: 2,
        contentTag: 'method',
        title: '提出问题',
        summary: '先抛疑问',
      },
      { type: 'chapter', id: 'c2', startCueId: 6, endCueId: 9, title: '主体', summary: '核心' },
    ];
    const draft = buildTimelineStreamDraft(events);
    expect(draft.overview).toBe('主题');
    expect(draft.chapters).toHaveLength(2);
    expect(draft.chapters[0]?.id).toBe('c1');
    expect(draft.chapters[0]?.contentTag).toBe('concept');
    expect(draft.chapters[0]?.segments).toHaveLength(1);
    expect(draft.chapters[0]?.segments[0]?.contentTag).toBe('method');
    expect(draft.chapters[1]?.id).toBe('c2');
    expect(draft.chapters[1]?.segments).toHaveLength(0);
    expect(draft.orphanSegments).toHaveLength(0);
  });

  it('orphan segment：无对应 chapter 时累积到 orphanSegments', () => {
    const events: TimelineStreamEventBody[] = [
      { type: 'segment', chapterId: 'unknown', startCueId: 0, endCueId: 1, title: '孤儿', summary: '无父' },
    ];
    const draft = buildTimelineStreamDraft(events);
    expect(draft.chapters).toHaveLength(0);
    expect(draft.orphanSegments).toHaveLength(1);
    expect(draft.orphanSegments[0]?.chapterId).toBe('unknown');
  });

  it('overview 多次出现时取最后一次', () => {
    const events: TimelineStreamEventBody[] = [
      { type: 'overview', text: '第一次' },
      { type: 'overview', text: '第二次' },
    ];
    const draft = buildTimelineStreamDraft(events);
    expect(draft.overview).toBe('第二次');
  });
});

describe('draftToJsonlAnalysisContent (Round 24 QA2 必修 B: 草稿转 VideoAnalysis 输入)', () => {
  it('输出形如 { overview, chapters: [...] } 字符串', () => {
    const draft = {
      overview: '主题',
      chapters: [
        {
          id: 'c1',
          startCueId: 0,
          endCueId: 5,
          title: '开场',
          summary: '白',
          importance: 'must-watch' as const,
          contentTag: 'concept' as const,
          segments: [
            {
              startCueId: 0,
              endCueId: 2,
              title: '提出问题',
              summary: '先抛疑问',
              importance: 'optional' as const,
              contentTag: 'method' as const,
            },
          ],
        },
      ],
      orphanSegments: [],
    };
    const json = draftToJsonlAnalysisContent(draft);
    const parsed = JSON.parse(json) as {
      overview: string;
      chapters: {
        importance?: string;
        contentTag?: string;
        segments: { importance?: string; contentTag?: string }[];
      }[];
    };
    expect(parsed.overview).toBe('主题');
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]?.importance).toBe('must-watch');
    expect(parsed.chapters[0]?.contentTag).toBe('concept');
    expect(parsed.chapters[0]?.segments).toHaveLength(1);
    expect(parsed.chapters[0]?.segments[0]?.importance).toBe('optional');
    expect(parsed.chapters[0]?.segments[0]?.contentTag).toBe('method');
  });

  it('可以被 parseVideoAnalysisJson 解析（含 cue id 映射）', () => {
    const draft = {
      overview: '主题',
      chapters: [
        {
          id: 'c1',
          startCueId: 0,
          endCueId: 1,
          title: '开场',
          summary: '白',
          segments: [],
        },
      ],
      orphanSegments: [],
    };
    const json = draftToJsonlAnalysisContent(draft);
    // subtitles 至少 2 条
    const subtitles = [
      { start: 0, end: 1, text: '测试字幕行 1' },
      { start: 1, end: 2, text: '测试字幕行 2' },
    ];
    const analysis = parseVideoAnalysisJson({
      content: json,
      modelUsed: 'MiniMax-M2.7-highspeed',
      sourceMode: 'subtitle',
      subtitles,
    });
    expect(analysis.overview).toBe('主题');
    expect(analysis.chapters).toHaveLength(1);
    expect(analysis.chapters[0]?.timestamp).toBe(0);
  });
});

describe('canParseAsCompleteJson (Round 24 QA2 必修 D: 旧路径 fallback helper)', () => {
  it('合法完整 JSON → true', () => {
    const subtitles = [
      { start: 0, end: 1, text: '测试字幕行 1' },
      { start: 1, end: 2, text: '测试字幕行 2' },
    ];
    const content = JSON.stringify({
      overview: '主题',
      chapters: [],
    });
    const result = canParseAsCompleteJson(
      content,
      parseVideoAnalysisJson,
      'MiniMax-M2.7-highspeed',
      subtitles,
    );
    expect(result).toBe(true);
  });

  it('非法 JSON → false（不抛错）', () => {
    const subtitles = [
      { start: 0, end: 1, text: '测试字幕行 1' },
      { start: 1, end: 2, text: '测试字幕行 2' },
    ];
    const result = canParseAsCompleteJson(
      '这是半截 JSON{ "broken',
      parseVideoAnalysisJson,
      'MiniMax-M2.7-highspeed',
      subtitles,
    );
    expect(result).toBe(false);
  });
});
