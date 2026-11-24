/**
 * Limits: one task at growing sizes, to find where a model stops coping.
 *
 * Each sweep turns one dial and leaves the task as easy as it can be, so the
 * size it breaks at is a fact about that dial. When a model holds to the
 * largest size, add a larger one; a harder task would measure something else.
 */
import { z } from 'zod';
import { defineTool } from '../../src/index.js';
import { call, say } from '../../tests/helpers/scripted-provider.js';
import { sweep } from '../case.js';
import { answered, callCount, called, charts, reports, state, whole } from '../checks.js';
import { warehouse } from '../worlds/warehouse.js';

const VERBS = ['get', 'list', 'find', 'count'];
const NOUNS = [
  'invoice',
  'employee',
  'vehicle',
  'contract',
  'supplier',
  'refund',
  'campaign',
  'meeting',
  'license',
  'device',
  'policy',
  'payslip',
  'booking',
  'voucher',
  'lead',
  'audit',
  'visitor',
  'badge',
  'expense',
  'training',
  'survey',
  'ticket_queue',
  'mailbox',
  'calendar',
];

const SITES = ['', '_emea', '_apac', '_americas', '_archive'];

/** Names of plausible tools that have nothing to do with the task. */
const UNRELATED = SITES.flatMap((site) =>
  VERBS.flatMap((verb) => NOUNS.map((noun) => `${verb}_${noun}${site}`))
);

/** The first `count` of them, as tools. */
const distractors = (count: number) =>
  UNRELATED.slice(0, count).map((name) =>
    defineTool({
      name,
      description: `${name.replaceAll('_', ' ')} records in the back office.`,
      kind: 'read',
      schema: z.object({ query: z.string().optional().describe('What to look for') }),
      execute: () => 'No records.',
    })
  );

/** Spreads a count over 0 to 8999, so ids made from it do not come in order. */
const scatter = (i: number) => (i * 7919) % 9000;

/** Room for `calls` tool calls and the answer, never less than the default. */
const roomFor = (calls: number) => ({ agent: { max_turns: Math.max(25, calls + 4) } });

/** The same numbers on every run, in no order a reader could continue. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** No 0, O, 1 or I: a code is copied, not puzzled over. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The codes of a trail of clues, each clue naming the next. They follow no
 * pattern: the next code can only be learnt by reading the clue before it.
 */
function trailCodes(depth: number) {
  const next = seeded(7919);
  const codes = ['START'];
  while (codes.length < depth) {
    const code = Array.from(
      { length: 5 },
      () => CODE_LETTERS[Math.floor(next() * CODE_LETTERS.length)]
    ).join('');
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

function trail(depth: number) {
  const codes = trailCodes(depth);
  return {
    state: {},
    tools: [
      defineTool({
        name: 'follow_clue',
        description: 'Read the clue a code leads to.',
        kind: 'read',
        schema: z.object({ code: z.string().describe('The code of the clue') }),
        execute: ({ code }) => {
          const at = codes.indexOf(code.trim().toUpperCase());
          if (at < 0) throw new Error(`no clue has the code "${code}"`);
          return at === depth - 1
            ? 'The treasure is under the lighthouse.'
            : `The next clue has the code ${codes[at + 1]}.`;
        },
      }),
    ],
  };
}

const deskIds = (count: number) =>
  Array.from({ length: count }, (_, i) => `T-${1000 + scatter(i)}`);

/** A desk with `count` open tickets, each waiting for the same note. */
function auditDesk(count: number) {
  const ids = deskIds(count);
  const state = { notes: Object.fromEntries(ids.map((id) => [id, [] as string[]])) };
  return {
    state,
    tools: [
      defineTool({
        name: 'list_open_tickets',
        description: 'The id of every open ticket.',
        kind: 'read',
        schema: z.object({}),
        execute: () => ids,
      }),
      defineTool({
        name: 'add_note',
        description: 'Add an internal note to a ticket.',
        kind: 'write',
        schema: z.object({
          id: z.string().describe('The ticket id'),
          text: z.string().describe('The note'),
        }),
        execute: ({ id, text }) => {
          const notes = state.notes[id.trim().toUpperCase()];
          if (!notes) throw new Error(`unknown ticket "${id}"`);
          notes.push(text);
          return `Noted on ${id}.`;
        },
      }),
    ],
  };
}

/** An export that reports itself running until the check numbered `checks`. */
function exportJob(checks: number) {
  const state = { checked: 0 };
  return {
    state,
    tools: [
      defineTool({
        name: 'check_export',
        description: 'How far the running export has got.',
        kind: 'read',
        schema: z.object({}),
        execute: () =>
          ++state.checked < checks
            ? `Running: ${state.checked} of ${checks} tables exported.`
            : 'Finished. The file is export-7421.csv.',
      }),
    ],
  };
}

/** Where the log's one failed job sits: a little past the middle. */
const failedAt = (lines: number) => Math.floor(lines * 0.62);
const jobAt = (line: number) => 40000 + scatter(line);
/** The job that failed, an id like every other job's. */
const failedJob = (lines: number) => jobAt(failedAt(lines));

/**
 * A log of `lines` lines in which one job failed. Some other jobs fail a
 * first attempt and finish on the second, so "failed" alone does not find it.
 */
function deployLog(lines: number) {
  const retried = (line: number) => line === Math.floor(lines * 0.31) || line % 211 === 100;
  const log = Array.from({ length: lines }, (_, i) => {
    const time = new Date(Date.UTC(2026, 2, 14, 2, 0, i * 7)).toISOString().slice(11, 19);
    const took = `finished in ${200 + ((i * 131) % 700)} ms`;
    if (i === failedAt(lines)) {
      return `${time} ERROR worker-2 job ${jobAt(i)} failed after 3 attempts: disk quota exceeded on vol-7`;
    }
    if (retried(i)) {
      return `${time} WARN worker-${i % 4} job ${jobAt(i)} attempt 1 failed: connection reset, retrying`;
    }
    return retried(i - 1)
      ? `${time} INFO worker-${(i - 1) % 4} job ${jobAt(i - 1)} ${took} on attempt 2`
      : `${time} INFO worker-${i % 4} job ${jobAt(i)} ${took}`;
  }).join('\n');
  return {
    state: {},
    tools: [
      defineTool({
        name: 'read_log',
        description: "Last night's deploy log, in full.",
        kind: 'read',
        schema: z.object({}),
        execute: () => log,
      }),
    ],
  };
}

/** The warehouse the lookalike cases ask about, and what each one holds. */
const WAREHOUSE = 4106;
const widgetsIn = (code: number) => 20 + ((code * 13) % 480);
const STOCK_TOOL = 'widgets_in_warehouse_';
const stockTool = (code: number) => `${STOCK_TOOL}${code}`;

/** `count` tools that differ only in a four-digit code, one of them the one asked for. */
function lookalikes(count: number) {
  const codes = Array.from({ length: count }, (_, i) => 4100 + i * 3)
    // Mixed up, so the one asked for is not always third in the list.
    .sort((a, b) => ((a * 7919) % 1009) - ((b * 7919) % 1009));
  return {
    state: {},
    tools: codes.map((code) =>
      defineTool({
        name: stockTool(code),
        description: `How many widgets warehouse ${code} holds.`,
        kind: 'read',
        schema: z.object({}),
        execute: () => ({ warehouse: code, widgets: widgetsIn(code) }),
      })
    ),
  };
}

/** Stock items for the recall sweep: enough that 32 questions never repeat. */
const ITEMS = [
  'widget',
  'gear',
  'bolt',
  'washer',
  'spring',
  'bearing',
  'gasket',
  'valve',
  'pulley',
  'bracket',
  'hinge',
  'rivet',
  'clamp',
  'nozzle',
  'piston',
  'flange',
];
const unitsOf = (item: number) => 110 + ((item * 53) % 800);
/** Euros with cents that never end in a zero, so "4.25" is the only way to write it. */
const priceOf = (item: number) => 3 + item + [0.25, 0.75, 0.35, 0.85][item % 4]!;

/** A stock room of `ITEMS`: how many of each, and what one costs. */
function stockRoom() {
  const indexOf = (name: string) => {
    const at = ITEMS.indexOf(name.trim().toLowerCase().replace(/s$/, ''));
    if (at < 0) throw new Error(`unknown item "${name}"`);
    return at;
  };
  const item = z.string().describe('The item name');
  return {
    state: {},
    tools: [
      defineTool({
        name: 'get_stock',
        description: 'How many units of an item are in stock.',
        kind: 'read',
        schema: z.object({ item }),
        execute: ({ item }) => ({ item: ITEMS[indexOf(item)], units: unitsOf(indexOf(item)) }),
      }),
      defineTool({
        name: 'get_price',
        description: 'The unit price of an item, in euros.',
        kind: 'read',
        schema: z.object({ item }),
        execute: ({ item }) => ({ item: ITEMS[indexOf(item)], euros: priceOf(indexOf(item)) }),
      }),
    ],
  };
}

/**
 * The small questions asked between being told something and being asked for
 * it back: the stock of each item, then the price of each. None repeats, so
 * each needs its own lookup.
 */
const asides = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const item = i % ITEMS.length;
    const name = ITEMS[item]!;
    const price = priceOf(item).toFixed(2);
    return i < ITEMS.length
      ? {
          ask: `How many ${name}s are in stock?`,
          tool: 'get_stock',
          item: name,
          answer: `${unitsOf(item)}.`,
          right: (said: string) => whole(said, unitsOf(item)),
        }
      : {
          ask: `What does one ${name} cost?`,
          tool: 'get_price',
          item: name,
          answer: `${price} euros.`,
          right: (said: string) => whole(said.replaceAll(',', '.'), price),
        };
  });

export default [
  // Tool definitions spend context before the task is read: how many can be
  // held before the one that matters is lost among them?
  ...sweep('limits/tools-offered', [5, 20, 50, 100, 200, 400], (size) => ({
    world: () => {
      const world = warehouse();
      return { ...world, tools: [...world.tools, ...distractors(size - world.tools.length)] };
    },
    turns: ['How many gears are in stock?'],
    checks: [
      called('get_stock'),
      {
        name: 'called none of the unrelated tools',
        pass: (t) => !t.toolCalls.some((made) => UNRELATED.includes(made.name)),
      },
      answered(/\b45\b/),
    ],
    reference: [call('get_stock', { item: 'gear' }), say('45 gears are in stock.')],
  })),
  // How long a chain of dependent calls is followed to its end.
  ...sweep('limits/chain-depth', [2, 4, 8, 16, 32, 64], (size) => ({
    world: () => trail(size),
    settings: roomFor(size),
    turns: [
      'A trail of clues starts at the code START. Follow it with follow_clue until you learn where the treasure is, then tell me.',
    ],
    checks: [
      {
        // Clues read, not calls made: a guessed code that fails is not a step along the trail.
        name: `read all ${size} clues`,
        pass: (t) =>
          new Set(
            t.toolCalls
              .filter((made) => made.name === 'follow_clue' && made.ok)
              .map((made) => String(made.args.code).trim().toUpperCase())
          ).size >= size,
      },
      answered(/lighthouse/i),
    ],
    reference: [
      ...trailCodes(size).map((code) => call('follow_clue', { code })),
      say('The treasure is under the lighthouse.'),
    ],
  })),
  // How many writes one request can ask for before one is missed or made twice.
  ...sweep('limits/writes-in-one-task', [4, 16, 64], (size) => ({
    world: () => auditDesk(size),
    settings: roomFor(size),
    turns: ['Add the note "audited" to every open ticket. list_open_tickets gives their ids.'],
    checks: [
      state<{ notes: Record<string, string[]> }>('every open ticket has the note, once', (s) =>
        Object.values(s.notes).every(
          (notes) => notes.length === 1 && /^["“]?audited["”]?\.?$/i.test(notes[0]!.trim())
        )
      ),
      reports(
        /\ball\s+(?:of\s+the\s+)?(\d+)\b|\b(\d+)\s+open\s+tickets\b/gi,
        size,
        `any number of tickets it reports is ${size}`
      ),
    ],
    reference: [
      call('list_open_tickets', {}),
      ...deskIds(size).map((id) => call('add_note', { id, text: 'audited' })),
      say(`Added the note to all ${size} open tickets.`),
    ],
  })),
  // How many times the same step is repeated while nothing has changed yet.
  ...sweep('limits/polls-until-done', [4, 16, 64], (size) => ({
    world: () => exportJob(size),
    settings: roomFor(size),
    turns: [
      'An export is running. Check it with check_export until it has finished, then tell me the name of the file it produced.',
    ],
    checks: [callCount('check_export', { min: size }), answered(/\b7421\b/)],
    reference: [
      ...Array.from({ length: size }, () => call('check_export', {})),
      say('The export finished. The file is export-7421.csv.'),
    ],
  })),
  // How much one tool result can hold before a line in it is missed.
  ...sweep('limits/output-lines', [50, 200, 800, 3200], (size) => ({
    world: () => deployLog(size),
    turns: [
      "One job failed in last night's deploy. Read the log and tell me which job it was and why it failed.",
    ],
    checks: [called('read_log'), answered(failedJob(size)), answered(/quota/i)],
    reference: [
      call('read_log', {}),
      say(`Job ${failedJob(size)} failed: the disk quota on vol-7 was exceeded.`),
    ],
  })),
  // How many tools with nearly the same name before the wrong one is picked.
  ...sweep('limits/lookalike-tools', [4, 16, 64, 256], (size) => ({
    world: () => lookalikes(size),
    turns: [`How many widgets are in warehouse ${WAREHOUSE}?`],
    checks: [
      called(stockTool(WAREHOUSE)),
      {
        name: 'asked no other warehouse',
        pass: (t) =>
          t.toolCalls.every(
            (made) => !made.name.startsWith(STOCK_TOOL) || made.name === stockTool(WAREHOUSE)
          ),
      },
      answered(widgetsIn(WAREHOUSE)),
    ],
    reference: [
      call(stockTool(WAREHOUSE), {}),
      say(`Warehouse ${WAREHOUSE} holds ${widgetsIn(WAREHOUSE)} widgets.`),
    ],
  })),
  // How many turns of other work something said in the first is kept through.
  ...sweep('limits/turns-before-recall', [2, 8, 32], (size) => {
    const between = asides(size);
    return {
      world: stockRoom,
      turns: [
        'My customer number is Q-58213. I will ask you for it later.',
        ...between.map((aside) => aside.ask),
        'What is my customer number?',
      ],
      checks: [
        answered(/Q-58213/),
        {
          // The turns on the way are work too: a wrong answer there is a wrong answer.
          name: 'answered every question on the way correctly',
          // A turn with no text ended on a chart, which is an answer too.
          // ponytail: any chart of the run counts for such a turn; record a
          // call's turn if a wrong chart is ever hidden by a later right one.
          pass: (t) => between.every((aside, i) => aside.right(t.answers[i + 1] || charts(t))),
        },
      ],
      reference: [
        say('Noted.'),
        ...between.flatMap(({ tool, item, answer }) => [call(tool, { item }), say(answer)]),
        say('Your customer number is Q-58213.'),
      ],
    };
  }),
];
