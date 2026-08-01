import { describe, expect, it } from 'vitest';
import {
  extractSuggestedQuestions,
  splitSuggestedQuestions,
  stripSuggestedQuestionsSection,
} from '@core/followup/followup-suggestions';

describe('extractSuggestedQuestions (Round 16 必修 2)', () => {
  it('从 "## 可以继续问" heading 下的 - bullet 列表提取', () => {
    const md = `结论：这里主要讲 BM25。

可以继续问：
- 这个观点和前面哪段有关？
- 这里有哪些反例？
- BM25 和 TF-IDF 在实际中怎么选？`;
    expect(extractSuggestedQuestions(md)).toEqual([
      '这个观点和前面哪段有关？',
      '这里有哪些反例？',
      'BM25 和 TF-IDF 在实际中怎么选？',
    ]);
  });

  it('支持带 emoji 的 heading：🧭 可以继续问', () => {
    const md = `回答结束。

🧭 可以继续问
1. 这段为什么重要？
2. 哪一段值得重看？`;
    expect(extractSuggestedQuestions(md)).toEqual(['这段为什么重要？', '哪一段值得重看？']);
  });

  it('支持 "你可以继续问："（带冒号）', () => {
    const md = `回答结束。

你可以继续问：
- 为什么 BM25 优于 TF-IDF？
- 向量召回和倒排索引怎么结合？`;
    expect(extractSuggestedQuestions(md)).toEqual([
      '为什么 BM25 优于 TF-IDF？',
      '向量召回和倒排索引怎么结合？',
    ]);
  });

  it('支持 **加粗** heading', () => {
    const md = `回答结束。

**可以继续问**：
- 第一个问题是什么？
- 第二个问题呢？`;
    expect(extractSuggestedQuestions(md)).toEqual(['第一个问题是什么？', '第二个问题呢？']);
  });

  it('支持英文 heading：You can ask next', () => {
    const md = `The video is mainly a quick technique showcase.

You can ask next:
- How does the half-fan shot work?
- Which part is most worth replaying?`;
    expect(extractSuggestedQuestions(md)).toEqual([
      'How does the half-fan shot work?',
      'Which part is most worth replaying?',
    ]);
  });

  it('最多取 3 条', () => {
    const md = `可以继续问：
- 第一个问题是什么？
- 第二个问题呢？
- 第三个问题？
- 第四个问题？
- 第五个问题？`;
    expect(extractSuggestedQuestions(md)).toEqual(['第一个问题是什么？', '第二个问题呢？', '第三个问题？']);
  });

  it('没有 "可以继续问" 小节时返回空数组', () => {
    const md = `直接回答用户的问题。

依据：
- [03:20] 视频讲过`;
    expect(extractSuggestedQuestions(md)).toEqual([]);
  });

  it('空字符串 / undefined-style 返回空数组', () => {
    expect(extractSuggestedQuestions('')).toEqual([]);
  });

  it('清洗：去掉首尾引号 / 反引号 / 中文引号 / bullet 残留', () => {
    const md = `可以继续问：
- "什么是向量召回？"
- \`什么是 reranker？\`
- 「端到端检索的关键是？」`;
    expect(extractSuggestedQuestions(md)).toEqual([
      '什么是向量召回？',
      '什么是 reranker？',
      '端到端检索的关键是？',
    ]);
  });

  it('**加粗的问题** 也能清洗：去掉 ** 残留', () => {
    const md = `可以继续问：
- **加粗的问题？**`;
    expect(extractSuggestedQuestions(md)).toEqual(['加粗的问题？']);
  });

  it('太短（< 4 字）的项被丢弃', () => {
    const md = `可以继续问：
- 嗯
- 这个观点和前面哪段有关？`;
    expect(extractSuggestedQuestions(md)).toEqual(['这个观点和前面哪段有关？']);
  });

  it('heading 之前的 "可以继续问" 文本不会被误识别', () => {
    const md = `这是关于"可以继续问"的讨论，不是真的小节标题。

可以继续问：
- 第一个问题是什么？
- 第二个问题呢？`;
    expect(extractSuggestedQuestions(md)).toEqual(['第一个问题是什么？', '第二个问题呢？']);
  });
});

describe('splitSuggestedQuestions / stripSuggestedQuestionsSection (Round 17 必修 C)', () => {
  it('splitSuggestedQuestions 把"可以继续问"列表从正文里剥掉，正文不再显示该列表', () => {
    const md = `直接回答用户的结论。

可以继续问：
- 为什么 BM25 优于 TF-IDF？
- 向量召回怎么用？`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['为什么 BM25 优于 TF-IDF？', '向量召回怎么用？']);
    expect(split.bodyMarkdown).not.toContain('可以继续问');
    expect(split.bodyMarkdown).not.toContain('为什么 BM25 优于 TF-IDF？');
    expect(split.bodyMarkdown).toContain('直接回答用户的结论。');
  });

  it('splitSuggestedQuestions 把英文追问建议从正文里剥掉', () => {
    const md = `Direct answer.

You can ask next:
- How does the timing work?
- What should I replay?`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['How does the timing work?', 'What should I replay?']);
    expect(split.bodyMarkdown).toContain('Direct answer.');
    expect(split.bodyMarkdown).not.toContain('You can ask next');
    expect(split.bodyMarkdown).not.toContain('How does the timing work?');
  });

  it('正文段落不会被误提为建议（"可以继续问"前后的整段是依据）', () => {
    const md = `🎯 结论：核心讲 BM25 的本质。

📌 依据：
- [0:00-2:00] BM25 起源
- [2:00-5:00] 公式推导

可以继续问：
- 怎么把它用在生产？`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['怎么把它用在生产？']);
    // 正文保留所有内容
    expect(split.bodyMarkdown).toContain('BM25 的本质');
    expect(split.bodyMarkdown).toContain('[0:00-2:00]');
  });

  it('"[mm:ss-mm:ss] 字幕：..." 依据行不会被提取为建议', () => {
    const md = `🎯 结论：核心讲 BM25。

可以继续问：
- [2:33-2:50] 字幕：作者自述 BM25 来源
- 这部分和 BM25 有什么关系？`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['这部分和 BM25 有什么关系？']);
    // 依据行不应被当成建议
    expect(split.suggestions.some((s) => s.includes('字幕'))).toBe(false);
  });

  it('重复建议去重（大小写不敏感、首尾问号归一化）', () => {
    const md = `可以继续问：
- 为什么 BM25 优于 TF-IDF？
- 为什么 BM25 优于 TF-IDF
- 为什么 bm25 优于 tf-idf？`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toHaveLength(1);
    expect(split.suggestions[0]).toContain('BM25');
  });

  it('没有"可以继续问"小节时 → suggestions=[]、bodyMarkdown=原文', () => {
    const md = '只是普通回答，没有任何小节。';
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual([]);
    expect(split.bodyMarkdown).toBe(md);
  });

  it('stripSuggestedQuestionsSection 只剥小节、正文不变（不含"可以继续问"列表）', () => {
    const md = `🎯 结论：核心讲 BM25。

可以继续问：
- 为什么 BM25 优于 TF-IDF？
- 向量召回怎么用？`;
    const body = stripSuggestedQuestionsSection(md);
    expect(body).toContain('核心讲 BM25');
    expect(body).not.toContain('可以继续问');
    expect(body).not.toContain('为什么 BM25 优于 TF-IDF？');
  });

  it('非问题的列表项被过滤（缺疑问词、不是问号结尾）', () => {
    const md = `可以继续问：
- 这是一段陈述句没有问号
- 这是一个真正的追问吗？`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['这是一个真正的追问吗？']);
  });

  it('遇下一个 markdown heading 立即停止提取', () => {
    const md = `可以继续问：
- 第一个问题？
- 第二个问题？

## 其它小节

- 这个不应被提取`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['第一个问题？', '第二个问题？']);
  });
});

describe('splitSuggestedQuestions Round 18 必修 3 严格化', () => {
  it('"可以继续问："后跟普通正文（无 bullet）→ suggestions=[]、bodyMarkdown=原文（不剥小节、不误吞正文）', () => {
    const md = `🎯 结论：核心讲 BM25。

可以继续问：
  这一段附近逐字稿较少，以下基于章节和时间线概括
  我们没有强凑三个候选问题，因为用户问的已经是收口问题。`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual([]);
    // 关键不变量：bodyMarkdown 必须完整保留原文，**不**剥小节
    expect(split.bodyMarkdown).toBe(md);
    // 显式确认 "可以继续问" 仍然在正文里
    expect(split.bodyMarkdown).toContain('可以继续问：');
    expect(split.bodyMarkdown).toContain('基于章节和时间线概括');
  });

  it('"可以继续问："后无 bullet 但有问号 → 不误删正文', () => {
    const md = `🎯 结论：BM25 是基础。

可以继续问：
  这段附近逐字稿较少，以下基于章节和时间线概括。请告诉我要不要继续深挖？`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual([]);
    expect(split.bodyMarkdown).toBe(md);
  });

  it('"可以继续问："后 bullet 列表里有 1 个非问题 + 1 个真问题 → 正常提取 1 条 + 剥小节', () => {
    const md = `🎯 结论：核心讲 BM25。

可以继续问：
- 这是个普通陈述句
- 为什么 BM25 优于 TF-IDF？`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['为什么 BM25 优于 TF-IDF？']);
    expect(split.bodyMarkdown).not.toContain('可以继续问');
    expect(split.bodyMarkdown).toContain('BM25');
  });

  it('"可以继续问："后第一个非空行是 bullet 但**全部**不是问题 → suggestions=[]、原文不剥', () => {
    // 防御：列表项有 bullet 但都不算"问题"（如都是陈述句），整段不剥
    // 避免按钮区全空但正文已被截
    const md = `🎯 结论：核心讲 BM25。

可以继续问：
- 这是一个普通陈述
- 这是另一个普通陈述
- 也是普通陈述`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual([]);
    expect(split.bodyMarkdown).toBe(md);
  });

  it('遇下一个 markdown heading 立即停止，**不**吞下节', () => {
    const md = `🎯 结论：核心讲 BM25。

可以继续问：
- 第一个问题？
- 第二个问题？

## 关键概念

- 这里的关键概念是 X
- 这里的另一个是 Y`;
    const split = splitSuggestedQuestions(md);
    expect(split.suggestions).toEqual(['第一个问题？', '第二个问题？']);
    // body 里应包含下个 heading 和它的内容（不被吞）
    expect(split.bodyMarkdown).toContain('## 关键概念');
    expect(split.bodyMarkdown).toContain('这里的关键概念是 X');
    // 关键不变量：第一个 "可以继续问" 小节已经被剥
    expect(split.bodyMarkdown).not.toContain('第一个问题？');
    expect(split.bodyMarkdown).not.toContain('可以继续问：');
  });
});
