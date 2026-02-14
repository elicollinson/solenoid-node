# Solenoid

A multi-agent AI system powered by Google ADK with a React-based terminal UI, built on Bun.

## Features

- **Multi-agent hierarchy** with planning-driven orchestration
- **React/Ink terminal UI** with real-time streaming, markdown rendering, and inline charts
- **Secure Python code execution** via Pyodide (WebAssembly)
- **Web research** via Brave Search API
- **MCP support** for extensible tool integration (stdio + HTTP servers)
- **Local memory system** with hybrid search (SQLite + FTS5 + sqlite-vec, RRF fusion)
- **Configurable LLM providers**: Gemini (default) and Ollama (local inference)
- **Per-agent model overrides** and custom system prompts via YAML
- **OpenTelemetry tracing** with optional W&B Weave integration
- **Configurable agent interrupt** (Escape/Tab/custom key)
- **In-app settings editor**, slash commands, structured JSON logging

## Installation

### Homebrew (Recommended)

```bash
brew tap elicollinson/solenoid
brew install solenoid
```

Then run:

```bash
solenoid
```

### From Source

Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/elicollinson/solenoid.git
cd solenoid
bun install
bun run start
```

## Quick Start

Set your Gemini API key:

```bash
export GOOGLE_GENAI_API_KEY="your-api-key"
# or alternatively:
export GEMINI_API_KEY="your-api-key"
```

Then start the app:

```bash
bun run start

# Or with watch mode for development
bun run dev
```

## Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────┐
│                  Terminal UI (Ink/React)                  │
│                    src/ui/app.tsx                         │
│   React 18 + Ink 5 — Markdown, charts, tool status       │
└──────────────────────────┬───────────────────────────────┘
                           │  Direct function call (no HTTP)
                           v
┌──────────────────────────────────────────────────────────┐
│              ADK InMemoryRunner (src/agents/runner.ts)    │
│       Session management, retry logic, OTel tracing      │
└──────────────────────────┬───────────────────────────────┘
                           │
                           v
┌──────────────────────────────────────────────────────────┐
│                    Agent Hierarchy                        │
│                                                          │
│   planning_agent (orchestrator, no tools, delegates only) │
│   ├── research_agent         (Brave Search + web reader) │
│   ├── code_executor_agent    (Pyodide Python sandbox)    │
│   ├── chart_generator_agent  (inline terminal charts)    │
│   ├── mcp_agent              (MCP server tools)          │
│   └── generic_executor_agent (general text tasks)        │
└──────────────────────────────────────────────────────────┘
```

This is a **single-process architecture** — the UI invokes ADK agents directly, with no HTTP server layer.

### Agent Hierarchy

The agent tree is constructed in `src/agents/planning.ts`.

| Agent | Role | Tools |
|-------|------|-------|
| `planning_agent` | Creates plans, delegates to specialists, handles failures | None (delegates only) |
| `research_agent` | Web search, page content retrieval | `universal_search`, `read_webpage` |
| `code_executor_agent` | Python code execution in sandboxed WASM | `execute_code` |
| `chart_generator_agent` | Data visualization in the terminal | `render_chart` |
| `mcp_agent` | External tools via MCP servers | Dynamically discovered from MCP config |
| `generic_executor_agent` | Writing, summaries, general knowledge tasks | None |

**Transfer protocol:** Specialist agents transfer results back to `planning_agent` when done. The planner can chain agents by instructing a specialist to transfer directly to another.

### Design Assumptions

- **Planning-first**: `planning_agent` must create an explicit plan before delegating
- **No clarification requests**: Agents make reasonable assumptions rather than asking the user
- **Failure-forward**: On agent failure, `planning_agent` tries an alternative agent (never retries the same one)
- **Single-process**: No HTTP server — UI invokes ADK agents directly via `InMemoryRunner`
- **Session-based**: `InMemoryRunner` maintains per-session conversation history
- **Streaming-first**: All responses stream via `AsyncGenerator<AgentStreamChunk>` for real-time UI updates
- **ADK rootAgent patch**: Module-level singleton agents require post-construction `rootAgent` fix (`fixAgentTreeRoots()` in `src/agents/planning.ts`) due to an [ADK bug](https://github.com/google/adk-python/issues/2164)

### Tool System

| Tool | Agent | Source | Purpose |
|------|-------|--------|---------|
| `universal_search` | research_agent | `src/tools/brave-search.ts` | Brave Search API (10 results) |
| `read_webpage` | research_agent | `src/tools/web-reader.ts` | Fetch + extract text (max 10K chars, 15s timeout) |
| `execute_code` | code_executor_agent | `src/tools/code-execution.ts` | Python execution in Pyodide sandbox |
| `render_chart` | chart_generator_agent | `src/agents/chart-generator.ts` | Inline terminal chart rendering |
| MCP tools | mcp_agent | `src/tools/mcp-adk-adapter.ts` | Dynamically loaded from configured MCP servers |

All tools use ADK `FunctionTool` wrappers with Zod schema validation (`src/tools/adk-tools.ts`). MCP tools are converted from JSON Schema to Zod via the MCP-to-ADK adapter (`src/tools/mcp-adk-adapter.ts`).

### Terminal UI

Built with [Ink 5](https://github.com/vadimdemedes/ink) (React for terminals) and React 18.

| Component | File | Purpose |
|-----------|------|---------|
| `App` | `src/ui/app.tsx` | Root component with ErrorBoundary + Suspense |
| `Header` | `src/ui/components/Header.tsx` | App branding |
| `MessageList` | `src/ui/components/MessageList.tsx` | Chat history with markdown rendering |
| `ChatInput` | `src/ui/components/ChatInput.tsx` | Text input with slash command support |
| `StatusBar` | `src/ui/components/StatusBar.tsx` | Agent status and loading indicator |
| `ChartRenderer` | `src/ui/components/ChartRenderer.tsx` | Inline chart display via `ink-chart` |
| `SettingsScreen` | `src/ui/components/SettingsScreen.tsx` | In-app YAML settings editor |
| `HelpScreen` | `src/ui/components/HelpScreen.tsx` | Command reference |

Markdown is rendered with `marked` + `marked-terminal`. The `useAgent()` hook uses React Suspense for async agent initialization.

### Memory System

| Component | File | Purpose |
|-----------|------|---------|
| Database | `src/memory/database.ts` | SQLite via `bun:sqlite`, WAL mode |
| Schema | `src/memory/schema.ts` | `memories` table, `memories_vec` (sqlite-vec), `memories_fts` (FTS5) |
| Embeddings | `src/memory/embeddings.ts` | Ollama embeddings (`nomic-embed-text` default), 256-dim |
| Search | `src/memory/search.ts` | Hybrid retrieval: dense (vector) + sparse (FTS5 BM25) |
| Service | `src/memory/service.ts` | CRUD operations with automatic embedding |
| Callbacks | `src/memory/callbacks.ts` | ADK integration: `saveMemoriesOnFinalResponse` |

Search uses **Reciprocal Rank Fusion (RRF)** to merge dense and sparse results. Memory types: profile, episodic, semantic.

### LLM Providers

| Provider | Config Value | Model Naming | Notes |
|----------|-------------|--------------|-------|
| Gemini | `gemini` | Direct (e.g., `gemini-2.5-flash`) | Default. Requires `GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY` |
| Ollama | `ollama_chat` | Prefixed (e.g., `ollama/llama3.2`) | Local inference. 2-min timeout. Auto-registered with ADK `LLMRegistry` |

Ollama integration is implemented via `OllamaLlm` extending ADK's `BaseLlm` (`src/llm/ollama-adk.ts`). Per-agent model overrides are configured via `models.agents` in the settings file.

### Code Execution Sandbox

Python code runs in a [Pyodide](https://pyodide.org/) sandbox (CPython compiled to WebAssembly):

- **Pre-installed**: micropip, pygal
- **Available**: Full Python standard library (math, json, datetime, collections, itertools, re, etc.)
- **Not available**: numpy, pandas, requests (no network access, no binary packages)
- **Features**: Virtual filesystem for file I/O, separate stdout/stderr capture, output file extraction

Implementation: `src/sandbox/pyodide-engine.ts`

### Telemetry

OpenTelemetry spans capture the full request lifecycle:

```
solenoid.agent_run (root span)
├── agent: <name>          (per-agent invocation)
│   ├── tool: <name>       (tool execution)
│   └── llm_call           (LLM request/response)
└── agent: <name>
    └── ...
```

LLM tracing callbacks (`src/telemetry/llm-tracing.ts`) capture: model name, conversation history, token usage, finish reason, system instructions, and thinking/chain-of-thought.

Optional **W&B Weave** integration requires `WANDB_API_KEY` and `WANDB_PROJECT_ID` environment variables. Content is truncated to 32KB for OTel attributes.

Structured JSON logging writes to `logs/` (agent.log, ui.log, server.log).

## Configuration

Config file location: `~/.solenoid/app_settings.yaml` (created on first run).

### Sections

| Section | Purpose |
|---------|---------|
| `models` | Default model, agent model, extractor model, per-agent overrides (`models.agents`) |
| `embeddings` | Embedding provider, host, model for memory system |
| `search` | Search provider and API keys (Brave, Google) |
| `mcp_servers` | MCP server connections (stdio and HTTP) |
| `agent_prompts` | Custom system prompts for each agent |
| `keyboard` | Interrupt key configuration (default: `escape`) |

All config is validated with Zod schemas (`src/config/schema.ts`).

### Model Configuration

```yaml
models:
  default:
    name: "gemini-2.5-flash"
    provider: "gemini"
    context_length: 128000
  # Per-agent overrides
  agents:
    research_agent:
      name: "gemini-2.5-flash"
```

### MCP Server Configuration

```yaml
mcp_servers:
  # stdio-based server (local process)
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "./"]

  # HTTP-based server (remote)
  context7:
    type: "http"
    url: "https://mcp.context7.com/mcp"
    headers:
      CONTEXT7_API_KEY: "your-api-key"
```

### Agent Prompts

```yaml
agent_prompts:
  planning_agent: |
    You are the Chief Planner...
  research_agent: |
    You are the Research Specialist...
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help screen |
| `/settings` | Open settings editor |
| `/clear` | Clear message history |
| `/agents` | List available agents |
| `/quit`, `/exit` | Exit application |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Escape` | Interrupt agent (configurable) / return from settings/help |
| `Ctrl+C` | Quit application |

## Project Structure

```
src/
├── cli.ts                    # CLI entry point (Commander.js)
├── index.ts                  # Package entry
├── agents/
│   ├── factory.ts            # Agent hierarchy factory
│   ├── planning.ts           # Root orchestrator agent
│   ├── research.ts           # Web research agent
│   ├── code-executor.ts      # Python execution agent
│   ├── chart-generator.ts    # Chart visualization agent
│   ├── mcp.ts                # MCP tools agent
│   ├── generic.ts            # General knowledge agent
│   ├── runner.ts             # Agent execution runner (InMemoryRunner)
│   └── types.ts              # Shared agent types
├── config/
│   ├── schema.ts             # Zod validation schemas
│   ├── settings.ts           # Settings loader
│   ├── settingsManager.ts    # Settings CRUD
│   ├── generator.ts          # Default config generation
│   └── validator.ts          # Config validation
├── llm/
│   ├── ollama-adk.ts         # Ollama ADK integration (BaseLlm)
│   └── ollama.ts             # Ollama client wrapper
├── mcp/
│   └── manager.ts            # MCP server lifecycle manager
├── memory/
│   ├── database.ts           # SQLite database (bun:sqlite)
│   ├── schema.ts             # Database schema (memories, FTS5, vec)
│   ├── embeddings.ts         # Ollama embedding service
│   ├── search.ts             # Hybrid search (dense + sparse + RRF)
│   ├── service.ts            # Memory CRUD service
│   └── callbacks.ts          # ADK memory callbacks
├── sandbox/
│   └── pyodide-engine.ts     # Python WASM sandbox
├── telemetry/
│   ├── index.ts              # Telemetry setup
│   ├── llm-tracing.ts        # OTel LLM tracing callbacks
│   └── weave.ts              # W&B Weave exporter
├── tools/
│   ├── adk-tools.ts          # ADK FunctionTool wrappers
│   ├── brave-search.ts       # Brave Search API
│   ├── web-reader.ts         # Web page fetcher
│   ├── code-execution.ts     # Code execution wrapper
│   └── mcp-adk-adapter.ts    # MCP-to-ADK tool converter
├── ui/
│   ├── app.tsx               # Root React component
│   ├── index.tsx             # UI entry point (Ink render)
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── MessageList.tsx
│   │   ├── ChatInput.tsx
│   │   ├── StatusBar.tsx
│   │   ├── ChartRenderer.tsx
│   │   ├── ChartModal.tsx
│   │   ├── SettingsScreen.tsx
│   │   ├── HelpScreen.tsx
│   │   ├── LoadingScreen.tsx
│   │   └── ErrorBoundary.tsx
│   └── hooks/
│       └── useAgent.ts       # Agent initialization (Suspense)
└── utils/
    ├── logger.ts             # Structured JSON logging
    └── fetch.ts              # Fetch with timeout
```

## Development

### Requirements

- [Bun](https://bun.sh) (runtime and package manager)
- [Ollama](https://ollama.com/) (optional, for local inference and memory embeddings)

### Scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Start with watch mode |
| `bun run start` | Start the app |
| `bun run build` | Build to `dist/` |
| `bun test` | Run tests (Bun's native test runner) |
| `bun run lint` | Lint with Biome |
| `bun run typecheck` | TypeScript type checking |

### Linting

Uses [Biome](https://biomejs.dev/) — single quotes, trailing commas (ES5), semicolons.

## Technology Stack

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@google/adk` | ^0.2.4 | Google Agent Development Kit |
| `@google/genai` | ^0.14.0 | Gemini API client |
| `ink` | ^5.2.0 | React for terminal UIs |
| `react` | ^18.3.1 | UI framework |
| `@modelcontextprotocol/sdk` | ^1.12.1 | MCP client |
| `ollama` | ^0.5.14 | Ollama API client |
| `@opentelemetry/api` | ^1.9.0 | Distributed tracing |
| `marked` | ^15.0.12 | Markdown parsing |
| `marked-terminal` | ^7.3.0 | Markdown terminal rendering |
| `@pppp606/ink-chart` | ^0.2.4 | Terminal charts |
| `zod` | ^3.24.2 | Schema validation |
| `commander` | ^13.1.0 | CLI framework |
| `yaml` | ^2.7.1 | YAML parsing |
| `chalk` | ^5.4.1 | Terminal colors |
| `@biomejs/biome` | ^1.9.0 | Linter and formatter |

Runtime: [Bun](https://bun.sh) (includes native SQLite via `bun:sqlite`)

## Credits

- [Google ADK](https://github.com/google/adk-node) — Agent Development Kit
- [Ink](https://github.com/vadimdemedes/ink) — React for terminals
- [Ollama](https://ollama.com/) — Local LLM inference
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — Vector search for SQLite
- [Pyodide](https://pyodide.org/) — CPython in WebAssembly
- [OpenTelemetry](https://opentelemetry.io/) — Distributed tracing
- [Biome](https://biomejs.dev/) — Linter and formatter
- [marked](https://marked.js.org/) — Markdown parser

## License

MIT
