/**
 * Chart Tool
 *
 * render_chart draws a terminal chart inline in the chat. The UI renders the
 * chart from the call's arguments (see ui/components/ChartRenderer.tsx); the
 * tool only validates them and tells the model what was drawn. Nothing is
 * stored, so there is nothing for the model to embed a second time.
 *
 * Its output is `agent` origin and is not screened: the chart type and title
 * are the model's own arguments.
 *
 * Data arrays are JSON strings rather than nested arrays, the shape every
 * backend's tool calling handled reliably.
 */
import { z } from 'zod';
import { parseChartArgs } from '../charts/index.js';
import { defineTool } from '../core/index.js';

export const renderChartTool = defineTool({
  name: 'render_chart',
  description: `Render a chart inline in the terminal chat. Use it whenever numbers are easier to read as a picture; never draw ASCII charts by hand.

Chart types:
- bar: compare values across categories. barData: '[{"label":"Q1","value":100,"color":"green"}]'
- stackedBar: composition of a whole. stackedData: '[{"label":"A","value":40,"color":"blue"}]'
- line: trends over time, one or more series. lineSeries: '[{"label":"Sales","data":[10,20,15],"color":"cyan"}]', lineXLabels: '["Jan","Feb","Mar"]'
- sparkline: a compact one-line trend. sparklineData: '[5,10,3,8]'

Colors: red, green, blue, yellow, cyan, magenta, white, gray.`,
  kind: 'read',
  outputOrigin: 'agent',
  schema: z.object({
    chartType: z
      .enum(['bar', 'stackedBar', 'line', 'sparkline'])
      .describe('The type of chart to render'),
    title: z.string().optional().describe('Optional title to display above the chart'),
    barData: z
      .string()
      .optional()
      .describe('JSON array of bar chart data points. Each item: {label, value, color?}'),
    barSort: z.enum(['none', 'asc', 'desc']).optional().describe('Sort order for bar charts'),
    barShowValue: z
      .enum(['right', 'inside', 'none'])
      .optional()
      .describe('Where to show values on bar charts'),
    stackedData: z
      .string()
      .optional()
      .describe('JSON array of stacked bar segments. Each item: {label, value, color?}'),
    stackedMode: z
      .enum(['percentage', 'absolute'])
      .optional()
      .describe('Display mode for stacked bar'),
    lineSeries: z
      .string()
      .optional()
      .describe('JSON array of line series. Each: {data: number[], label?, color?}'),
    lineHeight: z.string().optional().describe('Height of line graph in rows, e.g. "10"'),
    lineXLabels: z.string().optional().describe('JSON array of x-axis labels'),
    sparklineData: z.string().optional().describe('JSON array of numbers for sparkline'),
    sparklineColor: z
      .enum(['red', 'blue', 'green'])
      .optional()
      .describe('Color scheme for sparkline'),
    sparklineMode: z.enum(['block', 'braille']).optional().describe('Rendering mode for sparkline'),
    width: z.string().optional().describe('Width of the chart in characters, e.g. "60"'),
  }),
  execute: (args) => {
    const result = parseChartArgs(args);
    if (!result.success || !result.config) {
      throw new Error(result.error ?? 'Invalid chart arguments');
    }
    return { status: 'success', chartType: result.config.chartType, title: result.config.title };
  },
});
