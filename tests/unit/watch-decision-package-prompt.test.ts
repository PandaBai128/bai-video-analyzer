import { describe, expect, it } from 'vitest';
import { buildWatchDecisionPackagePrompt } from '@core/prompts/watch-decision-package';
import type { LearningSession, VideoMetadata } from '@core/types';

const metadata: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1xx',
  url: 'https://www.bilibili.com/video/BV1xx',
  title: 'Codex 教程',
  author: '作者',
  duration: 2450,
};

const session: LearningSession = {
  id: 'bilibili:BV1xx',
  schemaVersion: 3,
  platform: 'bilibili',
  videoId: 'BV1xx',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('buildWatchDecisionPackagePrompt', () => {
  it('分析与导航输出保持减法，不要求 learningValue 和 timePlans', () => {
    const prompt = buildWatchDecisionPackagePrompt({
      metadata,
      transcriptCues: [
        { start: 0, end: 8, text: '开场介绍 Codex 和 Claude Code 的区别。' },
        { start: 8, end: 16, text: '演示插件使用。' },
      ],
      session,
    });

    expect(prompt).toContain('同源“分析与导航包”生成器');
    expect(prompt).toContain('不要对作者或视频下绝对价值结论');
    expect(prompt).toContain('rating 和 score 为兼容字段');
    expect(prompt).toContain('decision 里的可点击片段必须引用本次输出的 timeline nodeId');
    expect(prompt).toContain('先完成 chapters/segments，再在 decision 中引用已经输出的 nodeId');
    expect(prompt).toContain('title 必须逐字复制 nodeId 对应 chapter / segment 的 title');
    expect(prompt).toContain('全片 segment 总数优先控制在 12-20 个');
    expect(prompt).toContain('不要输出 learningValue 或 timePlans');
    expect(prompt).not.toContain('"learningValue"');
    expect(prompt).not.toContain('"timePlans"');
    expect(prompt.indexOf('"contentType"')).toBeLessThan(prompt.indexOf('"chapters"'));
    expect(prompt.indexOf('"chapters"')).toBeLessThan(prompt.indexOf('"decision"'));
    expect(prompt).toContain('chapters 总数最多 12 个');
    expect(prompt).toContain('segments 总数最多 24 个');
    expect(prompt).toContain('两小时以上视频也只做导航级压缩');
    expect(prompt).toContain(
      'learning_tutorial：结构清晰、可迁移方法、步骤完整、时效可控、实践成本',
    );
    expect(prompt).toContain(
      'interview_qa：人物/事件稀缺性、回答信息量、真实细节、观点启发、闲聊控制',
    );
    expect(prompt).toContain(
      'opinion_commentary：论点清晰度、例子支撑、视角新鲜度、证据边界清晰、表达效率',
    );
    expect(prompt).toContain('product_review：实测证据、对比充分性、购买决策帮助、利益相关可控');
    expect(prompt).toContain('每项只输出 label 和 score，不要输出 reason');
    expect(prompt).toContain('风险/成本类维度按正向理解：高分表示风险可控、边界清晰或成本低');
    expect(prompt).toContain('{ "label": "按 kind 选择对应固定维度", "score": 0 }');
    expect(prompt).not.toContain('信息密度 / 独特价值 / 可操作性 / 证据可信度 / 时间成本');
    expect(prompt).toContain(
      'contentType、overview 和 decision.overallMeaning 必须跟 valueProfile.kind 对齐',
    );
    expect(prompt).not.toContain('"reason": "短句说明为什么这一项这样评分');
  });

  it('英文输出时，分析、导航和判断的用户可见字符串要求英文', () => {
    const prompt = buildWatchDecisionPackagePrompt({
      metadata,
      transcriptCues: [
        { start: 0, end: 8, text: '开场介绍 Codex 和 Claude Code 的区别。' },
        { start: 8, end: 16, text: '演示插件使用。' },
      ],
      session,
      outputLocale: 'en-US',
    });

    expect(prompt).toContain('Hard rule: every user-visible JSON string value must be English');
    expect(prompt).toContain('English short label');
    expect(prompt).toContain('Short English chapter title');
    expect(prompt).toContain(
      'learning_tutorial: Structure clarity, Transferable methods, Complete steps',
    );
    expect(prompt).not.toContain('用户能理解的中文短标签，例如');
    expect(prompt).not.toContain('learning_tutorial：结构清晰、可迁移方法');
  });
});
