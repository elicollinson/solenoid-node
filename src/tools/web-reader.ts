/**
 * Web Reader Tool
 *
 * Fetches and extracts text content from web pages. Strips HTML tags,
 * decodes entities, and cleans whitespace. Truncates content to 10,000
 * characters to stay within LLM context limits. Failures throw, so the agent
 * reports them as failed tool calls.
 */
import { fetchWithTimeout } from '../utils/fetch.js';

const MAX_CONTENT_LENGTH = 10000;

export async function readWebpage(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Solenoid/2.0; +https://github.com/solenoid)',
      },
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'AbortError';
    const message = timedOut ? 'request timed out' : error instanceof Error ? error.message : error;
    throw new Error(`Could not read ${url}: ${message}`);
  }
  if (!response.ok) {
    throw new Error(`Could not read ${url}: HTTP ${response.status}`);
  }

  const text = extractTextFromHtml(await response.text());
  if (text.length > MAX_CONTENT_LENGTH) {
    return `${text.substring(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated...]`;
  }
  return text;
}

function extractTextFromHtml(html: string): string {
  // Remove script and style tags with their content
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');

  // Clean up whitespace
  text = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  // Collapse multiple spaces
  text = text.replace(/ {2,}/g, ' ');

  return text.trim();
}
