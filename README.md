# Solenoid

A single-agent harness with a React terminal UI, built on Bun. It runs Gemma 4 26B (MoE) on a local LM Studio server and falls back to the same model on OpenRouter. Prompt-injection screening comes from [solenoid-security](https://github.com/elicollinson/solenoid-security).

## Features

- **One agent, one framework-free loop.** Tools, streaming, real cancellation and structured output. The core is in `src/core`.
- **Model routes.** An ordered fallback chain: LM Studio first, OpenRouter second. If an attempt fails, the task restarts on the next route. Transient errors retry a bounded number of times first.
- **Injection screening of untrusted text.** Your messages and every tool result (web pages, search results, MCP output) are judged by a self-hosted Gemma judge before the model reads them. What happens on a flag depends on who wrote the text (see [Screening](#screening)).
- **Approval for writes.** A tool that changes something waits for your `y`/`n`. Reads never ask.
- **Ink terminal UI.** Streaming markdown, tool-status lines, inline charts and tables, a settings editor and slash commands.
- **Tools.** Brave web search, a web page reader, terminal charts and table artifacts, plus any number of **MCP servers** (stdio or HTTP).
- **Non-interactive mode.** `solenoid --run "<prompt>"` streams the answer to stdout.
- **OpenTelemetry tracing** with OpenInference spans, with optional W&B Weave export.

## Installation

### Homebrew

```bash
brew tap elicollinson/solenoid
brew install solenoid
```

### From Source

Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/elicollinson/solenoid-node.git
cd solenoid-node
bun install
bun run start
```

## Quick Start

1. In LM Studio, load `google/gemma-4-26b-a4b` and start the server. It should be on `http://localhost:1234`.
2. Optionally, enable the OpenRouter fallback and web search:

   ```bash
   export OPENROUTER_API_KEY="sk-or-..."
   export BRAVE_SEARCH_API_KEY="..."
   ```

3. Run `solenoid` (or `bun run start`).

On first run, `~/.solenoid/app_settings.yaml` is created with defaults. A route whose provider has no API key is skipped with a warning. Without `OPENROUTER_API_KEY`, the agent runs on LM Studio alone.

### Non-interactive

```bash
solenoid --run "Summarize https://example.com in one sentence."
solenoid --run "..." --yes   # also allow tools that change things
```

The answer goes to stdout. Tool activity and warnings go to stderr. Nobody is present to approve a write, so writes are declined unless you pass `--yes`.

## Architecture

```
Terminal UI (src/ui)            CLI --run (src/cli-runner.ts)
            \                     /
             Session (src/harness/session.ts) ── transcript between turns
                         │
             Agent (src/core/agent.ts)
             ├── routes:    OpenAICompatibleProvider (LM Studio | OpenRouter)
             ├── tools:     built-ins (src/tools) + MCP (src/mcp)
             ├── screen:    solenoid-security createSecurity().screen
             └── approvals: per-run handler (UI prompt, or --yes)
```

`src/harness/factory.ts` builds the agent from settings. `src/core` reads no configuration and no environment: routes, tools, the screen, approvals and logging are all passed in. That makes it usable as a library (`src/index.ts`).

### The loop

Each turn streams `AgentEvent`s (`turn_start`, `text_delta`, `reasoning_delta`, `assistant_turn`, `tool_start`, `tool_end`, `retry`, `route_advanced`, `guardrail`, `usage`), and the UI and CLI render from these. A run returns its transcript so the next message continues the conversation. The transcript includes provider-native payloads, such as OpenRouter's `reasoning_details`.

- **Errors are turns.** A failed or invalid tool call is reported back to the model so it can correct itself.
- **Route fallback is never a replay of a change.** Once a write tool has run, the attempt is not retried on another route. An interrupt and an injection verdict also end the run immediately.
- **Structured output:** `agent.runStructured(prompt, zodSchema)` adds a `submit_result` tool and validates the result against the schema, with repair feedback.

### Screening

| Text | Boundary | On a flag |
|------|----------|-----------|
| Your messages (`operator`) | input | Logged, run continues |
| Anything of undeclared origin | input | Run stops |
| Tool results (web pages, search, MCP) | tool output | That output is withheld from the model; run continues |

The model's own turns are not screened: injected text is caught where it enters, before the model reads it.

Text this repository wrote (tool descriptions, the system prompt) is subtracted before the judge looks. A screen that cannot reach a verdict fails closed. Already-screened history is not re-screened on later turns. Turn screening off with `screening.enabled: false`.

## Configuration

`~/.solenoid/app_settings.yaml`. You can also edit it in the app with `/settings`. Every section has defaults:

```yaml
providers:
  lmstudio:
    base_url: http://localhost:1234/v1   # api_key optional; or LMSTUDIO_API_KEY
  openrouter:
    base_url: https://openrouter.ai/api/v1   # key from OPENROUTER_API_KEY

routes:                    # tried in order
  - provider: lmstudio
    model: google/gemma-4-26b-a4b
  - provider: openrouter
    model: google/gemma-4-26b-a4b-it

agent:
  think: true              # true | false | low | medium | high
  timeout_ms: 300000       # per route attempt
  # system_prompt: ...     # replaces the built-in prompt

screening:
  enabled: true
  provider: lmstudio
  model: google/gemma-4-26b-a4b
  threshold: 0.5

search:
  provider: brave          # brave | none; key from BRAVE_SEARCH_API_KEY

mcp_servers:
  filesystem:              # stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "./"]
  context7:                # HTTP
    type: http
    url: https://mcp.context7.com/mcp

keyboard:
  interrupt: escape        # escape | tab | any single character

display:
  show_reasoning: false    # stream the model's reasoning, dimmed
```

An MCP tool asks for approval unless its server marks it `readOnlyHint`. Settings files from the ADK version still load. The old sections (`models`, `agent_prompts`, `ollama_host`, `embeddings`) are ignored.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help screen |
| `/settings` | Open settings editor |
| `/clear` | Clear the conversation |
| `/tools` | Show model routes, screening and tools |
| `/quit`, `/exit` | Exit application |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Escape` | Interrupt the agent (configurable) / return from settings or help |
| `y` / `n` | Allow or decline a tool that changes something |
| `Ctrl+C` | Quit application |

## Project Structure

```
src/
├── cli.ts / cli-runner.ts   # CLI entry and --run mode
├── index.ts                 # Library entry (core, harness, config)
├── core/                    # Agent loop, providers, tools, tracing (no config, no env)
├── harness/                 # Settings → agent, session, system prompt, messages
├── tools/                   # Built-in tools (web, chart, artifacts)
├── mcp/                     # MCP client manager → AgentTools
├── config/                  # Settings schema, loader, editor support
├── artifacts/ charts/       # Per-turn artifact store, chart parsing
├── telemetry/               # Optional W&B Weave export
└── ui/                      # Ink app, components, test harness
```

## Development

| Command | Purpose |
|---------|---------|
| `bun run dev` | Start with watch mode |
| `bun run start` | Start the app |
| `bun test` | Run tests. The real-agent e2e tests run when LM Studio serves the default model |
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | Lint with Biome |
| `bun run scripts/live-core-smoke.ts` | Two-turn tool conversation on each live backend |

Tracing: set `WANDB_API_KEY` and `WANDB_PROJECT_ID` to export spans to W&B Weave. Structured JSON logs go to `logs/` (agent.log, ui.log, server.log).

## License

MIT
