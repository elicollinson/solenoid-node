/**
 * Subagents: the parent hands out self-contained tasks, ends its turn
 * instead of waiting, and answers once their results have come back.
 */
import { defineCase } from '../case.js';
import { answered, callCount } from '../checks.js';
import { warehouse } from '../worlds/warehouse.js';

export default [
  defineCase({
    id: 'subagents/delegates-and-reports',
    world: warehouse,
    profile: (world) => ({ tools: world.tools, canSpawn: true }),
    turns: [
      'Use two subagents: one to look up how many widgets are in stock, one for gears. Then tell me both numbers.',
    ],
    checks: [callCount('spawn_subagent', { min: 2, max: 2 }), answered(/130/), answered(/45/)],
  }),
];
