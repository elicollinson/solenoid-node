# Solenoid

A single-agent harness with a React terminal UI, built on Bun. It runs Gemma 4 26B (MoE) on a local LM Studio server and falls back to the same model on OpenRouter. Prompt-injection screening comes from [solenoid-security](https://github.com/elicollinson/solenoid-security).

## Features

- **One agent, one framework-free loop.** Tools, streaming, real cancellation and structured output. The core is in `src/core`.
- **Model routes.** An ordered fallback chain: LM Studio first, OpenRouter second. If an attempt fails, the task restarts on the next route. Transient errors retry a bounded number of times first.
- **Injection screening of untrusted text.** Your messages and every result that comes from outside (web pages, search results, MCP output) are judged by a self-hosted Gemma judge before the model reads them. What happens on a flag depends on who wrote the text (see [Screening](#screening)).
- **Approval for writes.** A tool that changes something waits for your `y`/`n`. Reads never ask.
- **AG-UI 1.0 as the UI contract.** A conversation streams as standard [AG-UI](https://docs.ag-ui.com) events: text, reasoning, tool calls, chart components, approvals as interrupts. Any AG-UI client can draw it; the terminal UI is one.
- **Ink terminal UI.** Streaming markdown, tool-status lines, inline charts, a settings editor and slash commands.
- **Tools.** Brave web search, a web page reader, charts, plus any number of **MCP servers** (stdio or HTTP).
- **Subagents.** The session you talk to can start background subagents on self-contained tasks, wait for them, and read their summaries and transcripts.
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
             AG-UI events ── interrupts answered with session.resume()
                         │
             Session (src/harness/session.ts) ── transcript + AG-UI thread
                         │  encoder (src/harness/ag-ui)
             Agent (src/core/agent.ts) ── AgentEvents
             ├── routes:    OpenAICompatibleProvider (LM Studio | OpenRouter)
             ├── tools:     built-ins (src/tools) + MCP (src/mcp)
             ├── screen:    solenoid-security createSecurity().screen
             └── approvals: the session's interrupt handler
```

`src/harness/factory.ts` builds the agent from settings. `src/core` reads no configuration and no environment: routes, tools, the screen, approvals and logging are all passed in. That makes it usable as a library (`src/index.ts`).

### The UI contract (AG-UI)

`Session.send(text, { onEvent })` streams AG-UI 1.0 events (`@ag-ui/core`), and `applyEvent` (`src/harness/ag-ui/reducer.ts`) folds them into a thread of AG-UI messages. The terminal UI holds its conversation that way, and so can any other client.

| Agent | AG-UI |
|-------|-------|
| A turn | `RUN_STARTED` … `RUN_FINISHED`; each model call is a `STEP` |
| Text, reasoning | `TEXT_MESSAGE_*`, `REASONING_*` |
| A tool call | `TOOL_CALL_START/ARGS/END`, then `TOOL_CALL_RESULT` with `error`, `quarantined` or `declined` in `metadata.solenoid`; a run that ends first answers its open calls as `not run` |
| A chart | `ACTIVITY_SNAPSHOT` with `activityType: "solenoid.chart"`; content validated by the schema in `src/display` |
| A write waiting for approval | `RUN_FINISHED` with an `interrupt` outcome; `session.resume([{ interruptId, status: "resolved", payload: { approved } }])` continues it in a new run |
| A retry or a route change | `CUSTOM` (`solenoid.retry`, `solenoid.route_advanced`), then `MESSAGES_SNAPSHOT` without the discarded output |
| A screening flag | `CUSTOM` (`solenoid.guardrail`) |

Each surface draws components from its own catalog (`src/ui/components/catalog.tsx` for the terminal) and skips types it has none for. Tables are markdown in the answer, not a component.

### The loop

The core streams its own `AgentEvent`s (`turn_start`, `text_delta`, `reasoning_delta`, `assistant_turn`, `tool_start`, `tool_end`, `retry`, `route_advanced`, `guardrail`, `usage`), which the session encodes as AG-UI. A run returns its transcript so the next message continues the conversation. The transcript includes provider-native payloads, such as OpenRouter's `reasoning_details`.

- **Errors are turns.** A failed or invalid tool call is reported back to the model so it can correct itself.
- **Reads run together.** The read tools of one turn, and their screens, run concurrently. A write waits for the calls before it.
- **Display tools are for the person.** A `display` tool (`render_chart`) sends its content to the UI and tells the model only that it was shown. Every display call carries a required `done` flag: the model says when a chart completes its answer, and a turn of display calls that says so ends the run. Content identical to something already shown in the run is not drawn twice.
- **A turn limit.** `agent.max_turns` (default 25) bounds model calls per attempt; the last is offered no tools.
- **Route fallback is never a replay of a change.** Once a write tool has run, the attempt is not retried on another route. An interrupt and an injection verdict also end the run immediately.
- **Structured output:** `agent.runStructured(prompt, zodSchema)` adds a `submit_result` tool and validates the result against the schema, with repair feedback.

### Agent profiles

The CLI's agent is the default profile. An app built on the harness declares its own agents in code: the base tools (built-ins plus every connected MCP server) less any it excludes, plus tools of its own, which it builds bound to its own data and passes in.

```ts
import {
  DEFAULT_SYSTEM_PROMPT,
  createHarness,
  declineUnattended,
  defineProfile,
} from 'solenoid-node';

const calendarTriage = (db: Db) =>
  defineProfile({
    name: 'calendar-triage',
    systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nYou keep the person's calendar tidy.`,
    tools: calendarTools(db), // the app's own AgentTools
    exclude: ['render_chart'],
    approve: declineUnattended, // or the app's own approval policy
  });

const harness = await createHarness(loadSettings());
const session = harness.createSession(calendarTriage(db));
```

Each session gets its own agent, so one profile's tools never reach another's sessions. Excluding a tool the base set lacks, or adding one it keeps, fails when the session opens; to replace a base tool, exclude it and add your own. `defineProfile` registers the prompt as authored text, which the injection screen subtracts, so use it only for a prompt written in the app's code, never one with data interpolated into it. A profile not declared that way still works and its prompt is screened. `session.toolNames` lists what a session holds. With `canSpawn`, its subagents get the profile's tools and prompt.

#### Tool groups

Many tool definitions spend a local model's context before it has read the task. A profile can give its agent groups instead, each closed until the model opens it:

```ts
const calendar = (db: Db) =>
  defineToolGroup({
    name: 'calendar',
    summary: "The person's calendar: events, holds and who is invited.",
    briefing: 'Events are listed by day. Never cancel an event the person did not name.',
    tools: calendarTools(db),
  });

harness.createSession(defineProfile({ name: 'assistant', toolGroups: [calendar(db), reminders(db)] }));
```

The agent holds one tool for all of them, `open_tool_group(group)`, whose description lists each group by its summary. Opening one answers with the group's briefing and tool list, and its tools are offered from the next turn. A group is open once the transcript holds a completed call that opened it, so it stays open for the rest of the conversation, closes on `/clear`, and is not carried into a route fallback that replays the attempt without that call. To hold a group open from the start, pass its tools in `tools` instead. A group tool whose name is already taken fails when the session opens, and `session.toolNames` lists group tools after the held ones. A subagent can open groups when it is given `open_tool_group`. The summary and briefing are registered as authored text, so write them in code. On a local model, opening a group changes the tool list at the top of the prompt, so the next turn reprocesses the conversation once.

The core knows nothing of groups. Any tool can carry `unlocks: { tools, unlocked(messages) }`: the agent checks every name in `tools` when it is built, and before each model call offers those `unlocked` returns for the transcript so far.

### Subagents

`harness.createSession({ canSpawn: true })` gives a session's agent these tools; the UI and CLI sessions have them, subagents never do:

| Tool | Does |
|------|------|
| `spawn_subagent(name, task, tools?)` | Starts a child session in the background, with the parent's tools (or a subset) minus these |
| `subagent_summary(id)` | A model-written summary of a finished one's work, reused until its transcript grows |
| `read_subagent_transcript(id, from, count)` | A page of a finished one's transcript in detail |
| `message_subagent(id, message)` | A follow-up: a running one reads it when its current turn ends, a finished one starts again on it |
| `cancel_subagent(id)` | Stops one |

Subagents live in memory and stop when their session closes. Two run at once and the rest queue, since a local model's request slots and context are shared. Spawning commits the parent's attempt, so a route fallback never starts one twice. A subagent's task is sent as `agent` text. Nobody can approve a subagent's write yet, so those are declined as unattended.

The parent orchestrates and never blocks on a child. It spawns subagents, tells the person what is running, and ends its turn, so the person can keep talking to it and it can spawn more at any time. While any subagent runs, the model's copy of every message that opens a parent turn ends with their status. That covers the person's messages and the subagents' own. Those at work are listed with their task, and finished ones go on one line. It goes with the current message only: the thread and the stored transcript keep the words alone.

Every subagent that resolves, done or failed, sends the parent a message: its final answer, or "Nothing to report." A cancelled one sends none, since only the parent cancels. The session starts a turn of its own for these messages as soon as no turn is running, batching any that arrive together. That turn opens with an AG-UI `developer` message rather than a user one, which the terminal UI draws as a system line, and the message goes to the model as `agent` text. A client opts in with `session.onAutoTurn(turn => ...)` and runs the turn as it runs `send`. Turns never overlap: a `send` made while one is running waits for it. The one-shot CLI waits on `session.idle()` before it exits, so it writes the answers of these turns too.

### Screening

| Text | Boundary | On a flag |
|------|----------|-----------|
| Your messages (`operator`) | input | Logged, run continues |
| Anything of undeclared origin | input | Run stops |
| Tool results (web pages, search, MCP) | tool output | That output is withheld from the model; run continues |

The model's own text is not screened. That covers its turns and the results of tools that only echo it back, such as charts. Injected text is caught where it enters, before the model reads it. A tool's `kind` says which it is: `read` and `write` tools reach the world and are screened, while `internal` and `display` tools touch only this process and are neither screened nor put to approval. Both have to be declared, and MCP tools are never either.

Text this repository wrote (tool descriptions, the system prompt) is subtracted before the judge looks. A screen that cannot reach a verdict fails closed. Already-screened history is not re-screened on later turns. Turn screening off with `screening.enabled: false`.

## Configuration

`~/.solenoid/app_settings.yaml`. You can also edit it in the app with `/settings`. Every section has defaults:

```yaml
providers:
  lmstudio:
    base_url: http://localhost:1234/v1   # api_key optional; or LMSTUDIO_API_KEY
    stall:                 # only silence fails a request; slow streaming never does
      first_byte_ms: 300000  # queue + prompt processing
      idle_ms: 60000         # between chunks
  openrouter:
    base_url: https://openrouter.ai/api/v1   # key from OPENROUTER_API_KEY

routes:                    # tried in order
  - provider: lmstudio
    model: google/gemma-4-26b-a4b
  - provider: openrouter
    model: google/gemma-4-26b-a4b-it

agent:
  think: true              # true | false | low | medium | high
  max_turns: 25            # model calls per attempt; the last is offered no tools
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
├── harness/                 # Settings → agent, session, AG-UI encoder/reducer, prompt, messages
├── tools/                   # Built-in tools (web, chart)
├── mcp/                     # MCP client manager → AgentTools
├── config/                  # Settings schema, loader, editor support
├── display/                 # Display components: the chart schema and parser
├── telemetry/               # Optional W&B Weave export
└── ui/                      # Ink app, components, test harness
```

## Development

| Command | Purpose |
|---------|---------|
| `bun run dev` | Start with watch mode |
| `bun run start` | Start the app |
| `bun test` | Run tests. The real-agent e2e tests run when LM Studio serves the default model |
| `bun run build` | Bundle `dist/cli.js` for Node, with React Compiler applied |
| `bun run typecheck` | TypeScript type checking |
| `bun run lint` | Lint with Biome |
| `bun run scripts/live-core-smoke.ts` | Two-turn tool conversation on each live backend |

The Ink UI is compiled with [React Compiler](https://react.dev/learn/react-compiler), so components carry no manual `useMemo`, `useCallback` or `memo`. Bun does not run Babel, so `scripts/react-compiler.ts` applies it as a Bun plugin: `bunfig.toml` preloads it for `bun run` and `bun test`, and `scripts/build.ts` uses it for the bundle.

Tracing: set `WANDB_API_KEY` and `WANDB_PROJECT_ID` to export spans to W&B Weave. Structured JSON logs go to `logs/` (agent.log, ui.log, server.log).

## License

MIT
