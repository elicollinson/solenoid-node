/**
 * Text
 *
 * Shortening text that is handed back to a model or written to a log.
 */

/** `text` cut to `max` characters, with an ellipsis when it was cut. */
export function truncate(text: string, max: number, { showLength = false } = {}): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…${showLength ? ` [${text.length} chars]` : ''}`;
}
