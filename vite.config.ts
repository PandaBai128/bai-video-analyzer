/// <reference types="vitest" />

import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { build as esbuildBuild } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * 把 content entry 单独用 esbuild 编一次，覆盖 vite 默认输出的 ESM。
 *
 * 背景：Chrome MV3 的 `manifest.content_scripts.js` 字段加载的是 classic
 * script，**不支持** `type="module"`。Vite/CRXJS 默认把 content script 输出成
 * ESM（顶部 `import {...} from "./assets/..."`），浏览器加载直接抛
 * `Uncaught SyntaxError: Cannot use import statement outside a module`——
 * 整个 content script 死掉，所有 listener 都没注册。
 *
 * 修法：在 `closeBundle` 钩子里用 esbuild 单独把 content entry 编成 IIFE
 * 覆盖回 dist/content.js。副作用是单文件 IIFE 体积会膨胀（5 KB → 12-25 KB），
 * 因为所有依赖 inline 进闭包。
 *
 * 注意：vite config 的 `output.format` 不能 per-entry，只能在 plugin 钩子里
 * 用 esbuild 单独覆盖（这就是为什么这个 plugin 是必要的）。
 */
function rebuildContentAsIife(): Plugin {
  return {
    name: 'rebuild-content-as-iife',
    apply: 'build',
    async closeBundle() {
      await esbuildBuild({
        entryPoints: ['src/extension/content/index.ts'],
        bundle: true,
        format: 'iife',
        target: 'chrome114',
        outfile: 'dist/content.js',
        tsconfig: 'tsconfig.json', // 自动读 paths alias
        allowOverwrite: true,
      });
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
      '@core': path.resolve(rootDir, './src/core'),
      '@extension': path.resolve(rootDir, './src/extension'),
      '@components': path.resolve(rootDir, './src/components'),
      '@lib': path.resolve(rootDir, './src/lib'),
      '@shared': path.resolve(rootDir, './src/shared'),
    },
  },

  plugins: [react(), crx({ manifest }), rebuildContentAsIife()],

  build: {
    rollupOptions: {
      input: {
        sidepanel: 'src/extension/sidepanel/index.html',
        popup: 'src/extension/popup/index.html',
        options: 'src/extension/options/index.html',
        background: 'src/extension/background/service-worker.ts',
        content: 'src/extension/content/index.ts',
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'content') return 'content.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // content script IIFE 重编时会把所有依赖 inline 进闭包，单文件体积膨胀，
    // 测试侧如果 fetcher 改用 XHR 需要在 tests/setup.ts 桥到 globalThis.fetch
    // （XHR 比直接 fetch 慢），这里给个宽容的超时。
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.config.ts',
      ],
    },
  },
});
