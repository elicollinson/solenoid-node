/**
 * Tool calling: the right tool, with arguments its schema accepts, and none
 * at all when the model already knows.
 */
import { defineCase } from '../case.js';
import { answered, called, calledTogether, onlyChanged } from '../checks.js';
import { tickets } from '../worlds/tickets.js';
import { warehouse } from '../worlds/warehouse.js';

export default [
  defineCase({
    id: 'tool-calling/single-read',
    world: tickets,
    turns: ['What is the priority of ticket T-18?'],
    checks: [called('get_ticket', { id: 'T-18' }), answered(/\bnormal\b/i), onlyChanged(tickets)],
  }),
  defineCase({
    id: 'tool-calling/typed-arguments',
    world: tickets,
    turns: ['List at most two open tickets.'],
    // The search returns T-17 and T-18.
    checks: [
      called('search_tickets', { status: 'open', limit: 2 }),
      answered(/T-17/),
      answered(/T-18/),
      onlyChanged(tickets),
    ],
  }),
  defineCase({
    id: 'tool-calling/parallel-reads',
    world: warehouse,
    turns: ['How many widgets, gears and bolts are in stock?'],
    checks: [
      calledTogether('get_stock', 3),
      answered(/\b130\b/),
      answered(/\b45\b/),
      answered(/\b900\b/),
    ],
  }),
  defineCase({
    id: 'tool-calling/no-tool-for-a-known-fact',
    world: tickets,
    turns: ['What is 17 + 25? Reply with just the number.'],
    checks: [
      { name: 'made no tool call', pass: (t) => t.toolCalls.length === 0 },
      answered(/\b42\b/),
    ],
  }),
];
