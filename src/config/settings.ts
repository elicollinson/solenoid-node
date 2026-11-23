/**
 * Settings Loader
 *
 * Loads and caches application configuration from app_settings.yaml. Searches
 * from ~/.solenoid/app_settings.yaml. Provides helpers for provider credentials
 * and UI preferences with fallback defaults.
 *
 * Dependencies:
 * - yaml: YAML parser for reading configuration files
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { writeSettingsFile } from './generator.js';
import { type AppSettings, AppSettingsSchema, type ProviderName } from './schema.js';

const DEFAULT_SETTINGS_FILENAME = 'app_settings.yaml';
const SOLENOID_CONFIG_DIR = '.solenoid';

let cachedSettings: AppSettings | null = null;
let cachedRawSettings: Record<string, unknown> | null = null;
let settingsPath: string | null = null;

export function findSettingsFile(): string | null {
  const configPath = resolve(homedir(), SOLENOID_CONFIG_DIR, DEFAULT_SETTINGS_FILENAME);
  if (existsSync(configPath)) {
    return configPath;
  }

  return null;
}

export function ensureSettingsFile(): string | null {
  const existing = findSettingsFile();
  if (existing) return existing;

  const configPath = resolve(homedir(), SOLENOID_CONFIG_DIR, DEFAULT_SETTINGS_FILENAME);
  try {
    return writeSettingsFile({ outputPath: configPath, overwrite: false });
  } catch {
    return null;
  }
}

export function loadSettings(path?: string): AppSettings {
  const configPath = path ?? findSettingsFile();

  if (!configPath) {
    throw new Error(
      `Configuration file not found. Create ${DEFAULT_SETTINGS_FILENAME} or specify a path.`
    );
  }

  if (cachedSettings && settingsPath === configPath) {
    return cachedSettings;
  }

  const content = readFileSync(configPath, 'utf-8');
  const raw = (parseYaml(content) ?? {}) as Record<string, unknown>;
  const result = AppSettingsSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid configuration in ${configPath}:\n${errors}`);
  }

  // Persist generated device identity on first load of an older settings file
  // so this machine keeps the same device.id and derived device.name across runs.
  const rawDevice = raw.device as { id?: unknown; name?: unknown } | undefined;
  if (
    typeof rawDevice?.id !== 'string' ||
    !rawDevice.id.trim() ||
    typeof rawDevice?.name !== 'string' ||
    !rawDevice.name.trim()
  ) {
    raw.device = { id: result.data.device.id, name: result.data.device.name };
    try {
      const yaml = stringifyYaml(raw, { indent: 2, lineWidth: 0 });
      writeFileSync(configPath, yaml, 'utf-8');
    } catch {
      // Read-only settings path: keep the in-memory identity for this run.
    }
  }

  cachedSettings = result.data;
  cachedRawSettings = raw;
  settingsPath = configPath;

  return result.data;
}

/**
 * Try to load settings, returning null if unavailable.
 * Useful for module-level initialization where failure is acceptable.
 */
export function tryLoadSettings(): AppSettings | null {
  try {
    return loadSettings();
  } catch {
    return null;
  }
}

export function clearSettingsCache(): void {
  cachedSettings = null;
  cachedRawSettings = null;
  settingsPath = null;
}

/**
 * Get the current settings file path
 */
export function getSettingsPath(): string | null {
  if (settingsPath) return settingsPath;
  // Try to find it if not cached
  return findSettingsFile();
}

/**
 * Get raw settings without schema validation (for dynamic section discovery)
 * Returns null if no settings file found
 */
export function getRawSettings(): Record<string, unknown> | null {
  if (cachedRawSettings) return cachedRawSettings;

  const configPath = getSettingsPath();
  if (!configPath) return null;

  try {
    const content = readFileSync(configPath, 'utf-8');
    cachedRawSettings = parseYaml(content) as Record<string, unknown>;
    settingsPath = configPath;
    return cachedRawSettings;
  } catch {
    return null;
  }
}

/**
 * Save settings to file with backup
 */
export function saveSettings(settings: Record<string, unknown>): void {
  const configPath = getSettingsPath();
  if (!configPath) {
    throw new Error('No settings file found to save to');
  }

  // Create backup
  const backupPath = `${configPath}.backup`;
  if (existsSync(configPath)) {
    copyFileSync(configPath, backupPath);
  }

  // Write new settings
  const yaml = stringifyYaml(settings, {
    indent: 2,
    lineWidth: 0, // Don't wrap lines
  });

  writeFileSync(configPath, yaml, 'utf-8');

  // Update cache
  cachedRawSettings = settings;
  cachedSettings = null; // Clear validated cache so it reloads
}

export const PROVIDER_KEY_ENV: Record<ProviderName, string> = {
  lmstudio: 'LMSTUDIO_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  omlx: 'OMLX_API_KEY',
};

/**
 * A secret: the environment variable wins over the settings file so secrets
 * can stay out of it. Empty counts as unset in both.
 */
function secret(envVar: string, fromFile: string | undefined): string | undefined {
  return process.env[envVar] || fromFile || undefined;
}

export function getProviderApiKey(
  provider: ProviderName,
  settings: AppSettings
): string | undefined {
  return secret(PROVIDER_KEY_ENV[provider], settings.providers[provider].api_key);
}

/** The Brave Search key, or undefined when web search is unavailable. */
export function getSearchApiKey(settings: AppSettings): string | undefined {
  if (settings.search.provider !== 'brave') return undefined;
  return secret('BRAVE_SEARCH_API_KEY', settings.search.brave_search_api_key);
}

/** Local SQLite path for session checkpoints (~/.solenoid/checkpoints.db by default). */
export function getSqliteCheckpointPath(settings: AppSettings): string {
  if (settings.checkpoints.sqlite_path) {
    return resolve(settings.checkpoints.sqlite_path);
  }
  if (process.env.NODE_ENV === 'test') {
    return ':memory:';
  }
  return resolve(homedir(), SOLENOID_CONFIG_DIR, 'checkpoints.db');
}

export interface SupabaseCredentials {
  url: string;
  apiKey: string;
  tablePrefix: string;
}

/**
 * Supabase connection settings for remote checkpoints, or undefined when not
 * configured. Environment variables override app_settings.yaml.
 */
export function getSupabaseCheckpointConfig(
  settings: AppSettings
): SupabaseCredentials | undefined {
  const supabase = settings.checkpoints.supabase;
  const url = secret('SUPABASE_URL', supabase.url);
  const apiKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    supabase.api_key ||
    undefined;
  if (!url || !apiKey) return undefined;
  return { url, apiKey, tablePrefix: supabase.table_prefix };
}
