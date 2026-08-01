import { describe, expect, it } from 'vitest';
import {
  detectAmbiguousCurrentSegmentIntent,
  detectCurrentSegmentIntent,
  detectExplicitCurrentSegmentIntent,
  detectSelectedSegmentIntent,
} from '@core/followup/intent-detection';

describe('detectExplicitCurrentSegmentIntent (Round 21 必修 1：明确 current intent)', () => {
  // -------- 中文触发词 --------
  it('中文触发词"现在讲"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('现在讲的是什么？')).toBe(true);
  });

  it('中文触发词"目前讲"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('目前讲到哪了？')).toBe(true);
  });

  it('中文触发词"当前讲"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('当前讲到哪？')).toBe(true);
  });

  it('中文触发词"当前片段"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('当前片段讲了什么？')).toBe(true);
  });

  it('中文触发词"当前播放"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('当前播放位置在讲什么？')).toBe(true);
  });

  it('中文触发词"当前这部分"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('当前这部分是讲什么的？')).toBe(true);
  });

  it('中文触发词"当前这段"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('当前这段是什么意思？')).toBe(true);
  });

  it('中文触发词"当前说的"命中', () => {
    expect(detectExplicitCurrentSegmentIntent('当前说的是什么？')).toBe(true);
  });

  // -------- 英文触发词 --------
  it('英文触发词 "right now" 命中', () => {
    expect(detectExplicitCurrentSegmentIntent('what is happening right now?')).toBe(true);
  });

  it('英文触发词 "current part" 命中', () => {
    expect(detectExplicitCurrentSegmentIntent('explain this current part please')).toBe(true);
  });

  it('英文触发词 "current segment" 命中', () => {
    expect(detectExplicitCurrentSegmentIntent('what does this current segment talk about?')).toBe(true);
  });

  // -------- 不应命中（Round 21 拆分后交给 detectAmbiguousCurrentSegmentIntent） --------
  it('裸"这段讲什么？" 不命中 explicit current（交给 ambiguous current）', () => {
    expect(detectExplicitCurrentSegmentIntent('这段讲什么？')).toBe(false);
  });

  it('裸"这里是什么意思？" 不命中 explicit current（交给 ambiguous current）', () => {
    expect(detectExplicitCurrentSegmentIntent('这里是什么意思？')).toBe(false);
  });

  it('裸"刚才说了什么" 不命中 explicit current（交给 ambiguous current）', () => {
    expect(detectExplicitCurrentSegmentIntent('刚才说了什么')).toBe(false);
  });

  it('裸"this part" 不命中 explicit current（交给 ambiguous current）', () => {
    expect(detectExplicitCurrentSegmentIntent('what does this part cover?')).toBe(false);
  });

  it('"附近" 不应触发（不在任何 current intent 触发词列表里）', () => {
    expect(detectExplicitCurrentSegmentIntent('附近发生了什么？')).toBe(false);
  });

  // -------- 边界 --------
  it('空字符串 / null-style 不报错', () => {
    expect(detectExplicitCurrentSegmentIntent('')).toBe(false);
  });

  it('"这个视频主要讲什么？" 不命中（避免误绑 current_segment）', () => {
    expect(detectExplicitCurrentSegmentIntent('这个视频主要讲什么？')).toBe(false);
  });

  it('单词边界：ASCII 字母数字粘连不算完整词（如 currentpart 不应触发 current part）', () => {
    expect(detectExplicitCurrentSegmentIntent('explain currentpart please')).toBe(false);
  });
});

describe('detectAmbiguousCurrentSegmentIntent (Round 21 必修 1：双义 current intent)', () => {
  // -------- 中文触发词 --------
  it('中文触发词"这段"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('这段讲什么？')).toBe(true);
  });

  it('中文触发词"这一段"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('这一段没听懂')).toBe(true);
  });

  it('中文触发词"这个片段"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('这个片段什么意思')).toBe(true);
  });

  it('中文触发词"这部分"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('这部分讲什么？')).toBe(true);
  });

  it('中文触发词"这里"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('这里是什么意思？')).toBe(true);
  });

  it('中文触发词"这儿"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('这儿在讲什么？')).toBe(true);
  });

  it('中文触发词"此处"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('此处讲什么')).toBe(true);
  });

  it('中文触发词"刚才"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('刚才说了什么')).toBe(true);
  });

  it('中文触发词"刚刚"命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('刚刚讲了什么')).toBe(true);
  });

  // -------- 英文触发词 --------
  it('英文触发词 "this part" 命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('what does this part cover?')).toBe(true);
  });

  it('英文触发词 "around here" 命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('what is discussed around here?')).toBe(true);
  });

  it('英文触发词 "right here" 命中', () => {
    expect(detectAmbiguousCurrentSegmentIntent('what does this video say right here?')).toBe(true);
  });

  // -------- 不应命中（明确词留给 detectExplicitCurrentSegmentIntent） --------
  it('"现在讲的是什么？" 不命中 ambiguous current（由 explicit current 接管）', () => {
    expect(detectAmbiguousCurrentSegmentIntent('现在讲的是什么？')).toBe(false);
  });

  it('"当前片段讲了什么？" 不命中 ambiguous current（由 explicit current 接管）', () => {
    expect(detectAmbiguousCurrentSegmentIntent('当前片段讲了什么？')).toBe(false);
  });

  it('"附近" 不应触发（不在任何 current intent 触发词列表里）', () => {
    expect(detectAmbiguousCurrentSegmentIntent('附近发生了什么？')).toBe(false);
  });

  // -------- 边界 --------
  it('空字符串 / null-style 不报错', () => {
    expect(detectAmbiguousCurrentSegmentIntent('')).toBe(false);
  });

  it('"这个视频主要讲什么？" 不命中（避免误绑 current_segment）', () => {
    expect(detectAmbiguousCurrentSegmentIntent('这个视频主要讲什么？')).toBe(false);
  });

  it('单词边界：ASCII 字母数字粘连不算完整词（如 thispart 不应触发 this part）', () => {
    expect(detectAmbiguousCurrentSegmentIntent('explain thispart please')).toBe(false);
  });
});

describe('detectCurrentSegmentIntent (兼容导出 = explicit || ambiguous)', () => {
  // Round 21 必修 1：保留 Round 17/18/19/20 行为 = explicit || ambiguous
  it('explicit 词触发 detectCurrentSegmentIntent', () => {
    expect(detectCurrentSegmentIntent('现在讲的是什么？')).toBe(true);
  });

  it('ambiguous 词触发 detectCurrentSegmentIntent', () => {
    expect(detectCurrentSegmentIntent('这段讲什么？')).toBe(true);
  });

  it('"这个视频主要讲什么？" 不命中 detectCurrentSegmentIntent', () => {
    expect(detectCurrentSegmentIntent('这个视频主要讲什么？')).toBe(false);
  });
});

describe('detectCurrentSegmentIntent (Round 17 必修 A 意图识别)', () => {
  it('中文触发词"现在讲"命中', () => {
    expect(detectCurrentSegmentIntent('现在讲的是什么？')).toBe(true);
  });

  it('中文触发词"这段"命中', () => {
    expect(detectCurrentSegmentIntent('这段在讲什么')).toBe(true);
  });

  it('中文触发词"这里"命中', () => {
    expect(detectCurrentSegmentIntent('这里是什么意思？')).toBe(true);
  });

  it('中文触发词"刚才"命中', () => {
    expect(detectCurrentSegmentIntent('刚才说了什么')).toBe(true);
  });

  it('中文触发词"这一段"命中', () => {
    expect(detectCurrentSegmentIntent('这一段没听懂')).toBe(true);
  });

  it('英文触发词 "current part" 作为完整单词命中', () => {
    expect(detectCurrentSegmentIntent('what does this current part talk about?')).toBe(true);
  });

  it('英文触发词 "right now" 命中', () => {
    expect(detectCurrentSegmentIntent('what is happening right now?')).toBe(true);
  });

  it('泛问"这个视频主要讲什么？"不命中（避免误绑 current_segment）', () => {
    expect(detectCurrentSegmentIntent('这个视频主要讲什么？')).toBe(false);
  });

  it('泛问"播放速度怎么样？"不命中', () => {
    expect(detectCurrentSegmentIntent('播放速度怎么样？')).toBe(false);
  });

  it('泛问"有没有提到 BM25？"不命中（让 keyword_match 接管）', () => {
    expect(detectCurrentSegmentIntent('有没有提到 BM25？')).toBe(false);
  });

  it('空字符串 / null-style 不报错', () => {
    expect(detectCurrentSegmentIntent('')).toBe(false);
  });

  it('单词边界：ASCII 字母数字粘连不算完整词（如 thistalk 不应触发 this part）', () => {
    // "thistalk" 不应被识别为含 "this part"
    expect(detectCurrentSegmentIntent('thistalk segment')).toBe(false);
  });

  it('"附近" 不应触发（不在触发词列表里）', () => {
    expect(detectCurrentSegmentIntent('附近发生了什么？')).toBe(false);
  });
});

describe('detectSelectedSegmentIntent (Round 19 必修 2 + Round 20 收敛选中片段意图识别)', () => {
  // -------- Round 20：双义词不再命中（语义模糊，让 current intent 接管） --------
  it('Round 20：双义词"这段讲什么？" 不再命中（语义模糊，避免与 current intent 冲突）', () => {
    expect(detectSelectedSegmentIntent('这段讲什么？')).toBe(false);
  });

  it('Round 20：双义词"这一段没听懂" 不再命中', () => {
    expect(detectSelectedSegmentIntent('这一段没听懂')).toBe(false);
  });

  it('Round 20：双义词"这里是什么意思？" 不再命中', () => {
    expect(detectSelectedSegmentIntent('这里是什么意思？')).toBe(false);
  });

  it('Round 20：双义词"此处讲什么" 不再命中', () => {
    expect(detectSelectedSegmentIntent('此处讲什么')).toBe(false);
  });

  it('Round 20：双义词"这个片段什么意思" 不再命中', () => {
    expect(detectSelectedSegmentIntent('这个片段什么意思')).toBe(false);
  });

  it('Round 20：英文双义词"this segment" 不再命中（偏当前语境）', () => {
    expect(detectSelectedSegmentIntent('what does this segment talk about?')).toBe(false);
  });

  // -------- selected-segment triggers 命中（明确指向"用户点选"） --------
  it('中文触发词"这个节点"命中', () => {
    expect(detectSelectedSegmentIntent('这个节点为什么重要？')).toBe(true);
  });

  it('中文触发词"选中的"命中', () => {
    expect(detectSelectedSegmentIntent('选中的这段讲什么？')).toBe(true);
  });

  it('中文触发词"我选的"命中', () => {
    expect(detectSelectedSegmentIntent('我选的这个节点为什么重要？')).toBe(true);
  });

  it('中文触发词"刚才点的"命中', () => {
    expect(detectSelectedSegmentIntent('刚才点的那段讲什么？')).toBe(true);
  });

  it('中文触发词"这个时间点"命中', () => {
    expect(detectSelectedSegmentIntent('这个时间点讲的是什么？')).toBe(true);
  });

  it('组合"我选的这 + 这个节点" 命中', () => {
    // Round 20 验收：自由输入"我选的这个节点为什么重要？"必须命中 → 带 selectedTimestamp。
    expect(detectSelectedSegmentIntent('我选的这个节点为什么重要？')).toBe(true);
  });

  it('英文触发词 "selected segment" 作为完整单词命中', () => {
    expect(detectSelectedSegmentIntent('what does the selected segment talk about?')).toBe(true);
  });

  it('英文触发词 "picked segment" 命中', () => {
    expect(detectSelectedSegmentIntent('explain the picked segment please')).toBe(true);
  });

  it('英文触发词 "this node" 命中', () => {
    expect(detectSelectedSegmentIntent('why is this node important?')).toBe(true);
  });

  it('英文触发词 "this point" 命中', () => {
    expect(detectSelectedSegmentIntent('what does this point cover?')).toBe(true);
  });

  // -------- 全局白名单：命中 → false（不误伤全局问题） --------
  it('全局问题"这个视频主要讲什么？" 不命中（白名单优先）', () => {
    expect(detectSelectedSegmentIntent('这个视频主要讲什么？')).toBe(false);
  });

  it('全局问题"这个视频主要表达什么？" 不命中', () => {
    expect(detectSelectedSegmentIntent('这个视频主要表达什么？')).toBe(false);
  });

  it('全局问题"哪些地方值得重点回看？" 不命中', () => {
    expect(detectSelectedSegmentIntent('哪些地方值得重点回看？')).toBe(false);
  });

  it('全局问题"哪些地方值得看？" 不命中', () => {
    expect(detectSelectedSegmentIntent('哪些地方值得看？')).toBe(false);
  });

  it('全局问题"整理成学习笔记" 不命中', () => {
    expect(detectSelectedSegmentIntent('整理成学习笔记')).toBe(false);
  });

  it('全局问题"学习笔记" 不命中', () => {
    expect(detectSelectedSegmentIntent('学习笔记')).toBe(false);
  });

  it('全局问题"主要表达" 不命中', () => {
    expect(detectSelectedSegmentIntent('主要表达什么')).toBe(false);
  });

  it('全局问题"整体总结" 不命中', () => {
    expect(detectSelectedSegmentIntent('帮我整体总结一下')).toBe(false);
  });

  it('英文"summary" 不命中（白名单优先）', () => {
    expect(detectSelectedSegmentIntent('please give a summary')).toBe(false);
  });

  // -------- 边界 --------
  it('空字符串 / null-style 不报错', () => {
    expect(detectSelectedSegmentIntent('')).toBe(false);
  });

  it('泛问"播放速度怎么样？" 不命中', () => {
    expect(detectSelectedSegmentIntent('播放速度怎么样？')).toBe(false);
  });

  it('"有没有提到 BM25？" 不命中（让 keyword_match 接管）', () => {
    expect(detectSelectedSegmentIntent('有没有提到 BM25？')).toBe(false);
  });

  it('单词边界：ASCII 字母数字粘连不算完整词', () => {
    expect(detectSelectedSegmentIntent('selectedXsegment')).toBe(false);
  });
});
