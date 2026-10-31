/**
 * Chart argument parsing.
 */
import { describe, expect, test } from 'bun:test';
import { parseChartArgs } from '../../src/display/index.js';

describe('parseChartArgs', () => {
  test('a line graph gets a width, 60 columns unless one is given', () => {
    const series = JSON.stringify([{ data: [10, 25, 15] }]);
    const parsed = parseChartArgs({ chartType: 'line', lineSeries: series });
    expect(parsed.config).toMatchObject({ chartType: 'line', width: 60 });
    const narrow = parseChartArgs({ chartType: 'line', lineSeries: series, width: '40' });
    expect(narrow.config).toMatchObject({ width: 40 });
  });
});
