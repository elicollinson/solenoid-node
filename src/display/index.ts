/**
 * Display Components
 *
 * The contract between display tools and every surface that draws them.
 * A display tool's content travels as an AG-UI activity whose
 * `activityType` names one of these components; each surface keeps a
 * catalog mapping the type to its own component (the terminal UI's is
 * ../ui/components/catalog.tsx) and validates content against the schema
 * here before drawing it. A surface that has no component for a type, such
 * as a voice channel, skips it.
 *
 * Tables are not a component: a markdown table is already part of the
 * answer and every surface renders it, while a table component invited the
 * model to write the same table both ways.
 */
import type { z } from 'zod';
import { ChartContentSchema } from './chart.js';

export * from './chart.js';

export const COMPONENTS = {
  'solenoid.chart': ChartContentSchema,
} satisfies Record<string, z.ZodType>;

export type ComponentType = keyof typeof COMPONENTS;

/** Which component each display tool's content is. */
export const DISPLAY_TOOL_COMPONENTS: Record<string, ComponentType> = {
  render_chart: 'solenoid.chart',
};
