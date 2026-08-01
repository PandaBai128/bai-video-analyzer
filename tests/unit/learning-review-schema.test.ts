import { describe, expect, it } from 'vitest';
import { parseLearningReviewJson } from '@core/learning/learning-review-schema';

describe('parseLearningReviewJson', () => {
  it('解析结构化学习笔记并保留证据时间点', () => {
    const review = parseLearningReviewJson({
      content: `\`\`\`json
{"coreSummary":"核心","keyIdeas":[{"title":"观点","explanation":"解释","evidenceTimestamp":42}],"personalInsights":["我注意到边界"],"transferReflection":"可以迁移到项目边界判断。","openQuestions":["还缺什么证据？"],"actionItems":["做一次验证"],"finalReflection":"总结。"}
\`\`\``,
      generatedAt: 1000,
      modelUsed: 'MiniMax-M2.7-highspeed',
    });

    expect(review.keyIdeas[0]?.evidenceTimestamp).toBe(42);
    expect(review.personalInsights).toEqual(['我注意到边界']);
    expect(review.transferReflection).toBe('可以迁移到项目边界判断。');
    expect(review.generatedAt).toBe(1000);
  });

  it('兼容没有可带走收获的旧输出或低信息输出', () => {
    const review = parseLearningReviewJson({
      content:
        '{"coreSummary":"核心","keyIdeas":[],"personalInsights":[],"openQuestions":[],"actionItems":[],"finalReflection":"总结。"}',
      generatedAt: 1,
      modelUsed: 'model',
    });
    expect(review.keyIdeas).toEqual([]);
    expect(review.personalInsights).toEqual([]);
  });

  it('兼容模型漏掉最终反思的输出，用已有摘要和收获兜底', () => {
    const review = parseLearningReviewJson({
      content:
        '{"coreSummary":"这个视频适合按安装、配置、实操三步学习。","keyIdeas":[{"title":"先跑通环境","explanation":"安装和登录决定后续是否能跟做。"}],"personalInsights":["不要只看演示，要同步在自己的项目里验证。"],"openQuestions":["MCP 部分是否适合现在投入？"],"actionItems":["先完成一次本地项目分析。"]}',
      generatedAt: 1,
      modelUsed: 'model',
    });

    expect(review.finalReflection).toContain('这个视频适合按安装、配置、实操三步学习。');
    expect(review.finalReflection).toContain('不要只看演示');
    expect(review.finalReflection).not.toContain('先完成一次本地项目分析');
    expect(review.finalReflection).not.toContain('MCP 部分是否适合现在投入');
  });

  it('修复模型数组元素漏逗号的 JSON 输出', () => {
    const review = parseLearningReviewJson({
      content:
        '{"coreSummary":"核心","keyIdeas":[{"title":"观点一","explanation":"解释一"} {"title":"观点二","explanation":"解释二"}],"personalInsights":[],"openQuestions":[],"actionItems":[],"finalReflection":"总结。"}',
      generatedAt: 1,
      modelUsed: 'model',
    });

    expect(review.keyIdeas.map((idea) => idea.title)).toEqual(['观点一', '观点二']);
  });
});
