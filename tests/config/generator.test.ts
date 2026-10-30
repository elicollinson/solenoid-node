import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_ENV_MAPPINGS,
  generateSettings,
  getDefaultSettings,
  getEnvVarStatus,
  writeSettingsFile,
} from '../../src/config/generator.js';

describe('Config Generator', () => {
  const testOutputPath = resolve(process.cwd(), '.test-settings.yaml');

  // Store original env vars
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear env vars
    originalEnv['BRAVE_SEARCH_API_KEY'] = process.env['BRAVE_SEARCH_API_KEY'];
    originalEnv['LMSTUDIO_BASE_URL'] = process.env['LMSTUDIO_BASE_URL'];
    originalEnv['MY_CUSTOM_KEY'] = process.env['MY_CUSTOM_KEY'];

    delete process.env['BRAVE_SEARCH_API_KEY'];
    delete process.env['LMSTUDIO_BASE_URL'];
    delete process.env['MY_CUSTOM_KEY'];
  });

  // Clean up test file after each test
  afterEach(() => {
    if (existsSync(testOutputPath)) {
      unlinkSync(testOutputPath);
    }
    // Restore original environment variables
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('getDefaultSettings', () => {
    it('should return valid default settings structure', () => {
      const settings = getDefaultSettings();

      expect(settings).toHaveProperty('providers');
      expect(settings).toHaveProperty('routes');
      expect(settings).toHaveProperty('agent');
      expect(settings).toHaveProperty('screening');
      expect(settings).toHaveProperty('search');
      expect(settings).toHaveProperty('mcp_servers');
    });

    it('should default to Gemma 4 26B on LM Studio, then OpenRouter', () => {
      const settings = getDefaultSettings();

      expect(settings.routes).toEqual([
        { provider: 'lmstudio', model: 'google/gemma-4-26b-a4b' },
        { provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it' },
      ]);
      expect(settings.screening).toMatchObject({
        enabled: true,
        provider: 'lmstudio',
        model: 'google/gemma-4-26b-a4b',
      });
    });

    it('should have correct default search config', () => {
      const settings = getDefaultSettings();

      expect(settings.search.provider).toBe('brave');
      expect(settings.search.brave_search_api_key).toBeUndefined();
    });
  });

  describe('getEnvVarStatus', () => {
    it('should return status of all default env vars', () => {
      const status = getEnvVarStatus();

      expect(status).toHaveProperty('BRAVE_SEARCH_API_KEY');
      expect(status).toHaveProperty('LMSTUDIO_BASE_URL');
    });

    it('should detect when env var is set', () => {
      process.env['BRAVE_SEARCH_API_KEY'] = 'test-key-123';

      const status = getEnvVarStatus();

      expect(status['BRAVE_SEARCH_API_KEY']).toBe(true);
    });

    it('should detect when env var is not set', () => {
      // Ensure env var is not set
      delete process.env['BRAVE_SEARCH_API_KEY'];

      const status = getEnvVarStatus();

      expect(status['BRAVE_SEARCH_API_KEY']).toBe(false);
    });

    it('should treat empty string as not set', () => {
      process.env['BRAVE_SEARCH_API_KEY'] = '';

      const status = getEnvVarStatus();

      expect(status['BRAVE_SEARCH_API_KEY']).toBe(false);
    });
  });

  describe('generateSettings', () => {
    it('should generate default settings when no env vars are set', () => {
      const settings = generateSettings();

      expect(settings.search.brave_search_api_key).toBeUndefined();
      expect(settings.providers.lmstudio.base_url).toBe('http://localhost:1234/v1');
    });

    it('should inject BRAVE_SEARCH_API_KEY from env', () => {
      process.env['BRAVE_SEARCH_API_KEY'] = 'my-brave-api-key';

      const settings = generateSettings();

      expect(settings.search.brave_search_api_key).toBe('my-brave-api-key');
    });

    it('should inject LMSTUDIO_BASE_URL from env', () => {
      process.env['LMSTUDIO_BASE_URL'] = 'http://192.168.0.10:1234/v1';

      const settings = generateSettings();

      expect(settings.providers.lmstudio.base_url).toBe('http://192.168.0.10:1234/v1');
    });

    it('should never write provider API keys into the file', () => {
      process.env['OPENROUTER_API_KEY'] = 'sk-secret';
      try {
        const settings = generateSettings();
        expect(JSON.stringify(settings)).not.toContain('sk-secret');
      } finally {
        delete process.env['OPENROUTER_API_KEY'];
      }
    });

    it('should merge with baseSettings', () => {
      const baseSettings = {
        search: {
          provider: 'none' as const,
        },
      };

      process.env['BRAVE_SEARCH_API_KEY'] = 'brave-key';

      const settings = generateSettings({ baseSettings });

      // Provider should be from base settings
      expect(settings.search.provider).toBe('none');
      // API key should be from env
      expect(settings.search.brave_search_api_key).toBe('brave-key');
    });

    it('should support custom env mappings', () => {
      process.env['MY_CUSTOM_KEY'] = 'custom-value';

      const settings = generateSettings({
        envMappings: [
          { envVar: 'MY_CUSTOM_KEY', settingsPath: ['search', 'brave_search_api_key'] },
        ],
      });

      expect(settings.search.brave_search_api_key).toBe('custom-value');
    });

    it('should support additional env vars', () => {
      const settings = generateSettings({
        additionalEnvVars: {
          CUSTOM: { settingsPath: ['search', 'brave_search_api_key'], value: 'injected-value' },
        },
      });

      expect(settings.search.brave_search_api_key).toBe('injected-value');
    });

    it('should use onlySetEnvVars mode', () => {
      process.env['BRAVE_SEARCH_API_KEY'] = 'only-this';

      const settings = generateSettings({ onlySetEnvVars: true });

      // Only the env var that was set should be present
      expect(settings.search?.brave_search_api_key).toBe('only-this');
      // Other defaults should not be present (or undefined)
      expect(settings.routes).toBeUndefined();
    });
  });

  describe('writeSettingsFile', () => {
    it('should write settings to file', () => {
      writeSettingsFile({ outputPath: testOutputPath });

      expect(existsSync(testOutputPath)).toBe(true);
    });

    it('should write valid YAML', () => {
      writeSettingsFile({ outputPath: testOutputPath });

      const content = readFileSync(testOutputPath, 'utf-8');
      const parsed = parseYaml(content);

      expect(parsed).toHaveProperty('providers');
      expect(parsed).toHaveProperty('routes');
      expect(parsed).toHaveProperty('search');
    });

    it('should inject env vars into written file', () => {
      process.env['BRAVE_SEARCH_API_KEY'] = 'file-test-key';

      writeSettingsFile({ outputPath: testOutputPath });

      const content = readFileSync(testOutputPath, 'utf-8');
      const parsed = parseYaml(content) as { search: { brave_search_api_key: string } };

      expect(parsed.search.brave_search_api_key).toBe('file-test-key');
    });

    it('should return the path to the written file', () => {
      const path = writeSettingsFile({ outputPath: testOutputPath });

      expect(path).toBe(testOutputPath);
    });

    it('should not overwrite if overwrite is false and file exists', () => {
      // Write first time
      process.env['BRAVE_SEARCH_API_KEY'] = 'first-key';
      writeSettingsFile({ outputPath: testOutputPath });

      // Try to write again with different key
      process.env['BRAVE_SEARCH_API_KEY'] = 'second-key';
      writeSettingsFile({ outputPath: testOutputPath, overwrite: false });

      // Should still have first key
      const content = readFileSync(testOutputPath, 'utf-8');
      const parsed = parseYaml(content) as { search: { brave_search_api_key: string } };

      expect(parsed.search.brave_search_api_key).toBe('first-key');
    });

    it('should overwrite by default', () => {
      // Write first time
      process.env['BRAVE_SEARCH_API_KEY'] = 'first-key';
      writeSettingsFile({ outputPath: testOutputPath });

      // Write again with different key
      process.env['BRAVE_SEARCH_API_KEY'] = 'second-key';
      writeSettingsFile({ outputPath: testOutputPath });

      // Should have second key
      const content = readFileSync(testOutputPath, 'utf-8');
      const parsed = parseYaml(content) as { search: { brave_search_api_key: string } };

      expect(parsed.search.brave_search_api_key).toBe('second-key');
    });
  });

  describe('DEFAULT_ENV_MAPPINGS', () => {
    it('should have expected mappings', () => {
      const envVars = DEFAULT_ENV_MAPPINGS.map((m) => m.envVar);

      expect(envVars).toContain('BRAVE_SEARCH_API_KEY');
      expect(envVars).toContain('LMSTUDIO_BASE_URL');
    });

    it('should have valid settings paths', () => {
      for (const mapping of DEFAULT_ENV_MAPPINGS) {
        expect(Array.isArray(mapping.settingsPath)).toBe(true);
        expect(mapping.settingsPath.length).toBeGreaterThan(0);
      }
    });
  });
});
