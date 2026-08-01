import { describe, expect, it } from 'vitest';
import { normalizeLearningMomentCoach } from '@core/learning/normalize-learning-moment-coach';
import type { LearningMoment, LearningMomentCoach } from '@core/types';

const keepCoach: LearningMomentCoach = {
  response: '这条先保留。',
  handling: 'keep',
  suggestedQuestions: [],
  linkedTimestamps: [],
  generatedAt: 1,
  modelUsed: 'model',
};

describe('normalizeLearningMomentCoach', () => {
  it('疑问类记录不让模型兜成保留', () => {
    const moment: LearningMoment = {
      id: 'm1',
      kind: 'question',
      content: '作者这个判断证据够吗？',
      createdAt: 1,
    };

    expect(
      normalizeLearningMomentCoach({ coach: keepCoach, moment, guide: undefined }).handling,
    ).toBe('verify');
  });

  it('行动类记录兜底为行动', () => {
    const moment: LearningMoment = {
      id: 'm1',
      kind: 'action',
      content: '明天试一下这个方法。',
      createdAt: 1,
    };

    expect(
      normalizeLearningMomentCoach({ coach: keepCoach, moment, guide: undefined }).handling,
    ).toBe('apply');
  });

  it('模型已经给出非 keep 时不覆盖', () => {
    const moment: LearningMoment = {
      id: 'm1',
      kind: 'note',
      content: '这个说法要查证。',
      createdAt: 1,
    };

    expect(
      normalizeLearningMomentCoach({
        coach: { ...keepCoach, handling: 'ask' },
        moment,
        guide: undefined,
      }).handling,
    ).toBe('ask');
  });
});
