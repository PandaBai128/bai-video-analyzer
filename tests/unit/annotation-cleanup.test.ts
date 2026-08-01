import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "边看边记" 学习打点旧能力已彻底清理。
 *
 * 业务契约（不变量）—— **不锁实现位置 / 私有 helper 名 / Tailwind class**，
 * 只锁"业务上是否还在生产 API 路径上"：
 *
 * 1. Dexie v7 显式声明 `annotations: null`，确保旧表真正删除（不是省略）。
 *    Dexie 的 `stores()` 声明的是"当前应有的表"；省略旧表 ≠ 删除旧表，必须
 *    显式 `null`。
 * 2. annotation 旧链路（采集 / 持久化 / 消息 handler / Markdown 导出 / export-to-vault
 *    入参 / `@core/storage/annotations.ts` 模块）不得重新进入生产 API。
 *
 * **保留** 的兼容结构（不属于"删除"范围）：
 * - `types.ts` 的 `UserAnnotation` 接口 / `Note.annotations` 字段 / `VideoContextPackage.annotations`
 *   / 追问上下文 `annotations` 等——这些是**长期兼容字段**，长期保留但生产 handler
 *   当前传空数组。保留原因：旧缓存数据反序列化兼容 + 后续若产品重新引入可基于此
 *   扩展。生产追问链路不再读 annotations；新版学习轨迹由 learning-review handler 独立管理。
 *   测试保护。
 */

const MESSAGES = resolve(__dirname, '../../src/shared/messages.ts');
const SERVICE_WORKER = resolve(__dirname, '../../src/extension/background/service-worker.ts');
const MARKDOWN_EXPORTER = resolve(__dirname, '../../src/core/export/markdown-exporter.ts');
const EXPORT_TO_VAULT = resolve(__dirname, '../../src/core/export/export-to-vault.ts');
const DB = resolve(__dirname, '../../src/core/storage/db.ts');
const ANNOTATIONS_MODULE = resolve(__dirname, '../../src/core/storage/annotations.ts');

describe('Dexie v7 迁移: annotations 表彻底删除', () => {
  it('v7 stores 显式声明 annotations: null（省略 ≠ 删除）', () => {
    const src = readFileSync(DB, 'utf-8');
    // Dexie stores() 声明的是"当前应有的表"；省略旧表 ≠ 删除旧表，
    // 必须显式 `<表名>: null` 才能真正删除。
    expect(src).toMatch(/this\.version\(7\)\.stores\(\{[\s\S]*?annotations:\s*null/);
  });
});

describe('annotation 旧链路不重新进入生产 API', () => {
  it('messages.ts 不再声明 annotation 消息类型（4 种）', () => {
    const src = readFileSync(MESSAGES, 'utf-8');
    expect(src).not.toMatch(/type:\s*['"]ADD_ANNOTATION['"]/);
    expect(src).not.toMatch(/type:\s*['"]LIST_ANNOTATIONS['"]/);
    expect(src).not.toMatch(/type:\s*['"]ANNOTATION_ADDED['"]/);
    expect(src).not.toMatch(/type:\s*['"]ANNOTATIONS_LIST['"]/);
  });

  it('service-worker.ts 不再有 ADD_ANNOTATION / LIST_ANNOTATIONS handler case', () => {
    const src = readFileSync(SERVICE_WORKER, 'utf-8');
    expect(src).not.toMatch(/case\s*['"]ADD_ANNOTATION['"]/);
    expect(src).not.toMatch(/case\s*['"]LIST_ANNOTATIONS['"]/);
  });

  it('markdown-exporter.ts 不再渲染"我的标注"段 + 不再有 formatAnnotations', () => {
    const src = readFileSync(MARKDOWN_EXPORTER, 'utf-8');
    expect(src).not.toContain('我的标注');
    expect(src).not.toMatch(/function\s+formatAnnotations/);
  });

  it('markdown-exporter.ts createVideoMarkdownExport 入参不再含 annotations 字段', () => {
    const src = readFileSync(MARKDOWN_EXPORTER, 'utf-8');
    const inputDef = src.match(
      /export function createVideoMarkdownExport\(input:\s*\{[\s\S]*?\}\)/,
    );
    expect(inputDef).not.toBeNull();
    expect(inputDef?.[0]).not.toMatch(/\bannotations\b/);
  });

  it('export-to-vault.ts exportVideoToVault 入参不再含 annotations 字段', () => {
    const src = readFileSync(EXPORT_TO_VAULT, 'utf-8');
    const inputDef = src.match(
      /export async function exportVideoToVault\(input:\s*\{[\s\S]*?\}\)/,
    );
    expect(inputDef).not.toBeNull();
    expect(inputDef?.[0]).not.toMatch(/\bannotations\b/);
  });

  it('@core/storage/annotations.ts 模块文件不存在（彻底删除）', () => {
    // 文件已删，readFileSync 必须抛错
    expect(() => readFileSync(ANNOTATIONS_MODULE, 'utf-8')).toThrow();
  });
});
