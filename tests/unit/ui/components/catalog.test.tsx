/**
 * The terminal's component catalog.
 */
import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { ActivityView } from '../../../../src/ui/components/catalog.js';

describe('ActivityView', () => {
  test('draws a chart from valid content', () => {
    const { lastFrame } = render(
      <ActivityView
        activityType="solenoid.chart"
        content={{ chartType: 'bar', title: 'Fruit', data: [{ label: 'Apples', value: 5 }] }}
      />
    );
    expect(lastFrame()).toContain('Fruit');
    expect(lastFrame()).toContain('Apples');
  });

  test('names invalid content instead of drawing it', () => {
    const { lastFrame } = render(
      <ActivityView activityType="solenoid.chart" content={{ chartType: 'bar', data: [] }} />
    );
    expect(lastFrame()).toContain('Cannot draw solenoid.chart');
  });

  test('names a component it does not have', () => {
    const { lastFrame } = render(<ActivityView activityType="acme.map" content={{}} />);
    expect(lastFrame()).toContain('acme.map cannot be shown in the terminal');
  });
});
