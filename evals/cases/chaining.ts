/**
 * Chaining: a result the model has to carry into its next call, or work on
 * before it answers.
 */
import { defineCase } from '../case.js';
import { answered, called, state } from '../checks.js';
import { type TicketsState, closedOnly, tickets } from '../worlds/tickets.js';
import { warehouse } from '../worlds/warehouse.js';

export default [
  defineCase({
    id: 'chaining/search-then-act',
    world: tickets,
    turns: ["Close Acme's open ticket. The resolution is: duplicate."],
    checks: [
      state<TicketsState>(
        'T-17 closed as a duplicate',
        ({ tickets }) =>
          tickets['T-17']!.status === 'closed' && /duplicate/i.test(tickets['T-17']!.resolution!)
      ),
      state<TicketsState>('no other ticket closed', (s) => closedOnly(s, 'T-17')),
    ],
  }),
  defineCase({
    id: 'chaining/derived-answer',
    world: warehouse,
    // 130 × 9 + 45 × 12.5
    turns: ['What is the combined value, in euros, of the widgets and gears in stock?'],
    checks: [called('get_stock'), called('get_price'), answered(/1[,. ]?732[.,]50?/)],
  }),
];
