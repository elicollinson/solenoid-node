/**
 * Subagents
 *
 * A session that can spawn holds one SubagentManager: the children it has
 * started, each a Session of its own running in the background, and the
 * tools the parent's model uses to start, message, read and stop them.
 * Everything is in memory and lives as long as the parent session, so a
 * finished child can still be read.
 *
 * It is the parent session's background work. While any child runs, every
 * message the parent's model gets ends with their status; and every child
 * that resolves, done or failed, sends the parent a message of its own,
 * which starts a parent turn. The parent never blocks on a child.
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
import { SUBAGENT_NEWS, SUBAGENT_STARTED, SUBAGENT_STATUS } from './prompt.js';
import {
  type Background,
  type Session,
  type SessionOptions,
  declineUnattended,
} from './session.js';

type SubagentStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** How many subagents one session may start. */
const MAX_SUBAGENTS = 8;
/** How many run at once; the rest wait their turn. */
const MAX_RUNNING = 2;
/** Transcript characters handed to the summarizer, from the end. */
const SUMMARY_INPUT_CHARS = 20_000;
/** A transcript entry's text, before it is cut. */
const ENTRY_CHARS = 1_500;
/** An answer's text in the news of it, before it is cut. */
const NEWS_ANSWER_CHARS = 4_000;

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
  /** Messages from the parent, sent once the turn it is on ends. */
  inbox: string[];
}

interface SubagentManagerOptions {
  /** The tools a child may be given: the parent's own, without these. */
  tools: AgentTool[];
  /** A fresh session for a child holding these tools. */
  createSession: (name: string, tools: AgentTool[], options: SessionOptions) => Session;
  /** Write a summary of a child's work from its task and transcript. */
  summarize: (task: string, transcript: string) => Promise<string>;
}

const isActive = (child: Subagent) => child.status === 'queued' || child.status === 'running';
/** Done or failed: what the parent hears of. Only the parent cancels a child. */
const isResolved = (child: Subagent) => child.status === 'done' || child.status === 'failed';
/** How the parent's model sees a child named, in its status and its messages. */
const label = (child: Subagent) => `${child.name} (${child.id})`;
/** A task as compared for a repeat spawn: case and spacing aside. */
const taskKey = (task: string) => task.trim().replace(/\s+/g, ' ').toLowerCase();
/** Characters of a running child's task its status line shows. */
const STATUS_TASK_CHARS = 80;

export class SubagentManager implements Background {
  private readonly children = new Map<string, Subagent>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private next = 1;
  /** Children that resolved, done or failed, whose message the parent has not had yet. */
  private readonly resolved = new Set<Subagent>();
  private newsListener: (() => void) | undefined;

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
      inbox: [],
    };
    this.start(child, task);
    this.children.set(child.id, child);
    return child;
  }

  /**
   * Send a child a message. One still at work reads it once its current
   * turn ends; one that has finished, however it finished, takes it up as a
   * new turn of the same conversation.
   */
  message(id: string, text: string): Subagent {
    const child = this.get(id);
    if (isActive(child)) child.inbox.push(text);
    else {
      // The parent is taking it up again: its last resolution is out of date.
      this.resolved.delete(child);
      this.start(child, text);
    }
    return child;
  }

  /** A child queued or running on this task already: a repeat spawn gets it, not a second one. */
  underWay(task: string): Subagent | undefined {
    const key = taskKey(task);
    return this.select().find((c) => isActive(c) && taskKey(c.task) === key);
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

  cancel(id: string): Subagent {
    const child = this.get(id);
    if (isActive(child)) child.controller.abort();
    return child;
  }

  /** Stop every child not yet finished: the session is going away. */
  close(): void {
    for (const child of this.children.values()) {
      if (isActive(child)) child.controller.abort();
    }
  }

  /**
   * The resolution of each child that resolved since the last call, as a
   * message for the parent. A cancelled child sends none: only the parent
   * cancels one.
   */
  takeNews(): string | undefined {
    const finished = [...this.resolved];
    if (!finished.length) return undefined;
    this.resolved.clear();
    const heading = finished.map((c) => `${label(c)} ${c.status}`).join(', ');
    const details = finished.map((c) =>
      c.status === 'done'
        ? `${label(c)} answered:\n${truncate(c.answer || 'Nothing to report.', NEWS_ANSWER_CHARS, { showLength: true })}`
        : `${label(c)} failed: ${c.error}`
    );
    return `Subagents finished: ${heading}.\n\n${SUBAGENT_NEWS}\n\n${details.join('\n\n')}`;
  }

  onNews(listener: () => void): void {
    this.newsListener = listener;
  }

  /**
   * Where the children stand, while any is queued or running, for each
   * parent message: those at work in full, with their task, so the model
   * sees what is covered; those finished in a line, their outcome having
   * come as a message.
   */
  status(): string | undefined {
    const active = this.select().filter(isActive);
    if (!active.length) return undefined;
    const lines = active.map((c) => {
      const doing = c.current ? `, running ${c.current}` : '';
      const task = truncate(c.task, STATUS_TASK_CHARS);
      return `- ${label(c)}: ${c.status}, ${elapsedSeconds(c)}s, ${c.steps} steps${doing}. Task: ${task}`;
    });
    const finished = this.select().filter((c) => !isActive(c));
    if (finished.length) {
      lines.push(`Finished: ${finished.map((c) => `${label(c)} ${c.status}`).join(', ')}.`);
    }
    return `${SUBAGENT_STATUS}\n${lines.join('\n')}`;
  }

  /** Settles once every child has finished, including any a message restarts meanwhile. */
  async idle(): Promise<void> {
    for (;;) {
      const active = this.select().filter(isActive);
      if (!active.length) return;
      await Promise.all(active.map((c) => c.settled));
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

  /** Queue a run of `text`, from a fresh start. */
  private start(child: Subagent, text: string): void {
    child.controller = new AbortController();
    child.status = 'queued';
    child.answer = child.error = child.endedAt = undefined;
    child.settled = this.whenFree(child)
      .then((slot) => this.run(child, slot, text))
      .then(() => {
        if (isResolved(child)) this.resolved.add(child);
        this.newsListener?.();
      });
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

  /** Run `text` as a turn, then each message that arrived meanwhile, on one slot. */
  private async run(child: Subagent, slot: boolean, text: string): Promise<void> {
    try {
      if (!slot || child.controller.signal.aborted) {
        child.status = 'cancelled';
        return;
      }
      child.status = 'running';
      child.startedAt = Date.now();
      for (let next: string | undefined = text; next !== undefined; ) {
        child.answer = await child.session.send(next, {
          signal: child.controller.signal,
          origin: 'agent',
          onEvent: (event) => {
            if (event.type === 'STEP_STARTED') child.steps++;
            else if (event.type === 'TOOL_CALL_START') child.current = event.toolCallName;
            else if (event.type === 'TOOL_CALL_RESULT') child.current = undefined;
          },
        });
        next = child.inbox.length ? child.inbox.splice(0).join('\n\n') : undefined;
      }
      child.status = 'done';
    } catch (error) {
      child.status = child.controller.signal.aborted ? 'cancelled' : 'failed';
      child.error = describeRunError(error);
    } finally {
      child.endedAt = Date.now();
      child.current = undefined;
      child.inbox = [];
      if (slot) this.release();
    }
  }

  private release(): void {
    this.running--;
    this.queue.shift()?.();
  }
}

function elapsedSeconds(child: Subagent): number {
  const ms = child.startedAt ? (child.endedAt ?? Date.now()) - child.startedAt : 0;
  return Math.round(ms / 1000);
}

/** A child as a tool shows it to the parent's model. */
function view(child: Subagent) {
  return {
    id: child.id,
    name: child.name,
    status: child.status,
    elapsedSeconds: elapsedSeconds(child),
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

/** A spawn's or a restart's result: the child, and what to do next. */
function started(child: Subagent, note?: string) {
  return { ...view(child), next: note ? `${note} ${SUBAGENT_STARTED}` : SUBAGENT_STARTED };
}

/**
 * A child still at work, as a read of it answers: the parent hears from it
 * when it finishes, so reading it before then is not polled. An ordinary
 * result rather than an error, which a small model tends to retry.
 */
function stillAtWork(child: Subagent) {
  return isActive(child)
    ? { ...view(child), note: `Still ${child.status}. ${SUBAGENT_STARTED}` }
    : undefined;
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
        const existing = manager.underWay(task);
        if (existing) return started(existing, 'A subagent is already on this task: this one.');
        context.commit();
        const child = manager.spawn(name, task, tools);
        return { ...started(child), tools: child.tools };
      },
    }),
    defineTool({
      name: 'subagent_summary',
      description:
        "A short written summary of a finished subagent's work: what it did, found and could not do.",
      kind: 'internal',
      schema: z.object({ id }),
      execute: async ({ id }, context) =>
        stillAtWork(manager.get(id)) ?? {
          ...view(manager.get(id)),
          summary: await context.untimed(manager.summary(id)),
        },
    }),
    defineTool({
      name: 'read_subagent_transcript',
      description:
        "Read part of a finished subagent's transcript in detail: numbered entries of its calls, results and answers. Page through with from.",
      kind: 'internal',
      schema: z.object({
        id,
        from: z.number().int().min(0).default(0).describe('First entry to read'),
        count: z.number().int().min(1).max(30).default(10).describe('How many entries'),
      }),
      execute: ({ id, from, count }) =>
        stillAtWork(manager.get(id)) ?? manager.transcript(id, from, count),
    }),
    defineTool({
      name: 'message_subagent',
      description:
        'Send a subagent a follow-up message: more to do, a correction, or a question about its work. One still running reads it after its current step of work; one that has finished starts again on it, keeping its conversation so far. Its reply comes as a message of its own when it finishes.',
      kind: 'internal',
      schema: z.object({
        id,
        message: z.string().describe('What to tell it, complete on its own'),
      }),
      execute: ({ id, message }, context) => {
        // A finished child starts a new turn: replaying the call would start it twice.
        context.commit();
        return started(manager.message(id, message));
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
