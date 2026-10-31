import { BarChart, LineGraph, Sparkline, StackedBarChart } from '@pppp606/ink-chart';
/**
 * Chart Renderer Component
 *
 * Draws `solenoid.chart` content (../../display/chart.ts) with ink-chart: bar
 * charts, stacked bar charts, line graphs and sparklines. The catalog
 * (./catalog.tsx) validates the content before it gets here.
 */
import { Box, Text } from 'ink';
import type {
  BarChartConfig,
  ChartContent,
  LineGraphConfig,
  SparklineConfig,
  StackedBarChartConfig,
} from '../../display/index.js';

interface ChartRendererProps {
  config: ChartContent;
}

/**
 * Map color names to ink-compatible color values
 */
function mapColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  // ink supports these color names directly
  const validColors = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'gray',
    'grey',
  ];
  if (validColors.includes(color.toLowerCase())) {
    return color.toLowerCase();
  }
  return 'cyan'; // default fallback
}

/**
 * Render a bar chart
 */
function RenderBarChart({ config }: { config: BarChartConfig }) {
  const data = config.data.map((item) => ({
    label: item.label,
    value: item.value,
    color: mapColor(item.color),
  }));

  return (
    <Box flexDirection="column">
      {config.title && (
        <Text bold color="cyan">
          {config.title}
        </Text>
      )}
      <Box marginTop={config.title ? 1 : 0}>
        <BarChart
          data={data}
          sort={config.sort || 'none'}
          showValue={config.showValue || 'right'}
          width={config.width || 60}
        />
      </Box>
    </Box>
  );
}

/**
 * Render a stacked bar chart
 */
function RenderStackedBarChart({ config }: { config: StackedBarChartConfig }) {
  const data = config.data.map((item) => ({
    label: item.label,
    value: item.value,
    color: mapColor(item.color),
  }));

  return (
    <Box flexDirection="column">
      {config.title && (
        <Text bold color="cyan">
          {config.title}
        </Text>
      )}
      <Box marginTop={config.title ? 1 : 0}>
        <StackedBarChart
          data={data}
          mode={config.mode || 'percentage'}
          showLabels={config.showLabels !== false}
          showValues={config.showValues !== false}
          width={config.width || 60}
        />
      </Box>
    </Box>
  );
}

/**
 * Render a line graph
 */
function RenderLineGraph({ config }: { config: LineGraphConfig }) {
  // ink-chart LineGraph uses 'values' not 'data' for series data
  const data = config.series.map((series) => ({
    values: series.data,
    color: mapColor(series.color),
  }));

  // Build legend if series have labels
  const legendItems = config.series
    .filter((s) => s.label)
    .map((s) => ({ label: s.label!, color: mapColor(s.color) || 'cyan' }));

  return (
    <Box flexDirection="column">
      {config.title && (
        <Text bold color="cyan">
          {config.title}
        </Text>
      )}
      {legendItems.length > 0 && (
        <Box marginTop={config.title ? 1 : 0} gap={2}>
          {legendItems.map((item) => (
            <Text key={item.label} color={item.color}>
              ● {item.label}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <LineGraph
          data={data}
          height={config.height || 10}
          // ink-chart's default draws one column per point: five points, five columns.
          width={config.width || 60}
          showYAxis={config.showYAxis !== false}
          xLabels={config.xLabels}
          yDomain={config.yDomain || 'auto'}
        />
      </Box>
    </Box>
  );
}

/**
 * Render a sparkline
 */
function RenderSparkline({ config }: { config: SparklineConfig }) {
  return (
    <Box flexDirection="column">
      {config.title && (
        <Text bold color="cyan">
          {config.title}:{' '}
        </Text>
      )}
      <Box>
        <Sparkline
          data={config.data}
          colorScheme={config.colorScheme || 'blue'}
          mode={config.mode || 'block'}
          threshold={config.threshold}
        />
      </Box>
    </Box>
  );
}

/**
 * Main chart renderer that dispatches to the appropriate chart component
 */
export function ChartRenderer({ config }: ChartRendererProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      marginY={1}
    >
      {config.chartType === 'bar' && <RenderBarChart config={config} />}
      {config.chartType === 'stackedBar' && <RenderStackedBarChart config={config} />}
      {config.chartType === 'line' && <RenderLineGraph config={config} />}
      {config.chartType === 'sparkline' && <RenderSparkline config={config} />}
    </Box>
  );
}
