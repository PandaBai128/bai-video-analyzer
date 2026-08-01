/**
 * 提问 tab 可见性 / 挂载策略。
 *
 * 用户没进入过提问时不挂载，避免无条件开 Port；进入过后只隐藏不卸载，
 * 以保留当前会话状态。新视频 / 新 contentKey 由父组件 key 触发重挂。
 */

export interface FollowupTabVisibilityInput {
  /** 用户是否点过"提问" tab。 */
  readonly hasVisitedFollowup: boolean;
  /** 当前 active tab。 */
  readonly analysisTab: 'analysis' | 'navigation' | 'followup' | 'notes';
}

export interface FollowupTabVisibility {
  /** true → 父组件应当挂载 <FollowupTab />。 */
  readonly shouldRender: boolean;
  /** true → 父组件应当把节点隐藏（用 hidden class）但不卸载。 */
  readonly shouldHide: boolean;
}

export function pickFollowupTabVisibility(
  input: FollowupTabVisibilityInput,
): FollowupTabVisibility {
  const shouldRender = input.hasVisitedFollowup;
  const shouldHide = !shouldRender || input.analysisTab !== 'followup';
  return { shouldRender, shouldHide };
}

/** 把内容身份和分析模式折成 React key；key 变化会重置提问会话。 */
export function buildFollowupContextKey(input: {
  readonly platform: string | null;
  readonly contentKey: string | null;
  readonly analysisMode: string;
}): string {
  return `${input.platform ?? 'none'}:${input.contentKey ?? 'none'}:${input.analysisMode}`;
}
