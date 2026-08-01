import { describe, expect, it } from 'vitest';
import { selectFollowupContext } from '@core/followup/select-followup-context';
import { buildPackage } from './_fixtures/select-followup-context-fixtures';

/**
 * selectFollowupContext selected intent 双义词消除 + 路由一致性。
 *
 * 拆自 `select-followup-context.test.ts`（原 943 行 → 按职责拆到多文件 < 800 行）。
 */

describe('selectFollowupContext (selected intent 双义词消除 + 路由一致性)', () => {
  it('"现在讲的是什么？" 优先使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '现在讲的是什么？',
      contextPackage: buildPackage(),
      currentTime: 125,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(125);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('"我选的这个节点为什么重要？" 使用选中的时间点', () => {
    const result = selectFollowupContext({
      question: '我选的这个节点为什么重要？',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
    expect(result.anchorLabel).toBe('selected_timestamp');
  });

  it('"这段讲什么？" 未传选中时间时使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '这段讲什么？',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(125);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('"这里是什么意思？" 使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '这里是什么意思？',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(125);
    expect(result.anchorLabel).toBe('current_time');
  });

  it('"此处讲什么" 使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '此处讲什么',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(125);
  });

  it('"这个片段什么意思" 使用当前播放时间', () => {
    const result = selectFollowupContext({
      question: '这个片段什么意思',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('current_segment');
    expect(result.anchorTimestamp).toBe(125);
  });

  it('"选中的讲什么？" 即使有当前播放时间也使用选中时间点', () => {
    const result = selectFollowupContext({
      question: '选中的讲什么？',
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

  it('"选中的这段讲什么？" 由 selected intent 胜出', () => {
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

  it('英文 "this segment" 不误路由到当前片段', () => {
    const result = selectFollowupContext({
      question: 'what does this segment talk about?',
      contextPackage: buildPackage(),
      currentTime: 125,
    });
    expect(result.primaryScope).toBe('global');
  });

  it('英文 "selected segment" 使用选中时间点', () => {
    const result = selectFollowupContext({
      question: 'explain the selected segment',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
    expect(result.anchorLabel).toBe('selected_timestamp');
  });

  it('英文 "picked segment" 使用选中时间点', () => {
    const result = selectFollowupContext({
      question: 'explain the picked segment',
      contextPackage: buildPackage(),
      currentTime: 30,
      selectedTimestamp: 300,
    });
    expect(result.primaryScope).toBe('selected_segment');
    expect(result.anchorTimestamp).toBe(300);
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
});
