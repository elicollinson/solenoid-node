/**
 * Chart Generator Agent (ADK)
 *
 * Data visualization specialist for terminal-based charts (bar, stacked bar,
 * line, sparkline). Tool call data is streamed to the frontend for inline
 * rendering via ink-chart components.
 */
import { FunctionTool, LlmAgent } from '@google/adk';
import { z } from 'zod';
import { saveArtifact } from '../artifacts/index.js';
import { parseChartArgs } from '../charts/index.js';
import { getAgentConfig } from '../config/index.js';
import { saveMemoriesOnFinalResponse } from '../memory/callbacks.js';
import { TRANSFER_BACK_INSTRUCTION } from './types.js';

const DEFAULT_INSTRUCTION = `You are a Chart Generator Agent specializing in terminal-based data visualizations.

### ROLE
You create charts that render directly in the terminal using the render_chart tool. Charts appear inline in the chat interface.

### HOW TO CREATE CHARTS
You MUST use the render_chart tool to create charts.
- Call the tool with the appropriate chartType and data
- Data must be provided as JSON strings
- DO NOT output raw data as text - use the tool

### CHART TYPE SELECTION GUIDE

| Data Type | Recommended Chart |
|-----------|-------------------|
| Categories with values | chartType: "bar" with barData |
| Parts of a whole / composition | chartType: "stackedBar" with stackedData |
| Trends over time | chartType: "line" with lineSeries |
| Compact trend / inline sparkline | chartType: "sparkline" with sparklineData |

### CHART PARAMETERS

**Bar Chart (chartType: "bar")**
- barData: JSON array of objects with label, value, and optional color
- barSort: "none", "asc", or "desc"
- barShowValue: "right", "inside", or "none"
- Example barData: '[{"label":"Q1","value":100,"color":"green"},{"label":"Q2","value":150,"color":"blue"}]'

**Stacked Bar Chart (chartType: "stackedBar")**
- stackedData: JSON array of segments with label, value, and optional color
- stackedMode: "percentage" or "absolute"
- Example stackedData: '[{"label":"Product A","value":40,"color":"blue"},{"label":"Product B","value":35,"color":"green"},{"label":"Other","value":25,"color":"yellow"}]'

**Line Graph (chartType: "line")**
- lineSeries: JSON array of series, each with data array, optional label and color
- lineHeight: Height in rows (e.g., "10")
- lineXLabels: JSON array of x-axis labels
- Example lineSeries: '[{"label":"Sales","data":[10,20,15,30,25],"color":"cyan"},{"label":"Costs","data":[8,12,14,18,20],"color":"magenta"}]'

**Sparkline (chartType: "sparkline")**
- sparklineData: JSON array of numbers
- sparklineColor: "red", "blue", or "green"
- sparklineMode: "block" or "braille"
- Example sparklineData: '[5,10,3,8,15,7,12,9,14,6]'

### COMMON PARAMETERS
- title: Optional title displayed above the chart
- width: Chart width in characters (default: 60)

### AVAILABLE COLORS
Use these color names: "red", "green", "blue", "yellow", "cyan", "magenta", "white", "gray"

### EXAMPLE TOOL CALLS

**Bar Chart Example:**
\`\`\`json
{
  "chartType": "bar",
  "title": "Quarterly Sales",
  "barData": "[{\\"label\\":\\"Q1\\",\\"value\\":150,\\"color\\":\\"cyan\\"},{\\"label\\":\\"Q2\\",\\"value\\":200,\\"color\\":\\"green\\"},{\\"label\\":\\"Q3\\",\\"value\\":180,\\"color\\":\\"yellow\\"},{\\"label\\":\\"Q4\\",\\"value\\":220,\\"color\\":\\"magenta\\"}]",
  "barSort": "none",
  "barShowValue": "right"
}
\`\`\`

**Line Graph Example:**
\`\`\`json
{
  "chartType": "line",
  "title": "Monthly Revenue",
  "lineSeries": "[{\\"label\\":\\"2023\\",\\"data\\":[100,120,115,140,160,155,180],\\"color\\":\\"cyan\\"},{\\"label\\":\\"2024\\",\\"data\\":[110,130,145,165,175,190,210],\\"color\\":\\"green\\"}]",
  "lineXLabels": "[\\"Jan\\",\\"Feb\\",\\"Mar\\",\\"Apr\\",\\"May\\",\\"Jun\\",\\"Jul\\"]",
  "lineHeight": "12"
}
\`\`\`

### CONSTRAINTS
- ALWAYS use the render_chart tool to create visualizations
- Choose the most appropriate chart type for the data
- Use descriptive titles that explain what the chart shows
- Use colors to distinguish different data series or categories
- Keep labels concise but meaningful
${TRANSFER_BACK_INSTRUCTION}`;

/**
 * ADK FunctionTool for chart rendering.
 * Returns structured data that the frontend renders inline via ink-chart.
 */
export const renderChartAdkTool = new FunctionTool({
  name: 'render_chart',
  description: `Render a chart in the terminal UI. Supports bar charts, stacked bar charts, line graphs, and sparklines.

Choose the appropriate chart type:
- bar: For comparing values across categories
- stackedBar: For showing composition/distribution of a whole
- line: For showing trends over time with multiple series
- sparkline: For compact trend visualization in a single line`,
  parameters: z.object({
    chartType: z
      .enum(['bar', 'stackedBar', 'line', 'sparkline'])
      .describe('The type of chart to render'),
    title: z.string().optional().describe('Optional title to display above the chart'),
    // Bar chart parameters
    barData: z
      .string()
      .optional()
      .describe('JSON array of bar chart data points. Each item: {label, value, color?}'),
    barSort: z.enum(['none', 'asc', 'desc']).optional().describe('Sort order for bar charts'),
    barShowValue: z
      .enum(['right', 'inside', 'none'])
      .optional()
      .describe('Where to show values on bar charts'),
    // Stacked bar parameters
    stackedData: z
      .string()
      .optional()
      .describe('JSON array of stacked bar segments. Each item: {label, value, color?}'),
    stackedMode: z
      .enum(['percentage', 'absolute'])
      .optional()
      .describe('Display mode for stacked bar'),
    // Line graph parameters
    lineSeries: z
      .string()
      .optional()
      .describe('JSON array of line series. Each: {data: number[], label?, color?}'),
    lineHeight: z.string().optional().describe('Height of line graph in rows'),
    lineXLabels: z.string().optional().describe('JSON array of x-axis labels'),
    // Sparkline parameters
    sparklineData: z.string().optional().describe('JSON array of numbers for sparkline'),
    sparklineColor: z
      .enum(['red', 'blue', 'green'])
      .optional()
      .describe('Color scheme for sparkline'),
    sparklineMode: z.enum(['block', 'braille']).optional().describe('Rendering mode for sparkline'),
    // General
    width: z.string().optional().describe('Width of the chart in characters'),
  }),
  execute: async (params) => {
    const result = parseChartArgs(params as Record<string, unknown>);
    if (!result.success || !result.config) {
      return { status: 'error', error: result.error ?? 'Invalid chart arguments' };
    }
    const { config } = result;

    const artifactId = saveArtifact({
      type: 'chart',
      title: config.title,
      data: params,
      agentName: 'chart_generator_agent',
    });

    return {
      status: 'success',
      chartType: config.chartType,
      title: config.title,
      artifactId,
      chartConfig: config,
    };
  },
});

const { modelName, customPrompt } = getAgentConfig('chart_generator_agent');

/**
 * Chart Generator LlmAgent - ink-chart visualization specialist
 */
export const chartGeneratorAgent = new LlmAgent({
  name: 'chart_generator_agent',
  model: modelName,
  description: 'Data visualization specialist that creates terminal charts using ink-chart.',
  instruction: customPrompt ?? DEFAULT_INSTRUCTION,
  tools: [renderChartAdkTool],
  afterModelCallback: saveMemoriesOnFinalResponse,
});

/** Factory function for backwards compatibility */
export function createChartGeneratorAgent(): LlmAgent {
  return chartGeneratorAgent;
}

/** Legacy tool executors for backwards compatibility */
export const chartGeneratorToolExecutors: Record<
  string,
  (args: Record<string, unknown>) => Promise<string>
> = {
  render_chart: async (args) => {
    const result = parseChartArgs(args);
    if (!result.success || !result.config) {
      return `Error: ${result.error ?? 'Invalid chart arguments'}`;
    }
    const { config } = result;
    return `Chart rendered successfully: ${config.chartType} chart${config.title ? ` - "${config.title}"` : ''}`;
  },
};
