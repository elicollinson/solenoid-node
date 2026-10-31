/**
 * Brave Search Tool
 *
 * Web search integration using the Brave Search API. Returns titles, URLs,
 * and snippets for search queries. The caller supplies the key (see
 * getSearchApiKey in ../config/settings.ts). Failures throw, so the agent
 * reports them as failed tool calls.
 */
import { fetchWithTimeout } from '../utils/fetch.js';

const SEARCH_TIMEOUT_MS = 15_000;

export async function braveSearch(query: string, apiKey: string): Promise<string> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '10');

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      },
      SEARCH_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error(`Search API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = data.web?.results ?? [];

    if (results.length === 0) {
      return 'No results found.';
    }

    const summary = results.map((result, i) => {
      const title = result.title ?? 'No Title';
      const link = result.url ?? '';
      const description = result.description ?? '';

      return `${i + 1}. ${title}\n   Link: ${link}\n   Snippet: ${description}`;
    });

    return summary.join('\n\n');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Search timed out');
    }
    throw error;
  }
}
