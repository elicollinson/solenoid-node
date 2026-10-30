/**
 * Chart Argument Parsing
 *
 * Turns render_chart tool arguments (data arrays arrive as JSON strings) into
 * a ChartConfig. The UI renders charts from the tool call's arguments, so the
 * tool in ../tools/chart.ts and the renderer share this one parser.
 */

/**
 * Parse chart tool arguments into a structured config object.
 * Handles JSON parsing of data arrays and converts string numbers.
 */
export function parseChartArgs(args: Record<string, unknown>): {
  success: boolean;
  config?: import('./types.js').ChartConfig;
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
