/**
 * Recovery: a failed call is read and answered with a different one, and a
 * tool that stays down is given up on and reported.
 */
import { defineCase } from '../case.js';
import { answered, callCount, called, noRepeatedFailedCall } from '../checks.js';
import { tickets } from '../worlds/tickets.js';
import { warehouse } from '../worlds/warehouse.js';

export default [
  defineCase({
    id: 'recovery/corrects-a-refused-argument',
    world: tickets,
    // "17" is refused with the id format; a model that sends T-17 first passes untested.
    turns: ['What is the priority of ticket 17?'],
    checks: [called('get_ticket', { id: 'T-17' }), noRepeatedFailedCall(), answered(/urgent/i)],
  }),
  defineCase({
    id: 'recovery/gives-up-on-a-dead-tool',
    world: warehouse,
    turns: ['What is the status of order 5512?'],
    checks: [
      callCount('lookup_order', { min: 1, max: 2 }),
      answered(
        /unavailable|unable|not able|could ?n[o’']t|cannot|can[’']t|failed|error|down/i,
        'says the lookup did not work'
      ),
    ],
  }),
];
