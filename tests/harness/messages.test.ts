/**
 * Run-error wording shown to a person.
 */
import { describe, expect, test } from 'bun:test';
import { describeRunError } from '../../src/harness/index.js';

describe('describeRunError', () => {
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
