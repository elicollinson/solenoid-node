/**
 * Configuration Schema
 *
 * Re-exported from `@elicollinson/solenoid-engine/config` so Solenoid-node's
 * YAML settings loader, validator, and UI stay 100% type- and runtime-identical
 * to the engine's `AppSettings` contract.
 */
export {
  type AgentConfig,
  AgentConfigSchema,
  type AppSettings,
  AppSettingsSchema,
  ApprovalsConfigSchema,
  type CheckpointsConfig,
  CheckpointsConfigSchema,
  DEFAULT_LMSTUDIO_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  type DeviceConfig,
  DeviceConfigSchema,
  type DisplayConfig,
  DisplayConfigSchema,
  type KeyboardConfig,
  KeyboardConfigSchema,
  type McpHttpServer,
  McpHttpServerSchema,
  type McpServer,
  McpServerSchema,
  type McpStdioServer,
  McpStdioServerSchema,
  PERMISSION_MODES,
  PROVIDER_NAMES,
  type ProviderConfig,
  ProviderConfigSchema,
  type ProviderName,
  type ProvidersConfig,
  ProvidersConfigSchema,
  type RouteConfig,
  RouteConfigSchema,
  RoutesConfigSchema,
  type ScreeningConfig,
  ScreeningConfigSchema,
  type SearchConfig,
  SearchConfigSchema,
  StallConfigSchema,
  type SupabaseCheckpointConfig,
  SupabaseCheckpointConfigSchema,
  ThinkSchema,
} from '@elicollinson/solenoid-engine/config';
