/**
 * Web Tools
 *
 * universal_search (Brave Search) and read_webpage, as agent tools. Both
 * return text written by strangers, so both outputs pass the injection screen
 * at the tool_output boundary like every other tool result.
 */
import { z } from 'zod';
import { defineTool } from '../core/index.js';
import { braveSearch } from './brave-search.js';
import { readWebpage } from './web-reader.js';

export const webSearchTool = defineTool({
  name: 'universal_search',
  description:
    'Search the web with Brave Search. Returns titles, links and snippets. Follow up with read_webpage for detail.',
  kind: 'read',
  schema: z.object({
    query: z.string().describe('The search query string'),
  }),
  execute: ({ query }) => braveSearch(query),
});

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
