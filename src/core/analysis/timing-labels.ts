/**
 * Round 25 必修 A：耗时明细阶段名去 provider 写死化。
 *
 * 旧版用户可见 timing label 写死为 `MiniMax 字幕分析（${model}）` /
 * `MiniMax 视频 URL 分析（M3）` —— 后续接入其他模型时这个命名会**不**合适
 * （handoff §1 用户原话："MiniMax 字幕分析是写死的吗，我以后接入其他模型
 * 是不是就不合适了"）。
 *
 * 新版统一为 `模型分析 · {model}`：
 * - helper 集中生成，**不**在业务流程里手写
 * - 模型名为空时 fallback 到 `模型分析`
 * - 模型名仍显示（handoff §7 "不要把 UI 里的 `MiniMax-M3` 模型名隐藏掉，
 *   用户仍需要知道本次用的模型"）—— 只**不**显示 provider 品牌
 *
 * 不变量：
 * - helper 放在 `src/core/analysis/` 与 `analyze-video.ts` 同一目录
 *   （业务流程用 helper 不再手写）
 * - extension / background 业务**不**自己拼 label，import 此 helper
 * - 现有 `AnalysisTiming` 类型**不**改（label 还是 string）
 * - 阶段名 `'读取字幕'` / `'解析分析结果'` / `'解析 JSONL 事件'` / `'总耗时'`
 *   **不**动（handoff §4 "不写 provider 绑定"的范围**只**是"模型分析"阶段）
 */

/**
 * 生成"模型分析"阶段的 timing label。
 *
 * 旧版（写死）→ 新版（通用）：
 *   `MiniMax 字幕分析（MiniMax-M3）` → `模型分析 · MiniMax-M3`
 *   `MiniMax 视频 URL 分析（M3）`   → `模型分析 · MiniMax-M3`
 *
 * 模型名为空 / 仅空白时 fallback 到 `模型分析`（**不**显示尾部的 `· `）。
 */
export function createModelAnalysisTimingLabel(model: string | null | undefined): string {
  const trimmed = (model ?? '').trim();
  if (trimmed.length === 0) return '模型分析';
  return `模型分析 · ${trimmed}`;
}
