import { describe, expect, it } from 'vitest';
import {
  createWatchDecisionStreamPreview,
  hasWatchDecisionStreamPreview,
} from '@core/learning/watch-decision-stream-preview';

describe('createWatchDecisionStreamPreview', () => {
  it('从未完整解析的生成文本里提取已闭合的可读字段', () => {
    const preview = createWatchDecisionStreamPreview(
      '{"contentType":"游戏杂谈","chapters":[{"title":"开场立场","segments":[{"title":"核心观点"}]}],"decision":{"verdict":"选择性看","overallMeaning":"围绕绝区零争议说明作者立场"',
    );

    expect(preview).toEqual({
      contentType: '游戏杂谈',
      verdict: '选择性看',
      overallMeaning: '围绕绝区零争议说明作者立场',
      nodeTitles: ['开场立场', '核心观点'],
    });
    expect(hasWatchDecisionStreamPreview(preview)).toBe(true);
  });

  it('忽略还没有闭合的字符串，避免展示半截结论', () => {
    const preview = createWatchDecisionStreamPreview(
      '{"contentType":"课程讲解","decision":{"verdict":"值得系统',
    );

    expect(preview).toEqual({
      contentType: '课程讲解',
      nodeTitles: [],
    });
  });

  it('能处理 JSON 字符串转义并去重标题', () => {
    const preview = createWatchDecisionStreamPreview(
      '{"chapters":[{"title":"Skill \\"插件\\""},{"title":"Skill \\"插件\\""}]}',
    );

    expect(preview.nodeTitles).toEqual(['Skill "插件"']);
  });

  it('decision.overallMeaning 未出现时用 overview 作为主要内容预览', () => {
    const preview = createWatchDecisionStreamPreview(
      '{"contentType":"课程讲解","overview":"视频讲 Cursor 入门流程"}',
    );

    expect(preview.overallMeaning).toBe('视频讲 Cursor 入门流程');
  });

  it('流式残缺前缀后接普通生成完整结果时，继续提取后面的可读字段', () => {
    const preview = createWatchDecisionStreamPreview(
      '{"decision":{"verdict":"选择性' +
        '{"contentType":"课程讲解","decision":{"verdict":"完整细看","overallMeaning":"视频讲 Cursor 入门流程"},"chapters":[{"title":"核心演示"}]}',
    );

    expect(preview).toEqual({
      contentType: '课程讲解',
      verdict: '完整细看',
      overallMeaning: '视频讲 Cursor 入门流程',
      nodeTitles: ['核心演示'],
    });
  });
});
