import { Badge } from '../../components/ui.jsx';
import { STATUS_LABELS, statusTone } from '../../lib/format.js';

/**
 * Shared vocabulary for the operations console.
 *
 * Status labels and tones are NOT redefined here: `lib/format.js` owns that
 * mapping so the console, the customer's order history and the cart all agree on
 * what a status is called and how it looks.
 */

/** The seven checks the reconciliation endpoint runs, in its own numbering. */
export const INVARIANTS = [
  { code: 'I1', detail: 'available = onHand − reserved' },
  { code: 'I2', detail: 'no counter is negative' },
  { code: 'I3', detail: 'reserved = Σ units held by pending orders' },
  { code: 'I4', detail: 'no order stranded past its reservation' },
  { code: 'I5', detail: 'every completed claim recorded an order' },
  { code: 'I6', detail: 'no idempotency claim without its order' },
  { code: 'I7', detail: 'no payment attempt without its order' },
];

/**
 * The order of the queue filters: anything holding stock or money first, for an
 * operator scanning down the list.
 *
 * These literals mirror the server's ORDER_STATUS enum deliberately rather than
 * importing it — the client is a separate artefact and must not reach into
 * server source at build time. A drift fails loudly: the server rejects an
 * unknown status with a 400 rather than quietly returning an empty page.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'fulfilled',
  'payment_failed',
  'expired',
  'cancelled',
];

/** `pending_payment` reads better as `pending payment` in a table cell. */
export const humanise = (value = '') => String(value).replace(/_/g, ' ');

/** The label for a status, falling back for the ones `format.js` does not name. */
export const statusLabel = (status) => STATUS_LABELS[status] ?? humanise(status);

export function StatusPill({ status, dot = true }) {
  return (
    <Badge tone={statusTone(status)} dot={dot}>
      {statusLabel(status)}
    </Badge>
  );
}

/**
 * The Lab's ideal default: the SCARCEST product with stock. Running a
 * concurrency demo against 200 units proves nothing; against 10 it proves the
 * thing that matters.
 */
export function prepareInventory(inventory = []) {
  const bySku = [...inventory].sort((a, b) => a.sku.localeCompare(b.sku));
  const scarcest =
    [...inventory].filter((p) => p.available > 0).sort((a, b) => a.available - b.available)[0] ??
    bySku[0];
  return { bySku, scarcestId: scarcest?.productId ?? '' };
}

/** Build a query string for the admin lists, omitting empty filters. */
export function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}
