/**
 * Production build: dist/cli.js, the `solenoid` the package installs, with
 * React Compiler applied to the UI the same way bun run and bun test apply
 * it. Installed copies run this bundle rather than src/, where the compiler
 * would only be preloaded inside this repository (bunfig.toml).
 */
import { reactCompiler } from './react-compiler.js';

const result = await Bun.build({
  entrypoints: ['src/cli.ts'],
  outdir: 'dist',
  // The CLI's shebang runs it with Bun.
  target: 'bun',
  plugins: [reactCompiler],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
