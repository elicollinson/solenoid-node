/**
 * Component Catalog
 *
 * The terminal's side of the display contract (../../display): one Ink
 * component per component type. Content is validated against the contract's
 * schema before it is drawn, so a malformed payload shows an error box
 * rather than a broken chart, and a type this terminal does not know is
 * named rather than dropped.
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { COMPONENTS, type ChartContent, type ComponentType } from '../../display/index.js';
import { ChartRenderer } from './ChartRenderer.js';

const RENDERERS: {
  [K in ComponentType]: (content: z.infer<(typeof COMPONENTS)[K]>) => ReactElement;
} = {
  'solenoid.chart': (content: ChartContent) => <ChartRenderer config={content} />,
};

function isComponentType(type: string): type is ComponentType {
  return Object.hasOwn(COMPONENTS, type);
}

export function ActivityView({
  activityType,
  content,
}: {
  activityType: string;
  content: Record<string, unknown>;
}) {
  if (!isComponentType(activityType)) {
    return <Text dimColor>[{activityType} cannot be shown in the terminal]</Text>;
  }
  const parsed = COMPONENTS[activityType].safeParse(content);
  if (!parsed.success) {
    return (
      <Box borderStyle="single" borderColor="red" paddingX={1}>
        <Text color="red">
          Cannot draw {activityType}: {z.prettifyError(parsed.error)}
        </Text>
      </Box>
    );
  }
  const render = RENDERERS[activityType] as (content: unknown) => ReactElement;
  return render(parsed.data);
}
