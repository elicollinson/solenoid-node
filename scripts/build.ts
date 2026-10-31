/**
 * Production build: the CLI bundle for Node, with React Compiler applied to
 * the UI the same way bun run and bun test apply it.
 */
import { reactCompiler } from './react-compiler.js';

const result = await Bun.build({
  entrypoints: ['src/cli.ts'],
  outdir: 'dist',
  target: 'node',
  plugins: [reactCompiler],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
