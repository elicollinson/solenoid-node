import {
  COMPONENTS,
  type ChartContent,
  type ComponentType,
} from '@elicollinson/solenoid-engine/display';
/**
 * Component Catalog
 *
 * The terminal's side of the display contract (`@elicollinson/solenoid-engine/display`):
 * one Ink component per component type. Content is validated against the contract's
 * schema before it is drawn, so a malformed payload shows an error box
 * rather than a broken chart, and a type this terminal does not know is
 * named rather than dropped.
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { ChartRenderer } from './ChartRenderer.js';

const RENDERERS: {
  [K in ComponentType]: (content: z.infer<(typeof COMPONENTS)[K]>) => ReactElement;
} = {
  'solenoid.chart': (content: ChartContent) => <ChartRenderer config={content} />,
};

interface Entry {
  schema: z.ZodType;
  render: (content: unknown) => ReactElement;
}

/** Looked up by a name from the wire, so a Map: no prototype keys to reach. */
const CATALOG = new Map(
  (Object.keys(COMPONENTS) as ComponentType[]).map((type): [string, Entry] => [
    type,
    { schema: COMPONENTS[type], render: RENDERERS[type] as Entry['render'] },
  ])
);

export function ActivityView({
  activityType,
  content,
}: {
  activityType: string;
  content: Record<string, unknown>;
}) {
  const entry = CATALOG.get(activityType);
  if (!entry) {
    return <Text dimColor>[{activityType} cannot be shown in the terminal]</Text>;
  }
  const parsed = entry.schema.safeParse(content);
  if (!parsed.success) {
    return (
      <Box borderStyle="single" borderColor="red" paddingX={1}>
        <Text color="red">
          Cannot draw {activityType}: {z.prettifyError(parsed.error)}
        </Text>
      </Box>
    );
  }
  return entry.render(parsed.data);
}
