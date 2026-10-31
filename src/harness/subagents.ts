/**
 * Subagents
 *
 * A session that can spawn holds one SubagentManager: the children it has
 * started, each a Session of its own running in the background, and the
 * tools the parent's model uses to start, watch, read, wait for and stop
 * them. Everything is in memory and lives as long as the parent session.
 *
 * A child runs with the parent's tools, or a subset named at spawn, never
 * the subagent tools themselves: depth stays at one. At most a few run at
 * once and the rest queue, since a local model serves one request at a
 * time and a queued request would spend its deadline waiting. Nobody can
 * approve a child's writes yet, so they are declined as unattended.
 */
import { type Message, contentToText } from '@ag-ui/core';
import { z } from 'zod';
import { type AgentTool, type ApprovalRequest, defineTool, truncate } from '../core/index.js';
import { parseToolArgs, toolStatus } from './ag-ui/reducer.js';
import { describeRunError } from './messages.js';
import { type Session, type SessionOptions, declineUnattended } from './session.js';

type SubagentStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** How many subagents one session may start. */
const MAX_SUBAGENTS = 8;
/** How many run at once; the rest wait their turn. */
const MAX_RUNNING = 2;
/** Longest a single wait_for_subagents may block. */
const MAX_WAIT_SECONDS = 600;
/** Transcript characters handed to the summarizer, from the end. */
const SUMMARY_INPUT_CHARS = 20_000;
/** A transcript entry's text, before it is cut. */
const ENTRY_CHARS = 1_500;

interface Subagent {
  id: string;
  name: string;
  task: string;
  tools: string[];
  status: SubagentStatus;
  startedAt?: number;
  endedAt?: number;
  answer?: string;
  error?: string;
  /** The tool it is running now, if any. */
  current?: string;
  steps: number;
  /** Writes it asked for and could not be allowed. */
  declined: string[];
  session: Session;
  controller: AbortController;
  /** Settles when it has finished, however it finished. */
  settled: Promise<void>;
  /** The last summary, and how much transcript it covered. */
  summary?: { covers: number; text: string };
}

interface SubagentManagerOptions {
  /** The tools a child may be given: the parent's own, without these. */
  tools: AgentTool[];
  /** A fresh session for a child holding these tools. */
  createSession: (name: string, tools: AgentTool[], options: SessionOptions) => Session;
  /** Write a summary of a child's work from its task and transcript. */
  summarize: (task: string, transcript: string) => Promise<string>;
}

export class SubagentManager {
  private readonly children = new Map<string, Subagent>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private next = 1;

  constructor(private readonly options: SubagentManagerOptions) {}

  spawn(name: string, task: string, toolNames?: string[]): Subagent {
    if (this.children.size >= MAX_SUBAGENTS) {
      throw new Error(`This session has started its limit of ${MAX_SUBAGENTS} subagents`);
    }
    const available = new Map(this.options.tools.map((t) => [t.definition.function.name, t]));
    const unknown = (toolNames ?? []).filter((n) => !available.has(n));
    if (unknown.length) {
      throw new Error(
        `Unknown tools ${unknown.join(', ')}; a subagent can have: ${[...available.keys()].join(', ')}`
      );
    }
    const tools = toolNames?.length
      ? toolNames.map((n) => available.get(n)!)
      : [...available.values()];

    const declined: string[] = [];
    const child: Subagent = {
      id: `sa-${this.next++}`,
      name,
      task,
      tools: tools.map((t) => t.definition.function.name),
      status: 'queued',
      steps: 0,
      declined,
      session: this.options.createSession(name, tools, {
        approve: (request: ApprovalRequest) => {
          declined.push(request.tool);
          return declineUnattended(request);
        },
      }),
      controller: new AbortController(),
      settled: Promise.resolve(),
    };
    child.settled = this.whenFree(child).then((slot) => this.run(child, slot));
    this.children.set(child.id, child);
    return child;
  }

  get(id: string): Subagent {
    const child = this.children.get(id);
    if (!child) {
      const known = [...this.children.keys()];
      throw new Error(`No subagent ${id}${known.length ? `; known: ${known.join(', ')}` : ''}`);
    }
    return child;
  }

  /** The named children, or all of them. */
  select(ids?: string[]): Subagent[] {
    return ids?.length ? ids.map((id) => this.get(id)) : [...this.children.values()];
  }

  /**
   * Resolve true once the children have all finished (or any one has),
   * false when the timeout passes first. Stops waiting when `signal` fires.
   */
  async wait(
    children: Subagent[],
    mode: 'all' | 'any',
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<boolean> {
    if (!children.length) return true;
    const finished =
      mode === 'all'
        ? Promise.all(children.map((c) => c.settled))
        : Promise.race(children.map((c) => c.settled));
    const stop = new AbortController();
    const timedOut = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      for (const s of [signal, stop.signal]) {
        s.addEventListener('abort', () => clearTimeout(timer), { once: true });
      }
    });
    try {
      return await Promise.race([finished.then(() => true as const), timedOut]);
    } finally {
      stop.abort();
    }
  }

  cancel(id: string): Subagent {
    const child = this.get(id);
    if (child.status === 'queued' || child.status === 'running') child.controller.abort();
    return child;
  }

  /** Stop every child not yet finished: the session is going away. */
  close(): void {
    for (const child of this.children.values()) {
      if (child.status === 'queued' || child.status === 'running') child.controller.abort();
    }
  }

  /** A model-written summary, reused while the transcript has not grown. */
  async summary(id: string): Promise<string> {
    const child = this.get(id);
    const entries = transcriptEntries(child.session.messages);
    if (child.summary?.covers === entries.length) return child.summary.text;
    const text = await this.options.summarize(
      child.task,
      entries.join('\n').slice(-SUMMARY_INPUT_CHARS)
    );
    child.summary = { covers: entries.length, text };
    return text;
  }

  transcript(id: string, from: number, count: number): { entries: string[]; total: number } {
    const all = transcriptEntries(this.get(id).session.messages);
    return { entries: all.slice(from, from + count), total: all.length };
  }

  /** The tools a parent's model drives its children with. */
  tools(): AgentTool[] {
    return subagentTools(this);
  }

  /**
   * Resolve true once a running slot is this child's, or false if it was
   * cancelled while it queued.
   */
  private whenFree(child: Subagent): Promise<boolean> {
    if (this.running < MAX_RUNNING) {
      this.running++;
      child.status = 'running';
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const start = () => {
        this.running++;
        resolve(true);
      };
      this.queue.push(start);
      child.controller.signal.addEventListener(
        'abort',
        () => {
          const at = this.queue.indexOf(start);
          if (at !== -1) {
            this.queue.splice(at, 1);
            resolve(false);
          }
        },
        { once: true }
      );
    });
  }

  private async run(child: Subagent, slot: boolean): Promise<void> {
    if (!slot || child.controller.signal.aborted) {
      child.status = 'cancelled';
      child.endedAt = Date.now();
      if (slot) this.release();
      return;
    }
    child.status = 'running';
    child.startedAt = Date.now();
    try {
      child.answer = await child.session.send(child.task, {
        signal: child.controller.signal,
        origin: 'agent',
        onEvent: (event) => {
          if (event.type === 'STEP_STARTED') child.steps++;
          else if (event.type === 'TOOL_CALL_START') child.current = event.toolCallName;
          else if (event.type === 'TOOL_CALL_RESULT') child.current = undefined;
        },
      });
      child.status = 'done';
    } catch (error) {
      child.status = child.controller.signal.aborted ? 'cancelled' : 'failed';
      child.error = describeRunError(error);
    } finally {
      child.endedAt = Date.now();
      child.current = undefined;
      this.release();
    }
  }

  private release(): void {
    this.running--;
    this.queue.shift()?.();
  }
}

function view(child: Subagent) {
  const elapsed = child.startedAt ? ((child.endedAt ?? Date.now()) - child.startedAt) / 1000 : 0;
  return {
    id: child.id,
    name: child.name,
    status: child.status,
    elapsedSeconds: Math.round(elapsed),
    steps: child.steps,
    ...(child.current ? { running: child.current } : {}),
    ...(child.declined.length ? { declinedWrites: child.declined } : {}),
    ...(child.error ? { error: child.error } : {}),
  };
}

/** A child's thread as numbered lines a model can read. */
function transcriptEntries(thread: readonly Message[]): string[] {
  const cut = (text: string) => truncate(text, ENTRY_CHARS, { showLength: true });
  const entries: string[] = [];
  for (const m of thread) {
    if (m.role === 'user') entries.push(`task: ${cut(contentToText(m.content))}`);
    else if (m.role === 'assistant') {
      if (m.content) entries.push(`answer: ${cut(m.content)}`);
      for (const call of m.toolCalls ?? []) {
        const args = JSON.stringify(parseToolArgs(call.function.arguments));
        entries.push(`call ${call.function.name}(${cut(args)})`);
      }
    } else if (m.role === 'tool') {
      const status = toolStatus(m);
      entries.push(
        status.status === 'failed'
          ? `failed (${status.reason}): ${cut(contentToText(m.content))}`
          : `result: ${cut(contentToText(m.content))}`
      );
    } else if (m.role === 'activity') {
      entries.push(`shown: ${m.activityType}`);
    }
  }
  return entries.map((entry, i) => `[${i}] ${entry}`);
}

/** The subagent tools' names, as a session that can spawn lists them. */
export function subagentToolNames(): string[] {
  // The tools reach the manager only when they run, so none is needed here.
  return subagentTools(null as unknown as SubagentManager).map((t) => t.definition.function.name);
}

function subagentTools(manager: SubagentManager): AgentTool[] {
  const id = z.string().describe('The subagent id, such as "sa-1"');
  const tools = [
    defineTool({
      name: 'spawn_subagent',
      description:
        'Start a subagent on a task in the background and return its id at once. The task must be complete on its own: the subagent cannot see this conversation. By default it has all of your tools except these subagent tools.',
      kind: 'internal',
      schema: z.object({
        name: z.string().describe('A short name for what it is doing, such as "researcher"'),
        task: z.string().describe('The whole task, with everything it needs to know'),
        tools: z
          .array(z.string())
          .optional()
          .describe('Only these of your tools, when it needs fewer than all'),
      }),
      execute: ({ name, task, tools }, context) => {
        context.commit();
        const child = manager.spawn(name, task, tools);
        return { ...view(child), tools: child.tools };
      },
    }),
    defineTool({
      name: 'list_subagents',
      description: 'List the subagents this session has started, with their status.',
      kind: 'internal',
      schema: z.object({}),
      execute: () => ({ subagents: manager.select().map(view) }),
    }),
    defineTool({
      name: 'subagent_status',
      description:
        'Where one subagent stands: queued, running, done, failed or cancelled, what it is running now, and its answer once done.',
      kind: 'internal',
      schema: z.object({ id }),
      execute: ({ id }) => {
        const child = manager.get(id);
        return {
          ...view(child),
          task: child.task,
          ...(child.answer ? { answer: child.answer } : {}),
        };
      },
    }),
    defineTool({
      name: 'subagent_summary',
      description:
        "A short written summary of a subagent's work so far: what it did, found and could not do.",
      kind: 'internal',
      schema: z.object({ id }),
      execute: async ({ id }, context) => ({
        ...view(manager.get(id)),
        summary: await context.untimed(manager.summary(id)),
      }),
    }),
    defineTool({
      name: 'read_subagent_transcript',
      description:
        "Read part of a subagent's transcript in detail: numbered entries of its calls, results and answers. Page through with from.",
      kind: 'internal',
      schema: z.object({
        id,
        from: z.number().int().min(0).default(0).describe('First entry to read'),
        count: z.number().int().min(1).max(30).default(10).describe('How many entries'),
      }),
      execute: ({ id, from, count }) => manager.transcript(id, from, count),
    }),
    defineTool({
      name: 'wait_for_subagents',
      description:
        'Wait until subagents finish, instead of checking their status repeatedly. Returns their status when all (or any) are done, or when the timeout passes.',
      kind: 'internal',
      schema: z.object({
        ids: z.array(z.string()).optional().describe('Which to wait for; all of them by default'),
        mode: z.enum(['all', 'any']).default('all').describe('Wait for all, or for the first'),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .default(120)
          .describe('Longest to wait'),
      }),
      execute: async ({ ids, mode, timeoutSeconds }, context) => {
        const children = manager.select(ids);
        const finished = await context.untimed(
          manager.wait(children, mode, timeoutSeconds * 1000, context.signal)
        );
        return { finished, subagents: children.map(view) };
      },
    }),
    defineTool({
      name: 'cancel_subagent',
      description: 'Stop a subagent that is queued or running.',
      kind: 'internal',
      schema: z.object({ id }),
      execute: ({ id }) => view(manager.cancel(id)),
    }),
  ];
  return tools as AgentTool[];
}
