/**
 * Run-error wording shown to a person.
 */
import { describe, expect, test } from 'bun:test';
import { ProviderStalledError } from '@elicollinson/solenoid-engine/core';
import { describeRunError } from '@elicollinson/solenoid-engine/harness';

describe('describeRunError', () => {
  test('a stall names the exact limit to raise', () => {
    expect(describeRunError(new ProviderStalledError('idle', 60_000, 'openrouter'))).toBe(
      'Model server stopped streaming for 60s, on every route. If the model is only slow, raise providers.openrouter.stall.idle_ms in /settings.'
    );
  });

  test('an HTML error page becomes one readable line', () => {
    const error = Object.assign(
      new Error(
        '500 <!DOCTYPE html>\n<html lang="en">\n<head>\n<title>Error</title>\n</head>\n<body>\n<pre>Internal Server Error</pre>\n</body>\n</html>'
      ),
      { status: 500 }
    );
    const text = describeRunError(error);
    expect(text).toStartWith('The model server failed (HTTP 500: Internal Server Error).');
    expect(text).not.toContain('<');
  });

  test('a dropped stream says what happened', () => {
    expect(describeRunError(new TypeError('terminated'))).toContain('closed the connection');
  });
});
