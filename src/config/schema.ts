/**
 * Configuration Schema
 *
 * Zod validation schemas for app_settings.yaml: model providers and the
 * ordered route chain, the agent, injection screening, search, MCP servers,
 * and UI preferences.
 *
 * Unknown keys are stripped, so a settings file from the ADK era (models,
 * agent_prompts, ollama_host, embeddings) still loads; every new section has
 * a default.
 */
import { z } from 'zod';

export const PROVIDER_NAMES = ['lmstudio', 'openrouter'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const DEFAULT_LMSTUDIO_MODEL = 'google/gemma-4-26b-a4b';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemma-4-26b-a4b-it';

export const ProviderConfigSchema = z.object({
  base_url: z.url(),
  /** Overridden by LMSTUDIO_API_KEY / OPENROUTER_API_KEY when set. */
  api_key: z.string().optional(),
});

export const ProvidersConfigSchema = z
  .object({
    lmstudio: ProviderConfigSchema.prefault({ base_url: 'http://localhost:1234/v1' }),
    openrouter: ProviderConfigSchema.prefault({ base_url: 'https://openrouter.ai/api/v1' }),
  })
  .prefault({});

export const RouteConfigSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
  model: z.string().min(1),
});

export const RoutesConfigSchema = z
  .array(RouteConfigSchema)
  .min(1, 'At least one route is required')
  .default([
    { provider: 'lmstudio', model: DEFAULT_LMSTUDIO_MODEL },
    { provider: 'openrouter', model: DEFAULT_OPENROUTER_MODEL },
  ]);

export const ThinkSchema = z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]);

export const AgentConfigSchema = z
  .object({
    /** Reasoning: true for the backend default, false to disable, or an effort level. */
    think: ThinkSchema.default(true),
    /** Per-attempt deadline. A failed attempt moves to the next route. */
    timeout_ms: z
      .number()
      .int()
      .positive()
      .default(5 * 60_000),
    /** Model calls per attempt. The last is offered no tools, so the model must answer. */
    max_turns: z.number().int().positive().default(25),
    /** Replaces the built-in system prompt. */
    system_prompt: z.string().min(10).optional(),
  })
  .prefault({});

export const ScreeningConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** The judge runs on one of the configured providers. */
    provider: z.enum(PROVIDER_NAMES).default('lmstudio'),
    model: z.string().min(1).default(DEFAULT_LMSTUDIO_MODEL),
    /** A concern score above this flags. */
    threshold: z.number().min(0).max(1).default(0.5),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .prefault({});

export const SearchConfigSchema = z
  .object({
    provider: z.enum(['brave', 'none']).default('brave'),
    brave_search_api_key: z.string().optional(),
  })
  .prefault({});

export const McpStdioServerSchema = z.object({
  type: z.literal('stdio').optional().default('stdio'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const McpHttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);

export const KeyboardConfigSchema = z
  .object({
    interrupt: z.string().default('escape'),
  })
  .prefault({});

export const DisplayConfigSchema = z
  .object({
    /** Show the model's reasoning as it streams, dimmed, above the answer. */
    show_reasoning: z.boolean().default(false),
  })
  .prefault({});

export const AppSettingsSchema = z.object({
  providers: ProvidersConfigSchema,
  routes: RoutesConfigSchema,
  agent: AgentConfigSchema,
  screening: ScreeningConfigSchema,
  search: SearchConfigSchema,
  mcp_servers: z.record(z.string(), McpServerSchema).default({}),
  keyboard: KeyboardConfigSchema,
  display: DisplayConfigSchema,
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type RouteConfig = z.infer<typeof RouteConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type ScreeningConfig = z.infer<typeof ScreeningConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type McpStdioServer = z.infer<typeof McpStdioServerSchema>;
export type McpHttpServer = z.infer<typeof McpHttpServerSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type KeyboardConfig = z.infer<typeof KeyboardConfigSchema>;
export type DisplayConfig = z.infer<typeof DisplayConfigSchema>;
export type AppSettings = z.infer<typeof AppSettingsSchema>;
