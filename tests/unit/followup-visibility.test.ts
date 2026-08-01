import { describe, expect, it } from 'vitest';
import {
  buildFollowupContextKey,
  pickFollowupTabVisibility,
} from '@extension/sidepanel/followup-visibility';

describe('followup-visibility (Round 14 必修 2)', () => {
  it('测试 3a：用户没点过追问 + 没分析结果 → 完全不挂载（不浪费 Port）', () => {
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: false,
      analysisTab: 'navigation',
    });
    expect(v.shouldRender).toBe(false);
    expect(v.shouldHide).toBe(true);
  });

  it('测试 3b：用户没点过追问 + 有分析结果 → 仍不挂载（必须用户主动进）', () => {
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: false,
      analysisTab: 'followup',
    });
    // 即使 analysisTab === 'followup'，没点过也不挂载
    expect(v.shouldRender).toBe(false);
    expect(v.shouldHide).toBe(true);
  });

  it('测试 3c：用户点过提问 + 切到导航 → 挂载但 hidden（不卸载，状态保留）', () => {
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: true,
      analysisTab: 'navigation',
    });
    // 关键：shouldRender=true，shouldHide=true → 父组件挂载 + hidden class
    expect(v.shouldRender).toBe(true);
    expect(v.shouldHide).toBe(true);
  });

  it('测试 3d：用户点过追问 + 当前在追问 tab → 挂载且可见', () => {
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: true,
      analysisTab: 'followup',
    });
    expect(v.shouldRender).toBe(true);
    expect(v.shouldHide).toBe(false);
  });

  it('测试 3e：用户点过追问 + 切到笔记 → 挂载但 hidden', () => {
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: true,
      analysisTab: 'notes',
    });
    expect(v.shouldRender).toBe(true);
    expect(v.shouldHide).toBe(true);
  });

  it('测试 4a：contextKey 变化（切视频）应该折叠成不同 key，供提问 session 切换快照', () => {
    const k1 = buildFollowupContextKey({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
      analysisMode: 'subtitle',
    });
    const k2 = buildFollowupContextKey({
      platform: 'bilibili',
      contentKey: 'BV1yy',
      analysisMode: 'subtitle',
    });
    const k3 = buildFollowupContextKey({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
      analysisMode: 'multimodal',
    });
    // 视频 ID 变 → key 变
    expect(k1).not.toBe(k2);
    // 切模式 → key 变
    expect(k1).not.toBe(k3);
    // 完全相同时 → key 稳定
    expect(
      buildFollowupContextKey({
        platform: 'bilibili',
        contentKey: 'BV1xx:p=1',
        analysisMode: 'subtitle',
      }),
    ).toBe(k1);
  });

  it('测试 4b：contextKey 对 undefined / null 安全', () => {
    const k = buildFollowupContextKey({
      platform: null,
      contentKey: null,
      analysisMode: 'subtitle',
    });
    expect(k).toBe('none:none:subtitle');
  });

  it('Round 28 必修 C 修订：用户点过追问后**始终**挂载（缓存清空也挂载，显示 no_context）', () => {
    const before = pickFollowupTabVisibility({
      hasVisitedFollowup: true,
      analysisTab: 'followup',
    });
    expect(before.shouldRender).toBe(true);
    // 内容底座被清空后**仍**挂载，
    //   FollowupTab 内部 `no_context` 分支处理（**不**卸载避免重建 Port）
    const after = pickFollowupTabVisibility({
      hasVisitedFollowup: true,
      analysisTab: 'followup',
    });
    expect(after.shouldRender).toBe(true);
  });

  it('Round 28 必修 C 验证：用户没点过追问 + 缓存清空 → 仍**不**挂载', () => {
    // 边界：hasVisitedFollowup 仍是唯一关键守卫
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: false,
      analysisTab: 'followup',
    });
    expect(v.shouldRender).toBe(false);
  });

  it('Round 28 必修 C 验收：用户点过追问 + 未分析 + 当前在 followup tab → 挂载且可见', () => {
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: true,
      analysisTab: 'followup',
    });
    // 新行为：未分析也挂载，FollowupTab 内部 no_context 分支显示准备 CTA
    expect(v.shouldRender).toBe(true);
    expect(v.shouldHide).toBe(false);
  });

  it('Round 28 必修 C 验收：用户点过提问 + 未分析 + 切到 navigation tab → 挂载但 hidden（不卸载）', () => {
    const v = pickFollowupTabVisibility({
      hasVisitedFollowup: true,
      analysisTab: 'navigation',
    });
    expect(v.shouldRender).toBe(true);
    expect(v.shouldHide).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 22 必修 A4：buildFollowupContextKey 用 contentKey 隔离多 P
// ---------------------------------------------------------------------------

describe('buildFollowupContextKey (Round 22 必修 A4: B 站多 P 隔离)', () => {
  it('同 BV 不同 p → 不同 key（关键不变量）', () => {
    const p1 = buildFollowupContextKey({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=1',
      analysisMode: 'subtitle',
    });
    const p8 = buildFollowupContextKey({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=8',
      analysisMode: 'subtitle',
    });
    const p10 = buildFollowupContextKey({
      platform: 'bilibili',
      contentKey: 'BV1xx:p=10',
      analysisMode: 'subtitle',
    });
    expect(p1).not.toBe(p8);
    expect(p8).not.toBe(p10);
    expect(p1).not.toBe(p10);
  });

  it('YouTube: contentKey=videoId 时 key 行为不变', () => {
    const yt = buildFollowupContextKey({
      platform: 'youtube',
      contentKey: 'dQw4w9WgXcQ',
      analysisMode: 'subtitle',
    });
    expect(yt).toBe('youtube:dQw4w9WgXcQ:subtitle');
  });

  it('B 站 p=1 跟 YouTube 同 videoId 字串：platform 维度保证 key 不同', () => {
    const bi = buildFollowupContextKey({
      platform: 'bilibili',
      contentKey: 'dQw4w9WgXcQ',
      analysisMode: 'subtitle',
    });
    const yt = buildFollowupContextKey({
      platform: 'youtube',
      contentKey: 'dQw4w9WgXcQ',
      analysisMode: 'subtitle',
    });
    expect(bi).not.toBe(yt);
  });
});
