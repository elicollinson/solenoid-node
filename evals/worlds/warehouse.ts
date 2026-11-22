/**
 * A warehouse: stock and prices to read, a paginated shipment list, and an
 * orders service that is always down. Read-only, so its state never changes;
 * the world for anything about looking things up and working with the result.
 */
import { z } from 'zod';
import { defineTool } from '../../src/index.js';
import type { World } from '../case.js';

const STOCK = { widget: 130, gear: 45, bolt: 900 } as const;
const PRICES = { widget: 9, gear: 12.5, bolt: 0.2 } as const;
/** One shipment a page, so listing them all takes this many calls. */
export const SHIPMENT_PAGES = 8;

type Item = keyof typeof STOCK;

/** "Widgets" and "widget" are the same item: a case is never about spelling. */
function itemOf(name: string): Item {
  const item = name.trim().toLowerCase().replace(/s$/, '');
  if (!(item in STOCK)) {
    throw new Error(`unknown item "${name}": the items are ${Object.keys(STOCK).join(', ')}`);
  }
  return item as Item;
}

export function warehouse(): World<Record<string, never>> {
  const item = z.string().describe('The item name');
  return {
    state: {},
    tools: [
      defineTool({
        name: 'get_stock',
        description: 'How many units of an item are in stock.',
        kind: 'read',
        schema: z.object({ item }),
        execute: ({ item }) => ({ item: itemOf(item), units: STOCK[itemOf(item)] }),
      }),
      defineTool({
        name: 'get_price',
        description: 'The unit price of an item, in euros.',
        kind: 'read',
        schema: z.object({ item }),
        execute: ({ item }) => ({ item: itemOf(item), euros: PRICES[itemOf(item)] }),
      }),
      defineTool({
        name: 'list_shipments',
        description: 'Recent shipments, one per page.',
        kind: 'read',
        schema: z.object({ page: z.number().int().min(1).describe('The page, from 1') }),
        execute: ({ page }) => {
          if (page > SHIPMENT_PAGES) throw new Error(`there are ${SHIPMENT_PAGES} pages`);
          return {
            shipment: { id: `S-${100 + page}`, units: page * 10 },
            ...(page < SHIPMENT_PAGES ? { nextPage: page + 1 } : {}),
          };
        },
      }),
      defineTool({
        name: 'lookup_order',
        description: 'The status of a customer order.',
        kind: 'read',
        schema: z.object({ orderId: z.string().describe('The order number') }),
        execute: () => {
          throw new Error('the orders service is unavailable (503)');
        },
      }),
    ],
  };
}
