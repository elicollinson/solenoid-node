/**
 * Keyboard Config Tests
 *
 * Unit tests for the keyboard configuration schema and settings helper.
 */
import { describe, it, expect } from 'bun:test';
import {
  AppSettingsSchema,
  KeyboardConfigSchema,
} from '../../src/config/schema.js';
import { getInterruptKey } from '../../src/config/settings.js';

describe('KeyboardConfigSchema', () => {
  it('parses with default interrupt key', () => {
    const result = KeyboardConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interrupt).toBe('escape');
    }
  });

  it('accepts custom interrupt key', () => {
    const result = KeyboardConfigSchema.safeParse({ interrupt: 'tab' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interrupt).toBe('tab');
    }
  });
});

describe('AppSettingsSchema with keyboard', () => {
  it('accepts settings with keyboard section', () => {
    const settings = {
      models: {
        default: { provider: 'ollama_chat', name: 'llama3.1:8b' },
      },
      keyboard: { interrupt: 'tab' },
    };

    const result = AppSettingsSchema.safeParse(settings);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keyboard.interrupt).toBe('tab');
    }
  });

  it('applies defaults when keyboard is omitted', () => {
    const settings = {
      models: {
        default: { provider: 'ollama_chat', name: 'llama3.1:8b' },
      },
    };

    const result = AppSettingsSchema.safeParse(settings);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keyboard.interrupt).toBe('escape');
    }
  });
});

describe('getInterruptKey', () => {
  it('returns escape when settings are unavailable', () => {
    // No settings file in test environment
    const key = getInterruptKey();
    expect(key).toBe('escape');
  });
});
