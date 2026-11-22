/**
 * The turn limit: on its last turn the model is offered no tools and told to
 * answer with what it has. A model that calls a tool anyway, or says nothing,
 * fails the run.
 */
import { defineCase } from '../case.js';
import { answered } from '../checks.js';
import { SHIPMENT_PAGES, warehouse } from '../worlds/warehouse.js';

export default [
  defineCase({
    id: 'turn-budget/answers-on-the-last-turn',
    world: warehouse,
    // Fewer turns than pages. A model that asks for every page at once
    // finishes inside the budget, which is also a pass.
    settings: { agent: { max_turns: 4 } },
    turns: [`List the id of every recent shipment. There are ${SHIPMENT_PAGES} pages.`],
    checks: [answered(/S-101/)],
  }),
];
