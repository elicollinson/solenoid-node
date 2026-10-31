/**
 * Subagents
 *
 * A session that can spawn holds one SubagentManager: the children it has
 * started, each a Session of its own running in the background, and the
 * tools the parent's model uses to start, watch, read, wait for and stop
 * them. Everything is in memory and lives as long as the parent session.
 *
 * A child runs with the parent's tools, or a subset named at spawn, never
 * the subagent tools themselves: depth stays at one. Nobody can answer a
 * child's approval interrupt yet, so its writes are declined as unattended,
 * the way an unattended CLI run declines them.
 */
import { EventType, type Message } from '@ag-ui/core';
import { z } from 'zod';
import { type AgentTool, defineTool } from '../core/index.js';
import { describeRunError } from './messages.js';
import { type Session, approvalAnswer } from './session.js';

export type SubagentStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** How many subagents one session may start. */
const MAX_SUBAGENTS = 8;
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
  startedAt: number;
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
  settled: Promise<void>;
}

export interface SubagentManagerOptions {
  /** The tools a child may be given: the parent's own, without these. */
  tools: AgentTool[];
  /** A fresh session for a child holding these tools. */
  createSession: (name: string, tools: AgentTool[]) => Session;
  /** Write a summary of a child's work from its task and transcript. */
  summarize: (task: string, transcript: string) => Promise<string>;
}

export class SubagentManager {
  private readonly children = new Map<string, Subagent>();
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

    const id = `sa-${this.next++}`;
    const controller = new AbortController();
    const session = this.options.createSession(name, tools);
    const child: Subagent = {
      id,
      name,
      task,
      tools: tools.map((t) => t.definition.function.name),
      status: 'running',
      startedAt: Date.now(),
      steps: 0,
      declined: [],
      session,
      controller,
      settled: Promise.resolve(),
    };
    child.settled = session
      .send(task, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === EventType.STEP_STARTED) child.steps++;
          if (event.type === EventType.TOOL_CALL_START) child.current = event.toolCallName;
          if (event.type === EventType.TOOL_CALL_RESULT) child.current = undefined;
          if (event.type === EventType.RUN_FINISHED && event.outcome?.type === 'interrupt') {
            for (const interrupt of event.outcome.interrupts) {
              child.declined.push(interrupt.message ?? interrupt.id);
            }
            session.resume(event.outcome.interrupts.map((i) => approvalAnswer(i.id, 'unattended')));
          }
        },
      })
      .then(
        (answer) => {
          child.status = 'done';
          child.answer = answer;
        },
        (error) => {
          child.status = controller.signal.aborted ? 'cancelled' : 'failed';
          child.error = describeRunError(error);
        }
      )
      .finally(() => {
        child.endedAt = Date.now();
        child.current = undefined;
      });
    this.children.set(id, child);
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

  list(): Subagent[] {
    return [...this.children.values()];
  }

  /** Resolve once the named children (all, by default) have finished, or any one has. */
  async wait(ids: string[] | undefined, mode: 'all' | 'any', timeoutMs: number): Promise<boolean> {
    const children = ids?.length ? ids.map((id) => this.get(id)) : this.list();
    if (!children.length) return true;
    const settled =
      mode === 'all'
        ? Promise.all(children.map((c) => c.settled))
        : Promise.race(children.map((c) => c.settled));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([settled.then(() => 'settled' as const), timeout]);
    clearTimeout(timer);
    return outcome === 'settled';
  }

  cancel(id: string): Subagent {
    const child = this.get(id);
    if (child.status === 'running') child.controller.abort();
    return child;
  }

  /** Stop every child still running: the session is going away. */
  close(): void {
    for (const child of this.children.values()) {
      if (child.status === 'running') child.controller.abort();
    }
  }

  async summary(id: string): Promise<string> {
    const child = this.get(id);
    const transcript = transcriptEntries(child.session.messages).join('\n');
    return this.options.summarize(child.task, transcript.slice(-SUMMARY_INPUT_CHARS));
  }

  transcript(id: string, from: number, count: number): { entries: string[]; total: number } {
    const all = transcriptEntries(this.get(id).session.messages);
    return { entries: all.slice(from, from + count), total: all.length };
  }

  /** The tools a parent's model drives its children with. */
  tools(): AgentTool[] {
    return subagentTools(this) as AgentTool[];
  }
}

function view(child: Subagent) {
  const elapsed = ((child.endedAt ?? Date.now()) - child.startedAt) / 1000;
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
  const cut = (text: string) =>
    text.length > ENTRY_CHARS ? `${text.slice(0, ENTRY_CHARS)}… [${text.length} chars]` : text;
  const entries: string[] = [];
  for (const m of thread) {
    if (m.role === 'user') entries.push(`task: ${cut(String(m.content))}`);
    else if (m.role === 'assistant') {
      if (m.content) entries.push(`answer: ${cut(m.content)}`);
      for (const call of m.toolCalls ?? []) {
        entries.push(`call ${call.function.name}(${cut(call.function.arguments)})`);
      }
    } else if (m.role === 'tool') {
      entries.push(`${m.error ? 'failed' : 'result'}: ${cut(String(m.content))}`);
    } else if (m.role === 'activity') {
      entries.push(`shown: ${m.activityType}`);
    }
  }
  return entries.map((entry, i) => `[${i}] ${entry}`);
}

function subagentTools(manager: SubagentManager) {
  const id = z.string().describe('The subagent id, such as "sa-1"');
  return [
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
        // A replay on another route would start it a second time.
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
      execute: () => ({ subagents: manager.list().map(view) }),
    }),
    defineTool({
      name: 'subagent_status',
      description:
        'Where one subagent stands: running, done, failed or cancelled, what it is running now, and its answer once done.',
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
      execute: async ({ id }) => ({ ...view(manager.get(id)), summary: await manager.summary(id) }),
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
        // Waiting on the children is not this attempt's work.
        const finished = await context.untimed(manager.wait(ids, mode, timeoutSeconds * 1000));
        const watched = ids?.length ? ids.map((i) => manager.get(i)) : manager.list();
        return { finished, subagents: watched.map(view) };
      },
    }),
    defineTool({
      name: 'cancel_subagent',
      description: 'Stop a subagent that is still running.',
      kind: 'internal',
      schema: z.object({ id }),
      execute: ({ id }) => view(manager.cancel(id)),
    }),
  ];
}
