/**
 * Tool groups: the model opens the group its task needs, on the strength of
 * a one-line summary, and leaves the other closed.
 */
import { defineToolGroup } from '../../src/index.js';
import { defineCase } from '../case.js';
import { answered, called } from '../checks.js';
import { tickets } from '../worlds/tickets.js';
import { warehouse } from '../worlds/warehouse.js';

/** Both worlds, each behind a group. */
function grouped() {
  const support = tickets();
  const stock = warehouse();
  return {
    state: support.state,
    tools: [...support.tools, ...stock.tools],
    groups: [
      defineToolGroup({
        name: 'support',
        summary: 'Customer support tickets: find, read, annotate and close them.',
        briefing: 'Tickets are found by search and read by id. Close one only when asked to.',
        tools: support.tools,
      }),
      defineToolGroup({
        name: 'warehouse',
        summary: 'Stock levels, prices and shipments.',
        briefing: 'Stock and prices are looked up by item name.',
        tools: stock.tools,
      }),
    ],
  };
}

export default [
  defineCase({
    id: 'tool-groups/opens-the-group-it-needs',
    world: grouped,
    profile: (world) => ({ toolGroups: world.groups }),
    turns: ['How many gears are in stock?'],
    checks: [
      called('open_tool_group', { group: 'warehouse' }),
      {
        name: 'left the support group closed',
        pass: (t) =>
          !t.toolCalls.some(
            (call) => call.name === 'open_tool_group' && call.args.group === 'support'
          ),
      },
      answered(/\b45\b/),
    ],
  }),
];
