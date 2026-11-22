/**
 * Structured output: the result arrives through submit_result and matches
 * the schema, with and without tools on the way.
 */
import { z } from 'zod';
import { defineCase } from '../case.js';
import { called, output } from '../checks.js';
import { tickets } from '../worlds/tickets.js';

const TicketRecord = z.object({
  id: z.string(),
  customer: z.string(),
  priority: z.enum(['low', 'normal', 'urgent']),
  open: z.boolean(),
});

const Order = z.object({
  customer: z.string(),
  shipBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(z.object({ item: z.string(), quantity: z.number().int(), unitPrice: z.number() })),
  total: z.number(),
});

export default [
  defineCase({
    id: 'structured/from-a-tool-result',
    world: tickets,
    schema: TicketRecord,
    turns: ['Fill in the record for ticket T-18.'],
    checks: [
      called('get_ticket', { id: 'T-18' }),
      output<z.infer<typeof TicketRecord>>(
        'the record is T-18 as stored',
        (o) => o.id === 'T-18' && /globex/i.test(o.customer) && o.priority === 'normal' && o.open
      ),
    ],
  }),
  defineCase({
    id: 'structured/nested-from-text',
    world: () => ({ state: {}, tools: [] }),
    schema: Order,
    turns: [
      'Record this order: 3 widgets at 9.00 each and 2 gears at 12.50 each, for Dana Reyes, to ship by 1 December 2026.',
    ],
    checks: [
      output<z.infer<typeof Order>>(
        'two lines, the right total and date',
        (o) => o.lines.length === 2 && o.total === 52 && o.shipBy === '2026-12-01'
      ),
    ],
  }),
];
