import { describe, expect, it } from 'vitest';
import { parseLearningMomentCoachJson } from '@core/learning/learning-moment-coach-schema';

describe('parseLearningMomentCoachJson', () => {
  it('解析单条记录的补充说明', () => {
    const coach = parseLearningMomentCoachJson({
      content: JSON.stringify({
        response: '这是一个娱乐兴趣点，保留感受即可。',
        handling: 'release',
        suggestedQuestions: [],
        linkedTimestamps: [{ timestamp: 42, reason: '笑点出现处' }],
      }),
      generatedAt: 2,
      modelUsed: 'model',
    });
    expect(coach).toMatchObject({
      response: '这是一个娱乐兴趣点，保留感受即可。',
      handling: 'release',
      linkedTimestamps: [{ timestamp: 42, reason: '笑点出现处' }],
    });
  });
});
