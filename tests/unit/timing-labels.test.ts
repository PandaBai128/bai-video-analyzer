import { describe, expect, it } from 'vitest';
import { createModelAnalysisTimingLabel } from '@core/analysis/timing-labels';

describe('createModelAnalysisTimingLabel (Round 25 必修 A timing label helper)', () => {
  it('模型名非空：返回 "模型分析 · {model}"', () => {
    expect(createModelAnalysisTimingLabel('MiniMax-M3')).toBe('模型分析 · MiniMax-M3');
  });

  it('模型名为空字符串：fallback 到 "模型分析"（**不**显示尾部的 · ）', () => {
    expect(createModelAnalysisTimingLabel('')).toBe('模型分析');
  });

  it('模型名为 null：fallback 到 "模型分析"', () => {
    expect(createModelAnalysisTimingLabel(null)).toBe('模型分析');
  });

  it('模型名为 undefined：fallback 到 "模型分析"', () => {
    expect(createModelAnalysisTimingLabel(undefined)).toBe('模型分析');
  });

  it('模型名仅空白：fallback 到 "模型分析"（trim 后空）', () => {
    expect(createModelAnalysisTimingLabel('   ')).toBe('模型分析');
  });

  it('模型名带前后空白：trim 后拼接（**不**显示多余空白）', () => {
    expect(createModelAnalysisTimingLabel('  MiniMax-M3  ')).toBe('模型分析 · MiniMax-M3');
  });

  it('不同模型名都能正确拼接（provider 中立）', () => {
    expect(createModelAnalysisTimingLabel('GPT-4')).toBe('模型分析 · GPT-4');
    expect(createModelAnalysisTimingLabel('claude-opus-4')).toBe('模型分析 · claude-opus-4');
    expect(createModelAnalysisTimingLabel('deepseek-v3')).toBe('模型分析 · deepseek-v3');
  });

  it('**不**返回任何 provider 品牌写死（MiniMax / 字幕 / 视频 URL 等关键字）', () => {
    const label = createModelAnalysisTimingLabel('MiniMax-M3');
    // helper 生成的 label **不**写死"字幕" / "视频 URL" / "MiniMax"
    // （provider 中立；业务路径**自己**决定是字幕分析 / URL 分析 / 其他）
    expect(label).not.toMatch(/字幕/);
    expect(label).not.toMatch(/视频 URL/);
    expect(label).not.toMatch(/^MiniMax/);
  });
});
