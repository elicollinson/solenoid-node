/**
 * Markdown Component
 *
 * Renders a completed message's markdown for the terminal with
 * marked-terminal.
 */
import { Text } from 'ink';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked with terminal renderer.
// Patch: marked-terminal v7.3.0's text renderer returns raw text instead of
// parsing inline tokens, so bold/italic inside list items shows as raw markdown.
const ext = markedTerminal({
  reflowText: true,
  width: process.stdout.columns || 80,
});
const origText = ext.renderer!.text!;
// biome-ignore lint/suspicious/noExplicitAny: marked-terminal v7 types don't expose renderer internals
ext.renderer!.text = function (this: any, token: any) {
  if (token?.tokens) return this.parser.parseInline(token.tokens);
  return origText.call(this, token);
};
marked.use(ext);

function renderMarkdown(content: string): string {
  try {
    const rendered = marked.parse(content);
    // marked.parse can return string or Promise<string>, we only use sync
    if (typeof rendered === 'string') {
      return rendered.trim();
    }
    return content;
  } catch {
    return content;
  }
}

export function Markdown({ children }: { children: string }) {
  const rendered = renderMarkdown(children);
  return <Text>{rendered}</Text>;
}
