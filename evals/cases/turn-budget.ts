/**
 * The turn limit: on its last turn the model is offered no tools and told to
 * answer with what it has. A model that calls a tool anyway, says nothing, or
 * fills in what it never read, fails the run.
 */
import { z } from 'zod';
import { defineTool } from '../../src/index.js';
import { defineCase } from '../case.js';
import { answered } from '../checks.js';

/** Each page is reached by the cursor the page before it gave. */
const CURSORS = ['c-7f3a', 'c-b21e', 'c-04d9', 'c-e6c5', 'c-39aa', 'c-d870', 'c-5b1f'];
/**
 * Ids with no pattern to them, like the cursors: a model that names one it
 * never read made it up, and cannot be merely pointing at "S-104 onwards".
 */
const IDS = ['S-417', 'S-962', 'S-285', 'S-730', 'S-159', 'S-846', 'S-503', 'S-671'];
const PAGES = IDS.length;

/** Shipments one a page, so listing them takes a call each and cannot be asked for at once. */
function shipments() {
  return {
    state: {},
    tools: [
      defineTool({
        name: 'list_shipments',
        description: 'Recent shipments, one per call, each with the cursor for the next.',
        kind: 'read',
        schema: z.object({
          cursor: z
            .string()
            .optional()
            .describe('The cursor the last call returned; none for the first'),
        }),
        execute: ({ cursor }) => {
          const page = cursor ? CURSORS.indexOf(cursor.trim()) + 1 : 0;
          if (cursor && page === 0) throw new Error(`unknown cursor "${cursor}"`);
          return {
            shipment: { id: IDS[page], units: (page + 1) * 10 },
            ...(page < CURSORS.length ? { next: CURSORS[page] } : {}),
          };
        },
      }),
    ],
  };
}

export default [
  defineCase({
    id: 'turn-budget/answers-on-the-last-turn',
    world: shipments,
    // Fewer turns than shipments, and no way to ask for several at once.
    settings: { agent: { max_turns: 4 } },
    turns: [`List the id of every recent shipment. There are ${PAGES}, one per call.`],
    checks: [
      answered(/S-417/),
      {
        name: 'names only shipments it read',
        pass: (t) => {
          const read = t.toolCalls
            .filter((made) => made.ok)
            .map((made) => made.output)
            .join(' ');
          return ((t.answers.at(-1) ?? '').match(/S-\d{3}/g) ?? []).every((id) =>
            read.includes(id)
          );
        },
      },
    ],
  }),
];
