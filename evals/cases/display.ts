/**
 * Display tools: a chart is drawn once, and the reply ends without the model
 * redrawing what it cannot see.
 */
import { defineCase } from '../case.js';
import { called, charts } from '../checks.js';
import { warehouse } from '../worlds/warehouse.js';

export default [
  defineCase({
    id: 'display/draws-a-chart-once',
    world: warehouse,
    turns: ['Show me a bar chart of how many widgets, gears and bolts are in stock.'],
    checks: [
      called('render_chart', { chartType: 'bar' }),
      {
        // A refused attempt drew nothing, so only charts that were shown count.
        name: 'drew one chart',
        pass: (t) => t.toolCalls.filter((c) => c.name === 'render_chart' && c.ok).length === 1,
      },
      {
        name: 'the chart shows 130, 45 and 900',
        pass: (t) => [130, 45, 900].every((n) => new RegExp(`\\b${n}\\b`).test(charts(t))),
      },
    ],
  }),
];
