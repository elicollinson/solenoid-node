/**
 * Chart Component
 *
 * The content of a `solenoid.chart` display: one of four chart types, as a
 * zod schema every surface validates against before drawing. render_chart
 * (../tools/chart.ts) builds it from the model's arguments with
 * parseChartArgs, whose data arrays arrive as JSON strings.
 */
import { z } from 'zod';

const ColorSchema = z.string().optional();

const BarChartSchema = z.object({
  chartType: z.literal('bar'),
  title: z.string().optional(),
  data: z.array(z.object({ label: z.string(), value: z.number(), color: ColorSchema })).min(1),
  sort: z.enum(['none', 'asc', 'desc']).optional(),
  showValue: z.enum(['right', 'inside', 'none']).optional(),
  width: z.number().int().positive().optional(),
});

const StackedBarChartSchema = z.object({
  chartType: z.literal('stackedBar'),
  title: z.string().optional(),
  data: z.array(z.object({ label: z.string(), value: z.number(), color: ColorSchema })).min(1),
  mode: z.enum(['percentage', 'absolute']).optional(),
  showLabels: z.boolean().optional(),
  showValues: z.boolean().optional(),
  width: z.number().int().positive().optional(),
});

const LineGraphSchema = z.object({
  chartType: z.literal('line'),
  title: z.string().optional(),
  series: z
    .array(
      z.object({
        label: z.string().optional(),
        data: z.array(z.number()).min(1),
        color: ColorSchema,
      })
    )
    .min(1),
  height: z.number().int().positive().optional(),
  /** Columns. Without one, ink-chart draws one column per data point. */
  width: z.number().int().positive().optional(),
  showYAxis: z.boolean().optional(),
  xLabels: z.array(z.string()).optional(),
  yDomain: z.tuple([z.number(), z.number()]).optional(),
});

const SparklineSchema = z.object({
  chartType: z.literal('sparkline'),
  title: z.string().optional(),
  data: z.array(z.number()).min(1),
  colorScheme: z.enum(['red', 'blue', 'green']).optional(),
  mode: z.enum(['block', 'braille']).optional(),
  threshold: z.number().optional(),
});

export const ChartContentSchema = z.discriminatedUnion('chartType', [
  BarChartSchema,
  StackedBarChartSchema,
  LineGraphSchema,
  SparklineSchema,
]);

export type ChartContent = z.infer<typeof ChartContentSchema>;
export type BarChartConfig = z.infer<typeof BarChartSchema>;
export type StackedBarChartConfig = z.infer<typeof StackedBarChartSchema>;
export type LineGraphConfig = z.infer<typeof LineGraphSchema>;
export type SparklineConfig = z.infer<typeof SparklineSchema>;

/**
 * Parse render_chart arguments into chart content, or say what is wrong with
 * them in terms the model can act on.
 */
export function parseChartArgs(args: Record<string, unknown>): {
  success: boolean;
  config?: ChartContent;
  error?: string;
} {
  const built = assembleChart(args);
  if (!built.success) return { success: false, error: built.error };
  const checked = ChartContentSchema.safeParse(built.config);
  return checked.success
    ? { success: true, config: checked.data }
    : { success: false, error: `Invalid chart data:\n${z.prettifyError(checked.error)}` };
}

/** The arguments' JSON strings decoded into a candidate, checked by the caller. */
function assembleChart(args: Record<string, unknown>): {
  success: boolean;
  config?: unknown;
  error?: string;
} {
  try {
    const chartType = args.chartType as string;
    const title = args.title as string | undefined;
    const width = args.width ? Number.parseInt(args.width as string, 10) : 60;

    switch (chartType) {
      case 'bar': {
        const dataStr = args.barData as string;
        if (!dataStr) {
          return { success: false, error: 'barData is required for bar charts' };
        }
        const data = JSON.parse(dataStr);
        return {
          success: true,
          config: {
            chartType: 'bar',
            title,
            data,
            sort: (args.barSort as 'none' | 'asc' | 'desc') || 'none',
            showValue: (args.barShowValue as 'right' | 'inside' | 'none') || 'right',
            width,
          },
        };
      }

      case 'stackedBar': {
        const dataStr = args.stackedData as string;
        if (!dataStr) {
          return { success: false, error: 'stackedData is required for stacked bar charts' };
        }
        const data = JSON.parse(dataStr);
        return {
          success: true,
          config: {
            chartType: 'stackedBar',
            title,
            data,
            mode: (args.stackedMode as 'percentage' | 'absolute') || 'percentage',
            showLabels: true,
            showValues: true,
            width,
          },
        };
      }

      case 'line': {
        const seriesStr = args.lineSeries as string;
        if (!seriesStr) {
          return { success: false, error: 'lineSeries is required for line graphs' };
        }
        const series = JSON.parse(seriesStr);
        const xLabelsStr = args.lineXLabels as string | undefined;
        const xLabels = xLabelsStr ? JSON.parse(xLabelsStr) : undefined;
        const height = args.lineHeight ? Number.parseInt(args.lineHeight as string, 10) : 10;
        return {
          success: true,
          config: {
            chartType: 'line',
            title,
            series,
            height,
            width,
            showYAxis: true,
            xLabels,
          },
        };
      }

      case 'sparkline': {
        const dataStr = args.sparklineData as string;
        if (!dataStr) {
          return { success: false, error: 'sparklineData is required for sparklines' };
        }
        const data = JSON.parse(dataStr);
        const threshold = args.sparklineThreshold
          ? Number.parseFloat(args.sparklineThreshold as string)
          : undefined;
        return {
          success: true,
          config: {
            chartType: 'sparkline',
            title,
            data,
            colorScheme: (args.sparklineColor as 'red' | 'blue' | 'green') || 'blue',
            mode: (args.sparklineMode as 'block' | 'braille') || 'block',
            threshold,
          },
        };
      }

      default:
        return { success: false, error: `Unknown chart type: ${chartType}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `Failed to parse chart arguments: ${message}` };
  }
}
