/**
 * React Compiler for Bun
 *
 * Bun does not run Babel, so the compiler runs here as a Bun plugin over the
 * UI's sources. Babel only parses and rewrites: TypeScript stays in the output
 * and Bun strips it as usual. Registered for `bun run` and `bun test` by
 * ./preload.ts (bunfig.toml), and for builds by ./build.ts.
 */
import { resolve } from 'node:path';
import { transformAsync } from '@babel/core';
import type { BunPlugin } from 'bun';

const UI_DIR = resolve(import.meta.dir, '../src/ui');
const escape = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** This repository's UI sources: components and hooks. */
const UI_SOURCE = new RegExp(`^${escape(UI_DIR)}/.*\\.tsx?$`);
/** The test harness, whose components the compiler cannot reach: not worth the time. */
const SKIPPED = `${UI_DIR}/testing/`;

export const reactCompiler: BunPlugin = {
  name: 'react-compiler',
  setup(build) {
    build.onLoad({ filter: UI_SOURCE }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const loader = path.endsWith('.tsx') ? 'tsx' : 'ts';
      if (path.startsWith(SKIPPED)) return { contents: source, loader };
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: loader === 'tsx' ? ['typescript', 'jsx'] : ['typescript'] },
        plugins: [['babel-plugin-react-compiler', { target: '19' }]],
        sourceMaps: 'inline',
      });
      return { contents: result?.code ?? source, loader };
    });
  },
};
