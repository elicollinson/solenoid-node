import { describe, expect, it } from 'bun:test';
import {
  AppSettingsSchema,
  RoutesConfigSchema,
  ScreeningConfigSchema,
} from '../../src/config/schema.js';

describe('AppSettingsSchema', () => {
  it('fills every section from defaults when the file is empty', () => {
    const result = AppSettingsSchema.parse({});

    expect(result.providers.lmstudio.base_url).toBe('http://localhost:1234/v1');
    expect(result.providers.openrouter.base_url).toBe('https://openrouter.ai/api/v1');
    expect(result.routes.map((r) => r.provider)).toEqual(['lmstudio', 'openrouter']);
    expect(result.agent).toEqual({ think: true, timeout_ms: 300_000, max_turns: 25 });
    expect(result.screening.enabled).toBe(true);
    expect(result.keyboard.interrupt).toBe('escape');
    expect(result.display.show_reasoning).toBe(false);
  });

  it('still loads a settings file from the ADK era, ignoring its old sections', () => {
    const result = AppSettingsSchema.safeParse({
      ollama_host: 'https://ollama.com',
      models: { default: { name: 'gemma4:31b-cloud', provider: 'ollama_chat' } },
      agent_prompts: { planning_agent: 'You are a planner.' },
      embeddings: { provider: 'ollama' },
      search: { provider: 'brave', brave_search_api_key: 'key' },
      keyboard: { interrupt: 'tab' },
      display: { clear_progression_on_final: true },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('models');
      expect(result.data.search.brave_search_api_key).toBe('key');
      expect(result.data.keyboard.interrupt).toBe('tab');
      expect(result.data.routes).toHaveLength(2);
    }
  });

  it('keeps a partly specified provider and defaults the other', () => {
    const result = AppSettingsSchema.parse({
      providers: { lmstudio: { base_url: 'http://192.168.0.2:1234/v1' } },
    });

    expect(result.providers.lmstudio.base_url).toBe('http://192.168.0.2:1234/v1');
    expect(result.providers.openrouter.base_url).toBe('https://openrouter.ai/api/v1');
  });

  it('rejects a provider base_url that is not a URL', () => {
    const result = AppSettingsSchema.safeParse({
      providers: { lmstudio: { base_url: 'not-a-url' } },
    });

    expect(result.success).toBe(false);
  });

  it('accepts effort levels and booleans for agent.think', () => {
    expect(AppSettingsSchema.parse({ agent: { think: 'low' } }).agent.think).toBe('low');
    expect(AppSettingsSchema.parse({ agent: { think: false } }).agent.think).toBe(false);
    expect(AppSettingsSchema.safeParse({ agent: { think: 'max' } }).success).toBe(false);
  });
});

describe('RoutesConfigSchema', () => {
  it('rejects an empty route list', () => {
    expect(RoutesConfigSchema.safeParse([]).success).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(RoutesConfigSchema.safeParse([{ provider: 'ollama', model: 'x' }]).success).toBe(false);
  });
});

describe('ScreeningConfigSchema', () => {
  it('bounds the threshold to 0..1', () => {
    expect(ScreeningConfigSchema.safeParse({ threshold: 1.5 }).success).toBe(false);
    expect(ScreeningConfigSchema.parse({ threshold: 0.15 }).threshold).toBe(0.15);
  });
});
