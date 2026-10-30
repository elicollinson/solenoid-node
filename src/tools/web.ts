/**
 * Web Tools
 *
 * universal_search (Brave Search) and read_webpage, as agent tools. Both
 * return text written by strangers, so both keep the default `external`
 * output origin and pass the injection screen at the tool_output boundary.
 */
import { z } from 'zod';
import { defineTool } from '../core/index.js';
import { braveSearch } from './brave-search.js';
import { readWebpage } from './web-reader.js';

const WEB_SEARCH_DESCRIPTION =
  'Search the web with Brave Search. Returns titles, links and snippets. Follow up with read_webpage for detail.';

/** Built per harness because it holds the Brave key; offered only when there is one. */
export function createWebSearchTool(apiKey: string) {
  return defineTool({
    name: 'universal_search',
    description: WEB_SEARCH_DESCRIPTION,
    kind: 'read',
    schema: z.object({
      query: z.string().describe('The search query string'),
    }),
    execute: ({ query }) => braveSearch(query, apiKey),
  });
}

export const readWebpageTool = defineTool({
  name: 'read_webpage',
  description:
    'Read a web page and return its text (truncated to 10,000 characters). Use it to get detail from a specific URL.',
  kind: 'read',
  schema: z.object({
    url: z.string().describe('The URL of the web page to read'),
  }),
  execute: ({ url }) => readWebpage(url),
});
