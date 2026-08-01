import { describe, expect, it } from 'vitest';
import {
  extractKeywordAfterProbe,
  parseExplicitTimestamp,
} from '@core/followup/select-followup-context';

/**
 * 公开时间点 / 关键词触发词解析（独立单元）。
 *
 * 拆自 `select-followup-context.test.ts`（原 943 行 → 按职责拆到多文件 < 800 行）。
 */

describe('parseExplicitTimestamp (时间点识别)', () => {
  it('parses mm:ss 形式', () => {
    expect(parseExplicitTimestamp('12:30 这段在讲什么')).toBe(12 * 60 + 30);
    expect(parseExplicitTimestamp('3:05')).toBe(3 * 60 + 5);
  });

  it('parses hh:mm:ss 形式', () => {
    expect(parseExplicitTimestamp('1:02:11 在干什么')).toBe(1 * 3600 + 2 * 60 + 11);
  });

  it('returns null when no timestamp is found', () => {
    expect(parseExplicitTimestamp('这段在讲什么')).toBeNull();
  });

  it('prefers hh:mm:ss over mm:ss when both could match', () => {
    // 1:02:11 不会被错认成 "1:02"
    expect(parseExplicitTimestamp('1:02:11')).toBe(1 * 3600 + 2 * 60 + 11);
  });

  it('ignores bogus minutes/seconds (e.g. 99:99)', () => {
    expect(parseExplicitTimestamp('99:99')).toBeNull();
  });
});

describe('extractKeywordAfterProbe (关键词抽取)', () => {
  it('从 "有没有提到 X" 抽出 X', () => {
    expect(extractKeywordAfterProbe('有没有提到向量召回？')).toBe('向量召回');
  });

  it('从 "是否讲了 X" 抽出 X', () => {
    expect(extractKeywordAfterProbe('是否讲了 BM25？')).toBe('BM25');
  });

  it('支持 ASCII 关键词', () => {
    expect(extractKeywordAfterProbe('有没有提到 RAG？')).toBe('RAG');
  });

  it('支持多词 ASCII 关键词', () => {
    expect(extractKeywordAfterProbe('有没有提到 computer use？')).toBe('computer use');
  });

  it('自然问法会剥掉尾部语气词和位置追问', () => {
    expect(extractKeywordAfterProbe('有提到机甲吗')).toBe('机甲');
    expect(extractKeywordAfterProbe('有提到徐州吗，在哪里')).toBe('徐州');
  });

  it('显式"是否提到"问法允许单字中文主题', () => {
    expect(extractKeywordAfterProbe('有提到吃吗')).toBe('吃');
    expect(extractKeywordAfterProbe('有没有提到吃什么吗')).toBe('吃');
  });

  it('没有触发词时返回 null', () => {
    expect(extractKeywordAfterProbe('讲了什么')).toBeNull();
  });

  it('抽取到单字符 ASCII 时返回 null', () => {
    expect(extractKeywordAfterProbe('有没有提到 X？')).toBeNull();
  });
});
