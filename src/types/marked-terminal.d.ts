declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  interface TerminalRendererOptions {
    reflowText?: boolean;
    width?: number;
    showSectionPrefix?: boolean;
    unescape?: boolean;
    emoji?: boolean;
    tab?: number;
    tableOptions?: Record<string, unknown>;
  }

  export function markedTerminal(
    options?: TerminalRendererOptions,
    highlightOptions?: Record<string, unknown>
  ): MarkedExtension;
}
