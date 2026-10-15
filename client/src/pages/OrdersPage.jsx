import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ReceiptIcon, RefreshIcon, SearchIcon } from '../components/icons.jsx';
import { ConfirmDialog, Drawer } from '../components/Modal.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  KeyValue,
  SkeletonTableRows,
  TextField,
  monogram,
  productTileStyle,
} from '../components/ui.jsx';
import { STATUS_LABELS, formatMinor, formatRelative, statusTone } from '../lib/format.js';
import { useAuth } from '../state/AuthContext.jsx';

const FILTERS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'open', label: 'Awaiting payment', match: (o) => o.status === 'pending_payment' },
  { id: 'paid', label: 'Paid', match: (o) => o.status === 'paid' || o.status === 'fulfilled' },
  {
    id: 'ended',
    label: 'Did not complete',
    match: (o) => ['payment_failed', 'expired', 'cancelled'].includes(o.status),
  },
];

function StatusPill({ status }) {
  return (
    <Badge tone={statusTone(status)} dot>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export default function OrdersPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.orders();
      setOrders(data.items);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pendingCount = orders.filter((order) => order.status === 'pending_payment').length;

  /**
   * Orders awaiting payment are polled to their terminal state. This is the
   * client side of the ambiguous-outcome path: the server owns the resolution,
   * the UI simply observes it — including refreshing an open drawer.
   */
  useEffect(() => {
    if (pendingCount === 0) return undefined;
    const timer = setInterval(async () => {
      await load();
    }, 2500);
    return () => clearInterval(timer);
  }, [pendingCount, load]);

  useEffect(() => {
    if (!selected) return;
    const fresh = orders.find((order) => order.id === selected.id);
    if (fresh && fresh.status !== selected.status) {
      // Keep the open drawer truthful as the poll resolves it.
      api
        .order(selected.id)
        .then(({ data }) => setSelected(data.order))
        .catch(() => {});
    }
  }, [orders, selected]);

  const counts = useMemo(() => {
    const result = {};
    for (const filterDef of FILTERS) {
      result[filterDef.id] = orders.filter(filterDef.match).length;
    }
    return result;
  }, [orders]);

  const visible = useMemo(() => {
    const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
    const term = query.trim().toLowerCase();
    return orders
      .filter(active.match)
      .filter(
        (order) =>
          !term ||
          order.orderNumber.toLowerCase().includes(term) ||
          order.items.some((item) => item.sku.toLowerCase().includes(term)),
      );
  }, [orders, filter, query]);

  async function openOrder(id) {
    try {
      const { data } = await api.order(id);
      setSelected(data.order);
    } catch (err) {
      toast.error('Could not load the order', err.message);
    }
  }

  const [confirmAction, setConfirmAction] = useState(null); // 'cancel' | 'refund'
  const [actionBusy, setActionBusy] = useState(false);

  async function handleAction() {
    if (!confirmAction || !selected) return;
    setActionBusy(true);
    try {
      if (confirmAction === 'cancel') {
        await api.cancelOrder(selected.id);
        toast.success(`Order ${selected.orderNumber} cancelled`, 'Its reserved stock is back on sale.');
      } else {
        const { data: body } = await api.refundPayment(selected.id);
        toast.success(
          body.refund?.alreadyRefunded ? 'Already refunded' : 'Refund recorded',
          `${selected.orderNumber} was refunded.`,
        );
      }
      setConfirmAction(null);
      const { data } = await api.order(selected.id);
      setSelected(data.order);
      await load();
    } catch (err) {
      toast.error(confirmAction === 'cancel' ? 'Could not cancel the order' : 'Could not refund the order', err.message);
    } finally {
      setActionBusy(false);
    }
  }

  const itemCount = (order) => order.items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <>
      {/* The page name lives in the top bar. What belongs here is the one thing
          the bar cannot know: how many orders are still settling right now. */}
      <div className="page-head">
        <div className="page-head__actions">
          {pendingCount > 0 ? (
            <Badge tone="warning">
              <span className="pulse-dot" aria-hidden="true" />
              {pendingCount} awaiting payment
            </Badge>
          ) : null}
          <TextField
            icon={SearchIcon}
            placeholder="Search order number or SKU"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search orders"
            style={{ width: 240 }}
          />
          <Button variant="default" icon={RefreshIcon} onClick={load}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <Alert tone="danger" title="Could not load your orders">
          {error.message}
        </Alert>
      ) : null}

      <Card>
        <div className="tabs" role="tablist" aria-label="Filter orders">
          {FILTERS.map((filterDef) => (
            <button
              key={filterDef.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={filter === filterDef.id}
              onClick={() => setFilter(filterDef.id)}
            >
              {filterDef.label}
              <span className="tab__count">{counts[filterDef.id] ?? 0}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <SkeletonTableRows rows={5} cols={5} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={query ? SearchIcon : ReceiptIcon}
            title={query ? `No orders match “${query}”` : 'No orders in this view'}
            body={
              query
                ? 'Search by order number or SKU, or clear the field to see everything.'
                : 'Place an order from the catalogue and it will appear here immediately.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table--hover table--clickable">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Items</th>
                  <th className="is-numeric">Total</th>
                  <th>Placed</th>
                  <th className="is-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((order) => (
                  <tr key={order.id} onClick={() => openOrder(order.id)}>
                    <td>
                      <span className="table__primary mono">{order.orderNumber}</span>
                    </td>
                    <td>
                      <StatusPill status={order.status} />
                    </td>
                    <td className="text-muted">
                      {itemCount(order)} unit{itemCount(order) === 1 ? '' : 's'} · {order.items.length}{' '}
                      line{order.items.length === 1 ? '' : 's'}
                    </td>
                    <td className="is-numeric">{formatMinor(order.pricing.totalMinor)}</td>
                    <td className="text-muted" title={new Date(order.createdAt).toLocaleString()}>
                      {formatRelative(order.createdAt)}
                    </td>
                    <td className="is-actions">
                      <Button size="sm" variant="ghost">
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? selected.orderNumber : ''}
        subtitle={selected ? `Placed ${formatRelative(selected.createdAt)}` : ''}
        footer={
          selected ? (
            <>
              <StatusPill status={selected.status} />
              <div className="card__actions">
                {isAdmin && selected.status === 'pending_payment' ? (
                  <Button
                    variant="danger-ghost"
                    onClick={() => setConfirmAction('cancel')}
                    disabled={actionBusy}
                  >
                    Cancel order
                  </Button>
                ) : null}
                {isAdmin && (selected.status === 'paid' || selected.payment?.status === 'refund_required') ? (
                  <Button
                    variant="primary"
                    onClick={() => setConfirmAction('refund')}
                    disabled={actionBusy}
                  >
                    Refund
                  </Button>
                ) : null}
              </div>
            </>
          ) : null
        }
      >
        {selected ? (
          <>
            {selected.status === 'pending_payment' ? (
              <Alert tone="warning" title="This order is holding stock">
                The reservation lapses at{' '}
                {new Date(selected.reservationExpiresAt).toLocaleTimeString()} — after which the units
                return to sale automatically. This view refreshes itself.
              </Alert>
            ) : null}

            <Card>
              <CardHeader title="Line items" />
              <CardBody flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="is-numeric">Qty</th>
                        <th className="is-numeric">Unit</th>
                        <th className="is-numeric">Line</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map((item) => (
                        <tr key={item.productId}>
                          <td>
                            <div className="cluster">
                              <span
                                className="line-item__thumb tile"
                                style={{ ...productTileStyle(item.sku), width: 32, height: 32 }}
                              >
                                <span aria-hidden="true" style={{ fontSize: 11 }}>
                                  {monogram(item.name)}
                                </span>
                              </span>
                              <span>
                                <span className="table__primary">{item.name}</span>
                                <span className="table__secondary mono" style={{ display: 'block' }}>
                                  {item.sku}
                                </span>
                              </span>
                            </div>
                          </td>
                          <td className="is-numeric">{item.quantity}</td>
                          <td className="is-numeric">{formatMinor(item.unitPriceMinor)}</td>
                          <td className="is-numeric">{formatMinor(item.lineTotalMinor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Totals" subtitle="A frozen snapshot from the moment of purchase." />
              <CardBody>
                <div className="totals">
                  <span className="totals__label">Subtotal</span>
                  <span className="totals__value">
                    {formatMinor(selected.pricing.subtotalMinor)}
                  </span>
                </div>
                {selected.pricing.discountMinor > 0 ? (
                  <div className="totals totals--discount">
                    <span className="totals__label">Discount</span>
                    <span className="totals__value">
                      −{formatMinor(selected.pricing.discountMinor)}
                    </span>
                  </div>
                ) : null}
                <div className="totals">
                  <span className="totals__label">Tax</span>
                  <span className="totals__value">{formatMinor(selected.pricing.taxMinor)}</span>
                </div>
                <div className="totals">
                  <span className="totals__label">Shipping</span>
                  <span className="totals__value">{formatMinor(selected.pricing.shippingMinor)}</span>
                </div>
                <div className="totals totals--grand">
                  <span>Total</span>
                  <span className="totals__value">{formatMinor(selected.pricing.totalMinor)}</span>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Details" />
              <CardBody>
                <KeyValue
                  rows={[
                    { k: 'Order id', v: <span className="mono">{selected.id}</span> },
                    { k: 'Status', v: STATUS_LABELS[selected.status] ?? selected.status },
                    ...(selected.failureReason ? [{ k: 'Failure reason', v: selected.failureReason }] : []),
                    { k: 'Holds stock', v: selected.holdsStock ? 'Yes' : 'No' },
                    { k: 'Terminal', v: selected.isTerminal ? 'Yes' : 'No' },
                    { k: 'Payment provider', v: selected.payment?.provider ?? '—' },
                    { k: 'Payment status', v: selected.payment?.status ?? '—' },
                    {
                      k: 'Reservation lapses',
                      v: selected.reservationExpiresAt
                        ? new Date(selected.reservationExpiresAt).toLocaleString()
                        : '—',
                    },
                    { k: 'Last updated', v: formatRelative(selected.updatedAt) },
                  ]}
                />
              </CardBody>
            </Card>

            <Alert tone="info" title="Why these figures are frozen">
              If the catalogue price changes later, this order still explains exactly what was charged
              and why.
            </Alert>
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleAction}
        busy={actionBusy}
        tone={confirmAction === 'cancel' ? 'danger' : 'primary'}
        title={
          confirmAction === 'cancel'
            ? `Cancel ${selected?.orderNumber}?`
            : `Refund ${selected?.orderNumber}?`
        }
        body={
          confirmAction === 'cancel'
            ? 'The order will be marked cancelled and its reserved units return to sale immediately.'
            : `The payment provider will be asked to refund ${formatMinor(
                selected?.pricing?.totalMinor ?? 0,
              )}. This operation is idempotent.`
        }
        confirmLabel={confirmAction === 'cancel' ? 'Cancel order' : 'Issue refund'}
      />
    </>
  );
}
