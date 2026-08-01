import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import { buildPackage } from './_fixtures/select-followup-context-fixtures';

/**
 * selectFollowupContext explicit/ambiguous 拆分 + selected intent 优先。
 *
 * 拆自 `select-followup-context.test.ts`（原 943 行 → 按职责拆到多文件 < 800 行）。
 */

describe('selectFollowupContext (explicit/ambiguous 拆分 + selected intent 优先)', () => {
  it('"我选的这段讲什么？" 使用选中时间点', () => {
    const result = selectFollowupContext({
      question: '我选的这段讲什么？',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
    expect(result.anchorLabel).toBe('selected_timestamp');
  });

  it('"选中的这段讲什么？" 使用选中时间点', () => {
    const result = selectFollowupContext({
      question: '选中的这段讲什么？',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
    expect(result.anchorLabel).toBe('selected_timestamp');
  });

  it('"刚才点的讲什么？" 使用选中时间点', () => {
    const result = selectFollowupContext({
      question: '刚才点的讲什么？',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
    expect(result.anchorLabel).toBe('selected_timestamp');
  });

  it('"这段讲什么？" 没有选中时间时使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '这段讲什么？',
      contextPackage: buildPackage(),
      currentTime: 30,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(30);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('"现在讲的是什么？" 使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '现在讲的是什么？',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(30);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('"当前片段讲了什么？" 使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '当前片段讲了什么？',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(30);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('明确问当前片段但缺少当前播放时间时回退到选中时间', () => {
    const result = selectFollowupContext({
      question: '现在讲的是什么？',
      contextPackage: buildPackage(),
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
  });

  it('模糊问当前片段且没有时间锚点时回退到 global', () => {
    const result = selectFollowupContext({
      question: '这段讲什么？',
      contextPackage: buildPackage(),
    });
    expect(result.primaryScope).toBe('global');
  });

  it('选中意图但缺少选中时间时回退到 global', () => {
    const result = selectFollowupContext({
      question: '我选的这个节点',
      contextPackage: buildPackage(),
      currentTime: 30,
    });
    expect(result.primaryScope).toBe('global');
  });

  it('英文 "this node" 使用选中时间点', () => {
    const result = selectFollowupContext({
      question: 'why is this node important?',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
  });

  it('forceCurrentSegment=true 时强制使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '解释当前片段',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
      forceCurrentSegment: true,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(30);
  });
});
