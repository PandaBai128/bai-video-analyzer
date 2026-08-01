import { describe, expect, it } from 'vitest';
import { buildLearningGuidePrompt } from '@core/prompts/learning-guide';
import type { LearningSession, VideoAnalysis, VideoMetadata } from '@core/types';

const metadata: VideoMetadata = {
  platform: 'bilibili',
  videoId: 'BV1fun',
  url: 'https://www.bilibili.com/video/BV1fun',
  title: '羽毛双剑与粉色特效整活',
  author: 'UP 主',
  duration: 300,
};

const session: LearningSession = {
  id: 'bilibili:BV1fun',
  schemaVersion: 2,
  platform: 'bilibili',
  videoId: 'BV1fun',
  goal: { mode: 'adaptive', focus: '' },
  coach: { enabled: false, intensity: 'light', customInstruction: '' },
  moments: [],
  exchanges: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('buildLearningGuidePrompt', () => {
  it('要求模型按内容类型生成中性快速分析，而不是套固定学习模板', () => {
    const prompt = buildLearningGuidePrompt({
      metadata,
      transcriptCues: [{ start: 0, text: '今天我们看这个粉色特效有多离谱。' }],
      analysis: null,
      session,
    });
    expect(prompt).toContain('不要把所有视频都当课程');
    expect(prompt).toContain('bAI 视频分析助手');
    expect(prompt).toContain('视频快速分析');
    expect(prompt).toContain('视频主要讲什么、有哪些结论和观点、重点是什么');
    expect(prompt).toContain('不要对作者或视频下“好 / 坏 / 值得 / 不值得”的绝对结论');
    expect(prompt).toContain('"decision"');
    expect(prompt).toContain('"rating": "worth_watching | selective | quick_browse | skip"');
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"valueProfile"');
    expect(prompt).toContain('"criteria"');
    expect(prompt).toContain('必须先判断内容类型，再按该类型常见观看需求生成分析');
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
    expect(prompt).toContain(
      'entertainment_reaction：情绪价值、节目效果、人物魅力、剪辑节奏、放松观看适配',
    );
    expect(prompt).toContain('风险/成本类维度按正向理解：高分表示边界较清晰或成本较低');
    expect(prompt).toContain('每项只填 label 和 score，不要输出 reason');
    expect(prompt).toContain('{ "label": "按 kind 选择对应固定维度", "score": 0 }');
    expect(prompt).toContain('overallMeaning 必须直接概括视频主线、主要结论或观点');
    expect(prompt).toContain('访谈/Q&A：说明谁在回答什么');
    expect(prompt).toContain('娱乐/reaction/vlog：说明情绪价值、节目效果');
    expect(prompt).not.toContain('"reason": "短句说明为什么这一项这样评分');
    expect(prompt).not.toContain('"scoreBreakdown"');
    expect(prompt).not.toContain('"informationDensity"');
    expect(prompt).not.toContain('"actionability"');
    expect(prompt).not.toContain('"evidenceReliability"');
    expect(prompt).not.toContain('信息密度、独特价值、可操作性、证据可信度、时间成本');
    expect(prompt).toContain('"worthReasons"');
    expect(prompt).toContain('"bestFor"');
    expect(prompt).toContain('"notFor"');
    expect(prompt).toContain('"learningValue"');
    expect(prompt).not.toContain('"timePlans"');
    expect(prompt).not.toContain('"mustWatch"');
    expect(prompt).not.toContain('"canWatch"');
    expect(prompt).not.toContain('"canSkim"');
    expect(prompt).not.toContain('"canSkip"');
    expect(prompt).toContain('不要输出 timePlans / mustWatch / canWatch / canSkim / canSkip');
    expect(prompt).toContain('娱乐、吐槽、reaction');
    expect(prompt).toContain('worthReasons、notFor、learningValue、reservations 每组最多 3 条');
    expect(prompt).toContain('worth_watching：适合按顺序或系统了解');
    expect(prompt).toContain('quick_browse：通过快速预览即可掌握主要内容');
    expect(prompt).toContain('skip：更适合作为资料按需查阅');
    expect(prompt).toContain('不要用“完整细看 / 选择性看 / 快速浏览 / 可以跳过”或“值得 / 不值得”作为 verdict 开头');
    expect(prompt).toContain('60-79 通常 selective');
    expect(prompt).toContain('40-59 通常 quick_browse');
    expect(prompt).toContain('valueProfile 必须存在');
    expect(prompt).toContain('criteria 必须使用 valueProfile.kind 对应的固定清单');
    expect(prompt).toContain('rating、score 和 valueProfile 是为兼容现有数据结构保留的内部参考元数据');
    expect(prompt).toContain('worthReasons 是兼容字段名，内容应回答“视频有哪些内容精华”');
    expect(prompt).toContain('notFor 是兼容字段名，内容应描述“哪些人或场景只需按需参考”');
    expect(prompt).toContain(
      '不要输出旧 cards、旧 mentor、旧 goalOptions、旧 watchStrategy 或旧 noteStrategy',
    );
    expect(prompt).not.toContain('watchMode');
    expect(prompt).not.toContain('thinkingFocus 禁止复述 cue');
    expect(prompt).toContain('用户额外关注：用户没有额外关注');
  });

  it('把时间线小节作为内容判断证据，但独立分析不再生成路线字段', () => {
    const analysis: VideoAnalysis = {
      overview: '这个视频讲 Codex 使用流程。',
      watchStrategy: [],
      coreTakeaways: [],
      reviewSummary: '',
      chapters: [
        {
          timestamp: 1836,
          endTimestamp: 2089,
          title: 'NotebookLM MCP 接入演示',
          summary: '演示 MCP 配置过程。',
          importance: 'recommended',
          watchGuide: '看配置过程即可。',
          segments: [
            {
              timestamp: 1836,
              endTimestamp: 1940,
              title: 'NotebookLM MCP 接入',
              summary: '讲 MCP 配置和连通。',
              importance: 'recommended',
            },
          ],
        },
      ],
      timeline: [],
      quotes: [],
      keyConcepts: [],
      inspirations: [],
      generatedAt: 1,
      modelUsed: 'model',
      sourceMode: 'subtitle',
    };

    const prompt = buildLearningGuidePrompt({
      metadata,
      transcriptCues: [{ start: 1836, text: '这里开始配置 NotebookLM 的 MCP。' }],
      analysis,
      session,
    });

    expect(prompt).toContain('[30:36-34:49] 章节：NotebookLM MCP 接入演示');
    expect(prompt).toContain('[30:36-32:20] 小节：NotebookLM MCP 接入');
    expect(prompt).toContain('独立分析可以参考它判断内容结构和证据强弱');
    expect(prompt).toContain('但不要输出片段路线');
    expect(prompt).not.toContain('decision 里的片段建议必须优先从 <optional_timeline> 选择');
  });

  it('英文输出时，用户可见 JSON 字符串和固定评分维度要求英文', () => {
    const prompt = buildLearningGuidePrompt({
      metadata,
      transcriptCues: [{ start: 0, text: '今天我们看这个粉色特效有多离谱。' }],
      analysis: null,
      session,
      outputLocale: 'en-US',
    });

    expect(prompt).toContain('Hard rule: every user-visible JSON string value must be English');
    expect(prompt).toContain(
      'learning_tutorial: Structure clarity, Transferable methods, Complete steps',
    );
    expect(prompt).toContain('English short label');
    expect(prompt).toContain('User-visible English type');
    expect(prompt).not.toContain('用户可见中文类型，例如');
    expect(prompt).not.toContain('learning_tutorial：结构清晰、可迁移方法');
  });
});
