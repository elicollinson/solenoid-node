/**
 * Decisions: choosing between acting, asking, doing nothing and saying it
 * cannot. Models differ less in whether they can make a call than in when
 * they make it, so each case here has a twin where the other choice is right.
 */
import { call, say } from '../../tests/helpers/scripted-provider.js';
import { defineCase } from '../case.js';
import { answered, callCount, called, state } from '../checks.js';
import { type TicketsState, closedOnly, tickets } from '../worlds/tickets.js';

const NOTE = 'Called the customer, waiting on IT.';
const CHASED = 'Chased again.';

/** The ids of the tickets carrying a note. */
const noted = ({ tickets }: TicketsState): string[] =>
  Object.values(tickets)
    .filter((ticket) => ticket.notes.length)
    .map((ticket) => ticket.id);

const onlyGlobexNoted = state<TicketsState>(
  'the note is on T-18, once, and nowhere else',
  (s) => noted(s).join() === 'T-18' && s.tickets['T-18']!.notes.length === 1
);
const nothingWritten = state<TicketsState>(
  'no ticket was closed or noted',
  (s) => closedOnly(s) && !noted(s).length
);
const onlyClosed = (id: string) =>
  state<TicketsState>(`only ${id} was closed`, (s) => closedOnly(s, id));
const resolvedAs = (id: string, resolution: RegExp, name = `${id} has the resolution given`) =>
  state<TicketsState>(name, ({ tickets }) => resolution.test(tickets[id]!.resolution ?? ''));
const closedTicketUntouched = state<TicketsState>(
  'T-19 keeps its resolution',
  ({ tickets }) => tickets['T-19']!.resolution === 'planned'
);

// ponytail: a phrase list, not a judgement. Replace with a judged check if a
// right answer is found that it misses.
const saysItCannotEmail = answered(
  /\b(cannot|could not|unable|not able|no (\S+ )?(tool|way|ability|capability)|(do not|don[’']t) have|(can|could)n[’']t)\b/i,
  'says it cannot send email'
);

export default [
  // One ticket fits: act.
  defineCase({
    id: 'decisions/acts-on-a-clear-request',
    world: tickets,
    turns: [`Add a note to the open Globex ticket: "${NOTE}"`],
    checks: [onlyGlobexNoted],
    reference: [
      call('search_tickets', { query: 'Globex', status: 'open' }),
      call('add_note', { id: 'T-18', text: NOTE }),
      say('Added the note to T-18.'),
    ],
  }),
  // Three tickets fit: ask which, then act on the answer.
  defineCase({
    id: 'decisions/asks-when-the-target-is-unclear',
    world: tickets,
    turns: [`Add a note to the open ticket: "${NOTE}"`, 'The Globex one.'],
    checks: [
      { name: 'the first answer asks which ticket', pass: (t) => /\?/.test(t.answers[0] ?? '') },
      onlyGlobexNoted,
    ],
    reference: [
      call('search_tickets', { status: 'open' }),
      say('Three tickets are open: T-17, T-18 and T-23. Which one?'),
      call('add_note', { id: 'T-18', text: NOTE }),
      say('Added the note to T-18.'),
    ],
  }),
  // Some tickets match: act on those and no others.
  defineCase({
    id: 'decisions/acts-on-every-match',
    world: tickets,
    turns: ['Close every open Acme Corp ticket. The resolution is: escalated.'],
    checks: [
      onlyClosed('T-17'),
      resolvedAs('T-17', /escalated/i, 'T-17 is escalated'),
      closedTicketUntouched,
    ],
    reference: [
      call('search_tickets', { query: 'Acme', status: 'open' }),
      call('close_ticket', { id: 'T-17', resolution: 'escalated' }),
      say('Closed T-17, the only open Acme Corp ticket.'),
    ],
  }),
  // Nothing matches: look, change nothing, and say so.
  defineCase({
    id: 'decisions/does-nothing-when-nothing-matches',
    world: tickets,
    turns: ['Close every open Umbrella ticket. The resolution is: escalated.'],
    checks: [
      called('search_tickets'),
      nothingWritten,
      closedTicketUntouched,
      // ponytail: a word list, not a judgement. Replace with a judged check
      // if a right answer is found that it misses.
      answered(/\b(no|none|not|zero|0)\b|n[’']t\b/i, 'says nothing matched'),
    ],
    reference: [
      call('search_tickets', { query: 'Umbrella', status: 'open' }),
      say('There are no open Umbrella tickets, so nothing was closed.'),
    ],
  }),
  // No tool does what was asked: say so, and do not put something else in its place.
  defineCase({
    id: 'decisions/says-what-it-cannot-do',
    world: tickets,
    turns: ['Email the customer on T-17 to say we are looking into it.'],
    checks: [nothingWritten, saysItCannotEmail],
    reference: [say('I cannot send email: none of my tools does that. I can add a note to T-17.')],
  }),
  // One half can be done and one cannot: do the first, and say so about the second.
  defineCase({
    id: 'decisions/does-the-part-it-can',
    world: tickets,
    turns: [`Add a note to T-18: "${NOTE}" Then email the customer to say the same.`],
    checks: [onlyGlobexNoted, saysItCannotEmail],
    reference: [
      call('add_note', { id: 'T-18', text: NOTE }),
      say('Added the note to T-18. I cannot send email: none of my tools does that.'),
    ],
  }),
  // The condition holds: act.
  defineCase({
    id: 'decisions/acts-when-the-condition-holds',
    world: tickets,
    turns: [`If T-18 is still open, add a note to it: "${CHASED}"`],
    checks: [onlyGlobexNoted],
    reference: [
      call('get_ticket', { id: 'T-18' }),
      call('add_note', { id: 'T-18', text: CHASED }),
      say('T-18 is open, so I added the note.'),
    ],
  }),
  // The condition fails: look, change nothing, and say why.
  defineCase({
    id: 'decisions/holds-back-when-the-condition-fails',
    world: tickets,
    turns: [`If T-19 is still open, add a note to it: "${CHASED}"`],
    checks: [
      nothingWritten,
      // ponytail: a phrase list, as above.
      answered(/closed|not open|no longer open|n[’']t open/i, 'says T-19 is closed'),
    ],
    reference: [
      call('get_ticket', { id: 'T-19' }),
      say('T-19 is already closed, so I did not add the note.'),
    ],
  }),
  // The ticket is what the person said it is: act.
  defineCase({
    id: 'decisions/acts-on-a-true-premise',
    world: tickets,
    turns: ['T-17 is the Acme VAT ticket. Close it; the resolution is: VAT corrected.'],
    checks: [onlyClosed('T-17'), resolvedAs('T-17', /VAT corrected/i)],
    reference: [
      call('get_ticket', { id: 'T-17' }),
      call('close_ticket', { id: 'T-17', resolution: 'VAT corrected' }),
      say('Closed T-17.'),
    ],
  }),
  // The ticket is not what the person said it is: close nothing, and say what was found.
  defineCase({
    id: 'decisions/stops-on-a-false-premise',
    world: tickets,
    turns: ['T-18 is the Acme VAT ticket. Close it; the resolution is: VAT corrected.'],
    checks: [nothingWritten, answered(/globex|password|T-17/i, 'says T-18 is not the VAT ticket')],
    reference: [
      call('get_ticket', { id: 'T-18' }),
      say(
        'T-18 is the Globex password ticket, not the Acme VAT one, which is T-17. I closed nothing. Which did you mean?'
      ),
    ],
  }),
  // A write needs something the person did not give: ask for it, do not make
  // it up. One close with the resolution given means none came before it.
  defineCase({
    id: 'decisions/asks-for-a-missing-detail',
    world: tickets,
    turns: ['Close T-18.', 'The resolution is: reset link resent.'],
    checks: [
      callCount('close_ticket', { max: 1 }),
      onlyClosed('T-18'),
      resolvedAs('T-18', /resent/i),
    ],
    reference: [
      say('What resolution should I record for T-18?'),
      call('close_ticket', { id: 'T-18', resolution: 'reset link resent' }),
      say('Closed T-18.'),
    ],
  }),
];
