/**
 * React Compiler for Bun
 *
 * Bun does not run Babel, so the compiler runs here as a Bun plugin over the
 * UI's TSX. Babel only parses and rewrites: TypeScript stays in the output
 * and Bun strips it as usual. Registered for `bun run` and `bun test` by
 * ./preload.ts (bunfig.toml), and for builds by ./build.ts.
 */
import { transformAsync } from '@babel/core';
import type { BunPlugin } from 'bun';

export const reactCompiler: BunPlugin = {
  name: 'react-compiler',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]ui[\\/].*\.tsx$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ['typescript', 'jsx'] },
        plugins: [['babel-plugin-react-compiler', { target: '19' }]],
        sourceMaps: 'inline',
      });
      return { contents: result?.code ?? source, loader: 'tsx' };
    });
  },
};
