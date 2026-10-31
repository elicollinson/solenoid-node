/**
 * Structured Output
 *
 * Recovering and validating the JSON a structured run ends with.
 */
import { z } from 'zod';

/**
 * Lenient JSON recovery for backends that don't enforce the schema: peel off
 * code fences or surrounding prose. Validation still happens through zod.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function validateStructured(
  raw: string,
  schema: z.ZodType
): { ok: true; data: unknown } | { ok: false; error: string } {
  const json = extractJson(raw);
  if (!json) return { ok: false, error: 'the response was empty' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `invalid JSON (${error instanceof Error ? error.message : error})` };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}
