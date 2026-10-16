import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { ReceiptIcon, SearchIcon } from '../../components/icons.jsx';
import { ConfirmDialog, Drawer } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  KeyValue,
  LoadingRow,
  SkeletonTableRows,
  TextField,
} from '../../components/ui.jsx';
import { formatDate, formatMinor, formatRelative, paymentTone } from '../../lib/format.js';
import { ORDER_STATUSES, StatusPill, buildQuery, humanise, statusLabel } from './shared.jsx';

const PAGE_SIZE = 25;

const unitCount = (order) => order.items.reduce((sum, item) => sum + item.quantity, 0);

/**
 * The order queue.
 *
 * `GET /api/orders` is customer-scoped by design, so this panel is why
 * `GET /api/admin/orders` exists: without it an operator could see aggregate
 * counts but never reach the individual order they needed to act on, which left
 * cancel, reconcile and refund unreachable even though all three endpoints
 * existed.
 */
export default function OrdersPanel({ report, reload, initialStatus = '' }) {
  const toast = useToast();

  const [status, setStatus] = useState(initialStatus);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [confirm, setConfirm] = useState(null); // { kind: 'cancel' | 'refund', order }
  const [actionBusy, setActionBusy] = useState(false);

  // Jumping here from the Overview may target a different status.
  useEffect(() => {
    setStatus(initialStatus);
    setPage(1);
  }, [initialStatus]);

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const { data: page_ } = await api.adminOrders(
        buildQuery({ status, q: debounced, page, pageSize: PAGE_SIZE }),
      );
      setData(page_);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [status, debounced, page]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (id) => {
    setDetailLoading(true);
    try {
      const { data: body } = await api.adminOrder(id);
      setDetail(body);
    } catch (err) {
      toast.error('Could not load that order', err.message);
      setOpenId(null);
    } finally {
      setDetailLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (openId) loadDetail(openId);
  }, [openId, loadDetail]);

  async function runAction(kind) {
    const order = confirm.order;
    setActionBusy(true);
    try {
      if (kind === 'cancel') {
        await api.cancelOrder(order.id);
        toast.success(
          'Order cancelled',
          `${order.orderNumber} released its stock. Cancelling while awaiting payment implies no refund.`,
        );
      } else if (kind === 'fulfill') {
        await api.fulfillOrder(order.id);
        toast.success(
          'Order fulfilled',
          `${order.orderNumber} has been marked fulfilled.`,
        );
      } else {
        const { data: body } = await api.refundPayment(order.id);
        toast.success(
          body.refund?.alreadyRefunded ? 'Already refunded' : 'Refund recorded',
          `${order.orderNumber} was refunded — the refund itself is idempotent.`,
        );
      }
      await Promise.all([loadList(), loadDetail(order.id), reload()]);
      setConfirm(null);
    } catch (err) {
      toast.error(kind === 'cancel' ? 'Cancel failed' : kind === 'fulfill' ? 'Fulfill failed' : 'Refund failed', err.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function reconcile(order) {
    try {
      const { data: body } = await api.reconcilePayment(order.id);
      const settled = body.data?.order?.status ?? body.order?.status;
      toast.success(
        'Provider asked',
        settled
          ? `The charge settled as ${statusLabel(settled)}.`
          : 'The reconciliation poll returned an update.',
      );
      await Promise.all([loadList(), loadDetail(order.id), reload()]);
    } catch (err) {
      // The common case here is a genuine "nothing is in flight", which is
      // information rather than a failure.
      toast.info('Nothing to reconcile', err.message);
    }
  }

  const counts = report.ordersByStatus ?? {};
  const totalAll = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const order = detail?.order ?? null;
  const attempts = detail?.paymentAttempts ?? [];
  const claims = detail?.idempotencyClaims ?? [];

  const canCancel = order?.status === 'pending_payment';
  const canReconcile = order?.status === 'pending_payment';
  const canFulfill = order?.status === 'paid';
  const canRefund = attempts.some(
    (attempt) => attempt.status === 'succeeded' || attempt.status === 'refund_required',
  );


  return (
    <>
      <Card>
        <div className="tabs" role="tablist" aria-label="Filter orders by status">
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={status === ''}
            onClick={() => {
              setStatus('');
              setPage(1);
            }}
          >
            All
            <span className="tab__count">{totalAll}</span>
          </button>
          {ORDER_STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              className="tab"
              aria-selected={status === value}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
            >
              {statusLabel(value)}
              <span className="tab__count">{counts[value] ?? 0}</span>
            </button>
          ))}
        </div>

        <CardHeader
          title="Order queue"
          subtitle="Newest first. Select a row for the payment attempts, idempotency claims and full transition history."
          icon={ReceiptIcon}
          actions={
            data ? (
              <Badge tone="neutral">
                {data.total} order{data.total === 1 ? '' : 's'}
              </Badge>
            ) : null
          }
        />
        <CardBody>
          <div className="toolbar">
            <div className="toolbar__search">
              <TextField
                aria-label="Search orders by order number or customer"
                placeholder="Search order number or customer…"
                icon={SearchIcon}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>
        </CardBody>

        {error ? (
          <CardBody>
            <Alert tone="danger" title="Could not load the queue">
              {error.message}
            </Alert>
          </CardBody>
        ) : loading ? (
          <SkeletonTableRows rows={6} cols={6} />
        ) : data.items.length === 0 ? (
          <CardBody>
            <EmptyState
              icon={ReceiptIcon}
              title={debounced ? `No orders match “${debounced}”` : 'No orders in this view'}
              body={
                debounced
                  ? 'Search matches the order number or the customer who placed it.'
                  : 'Nothing has been placed in this state yet.'
              }
            />
          </CardBody>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="table table--hover table--clickable">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
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
                  {data.items.map((row) => (
                    <tr key={row.id} onClick={() => setOpenId(row.id)}>
                      <td>
                        <span className="table__primary mono">{row.orderNumber}</span>
                      </td>
                      <td className="text-muted">
                        {row.customer ? (
                          <span title={row.customer.email}>{row.customer.email}</span>
                        ) : (
                          <span className="text-subtle">customer removed</span>
                        )}
                      </td>
                      <td>
                        <StatusPill status={row.status} />
                      </td>
                      <td className="text-muted">
                        {unitCount(row)} unit{unitCount(row) === 1 ? '' : 's'} ·{' '}
                        {row.items.length} line{row.items.length === 1 ? '' : 's'}
                      </td>
                      <td className="is-numeric">{formatMinor(row.pricing.totalMinor)}</td>
                      <td className="text-muted" title={formatDate(row.createdAt)}>
                        {formatRelative(row.createdAt)}
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

            {data.totalPages > 1 ? (
              <div className="pager">
                <span className="pager__label">
                  Page {data.page} of {data.totalPages} · {data.total} orders
                </span>
                <div className="cluster">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={page <= 1}
                    onClick={() => setPage((n) => Math.max(1, n - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    disabled={page >= data.totalPages}
                    onClick={() => setPage((n) => n + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </CardBody>
        )}
      </Card>

      <Drawer
        open={openId !== null}
        onClose={() => {
          setOpenId(null);
          setDetail(null);
        }}
        title={order ? order.orderNumber : 'Order'}
        subtitle={order ? `Placed ${formatRelative(order.createdAt)}` : ''}
        footer={
          order ? (
            <>
              {canFulfill ? (
                <Button
                  variant="primary"
                  onClick={() => setConfirm({ kind: 'fulfill', order })}
                  disabled={actionBusy}
                >
                  Mark as fulfilled
                </Button>
              ) : null}
              {canReconcile ? (
                <Button
                  variant="default"
                  onClick={() => reconcile(order)}
                  disabled={actionBusy}
                >
                  Ask the provider
                </Button>
              ) : null}
              {canCancel ? (
                <Button
                  variant="danger"
                  onClick={() => setConfirm({ kind: 'cancel', order })}
                  disabled={actionBusy}
                >
                  Cancel order
                </Button>
              ) : null}
              {canRefund ? (
                <Button
                  variant={canFulfill ? 'default' : 'primary'}
                  onClick={() => setConfirm({ kind: 'refund', order })}
                  disabled={actionBusy}
                >
                  Refund
                </Button>
              ) : null}
              {!canCancel && !canRefund && !canReconcile && !canFulfill ? (
                <span className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                  This order is settled — no operator action applies.
                </span>
              ) : null}
            </>
          ) : null
        }
      >
        {detailLoading && !detail ? (
          <LoadingRow label="Loading the order…" />
        ) : order ? (
          <div className="stack">
            <div className="cluster">
              <StatusPill status={order.status} />
              {order.holdsStock ? <Badge tone="accent">holds stock</Badge> : null}
              {order.isTerminal ? <Badge tone="neutral">terminal</Badge> : null}
            </div>

            <KeyValue
              rows={[
                { k: 'Customer', v: order.customer?.email ?? 'customer removed' },
                { k: 'Total', v: formatMinor(order.pricing.totalMinor) },
                ...(order.failureReason ? [{ k: 'Failure reason', v: order.failureReason }] : []),
                {
                  k: 'Reservation expires',
                  v: formatDate(order.reservationExpiresAt),
                },
                {
                  k: 'Payment lease',
                  v: order.paymentLeaseExpiresAt
                    ? formatDate(order.paymentLeaseExpiresAt)
                    : 'not held',
                },
                { k: 'Idempotency key', v: order.idempotencyKey ?? '—' },
              ]}
            />

            <div>
              <p className="field__label">Line items</p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Item</th>
                      <th className="is-numeric">Qty</th>
                      <th className="is-numeric">Unit</th>
                      <th className="is-numeric">Line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => (
                      <tr key={item.sku}>
                        <td className="mono">{item.sku}</td>
                        <td className="table__primary">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={item.name}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                style={{ width: 28, height: 28, borderRadius: 'var(--r-xs)', objectFit: 'cover', display: 'block' }}
                              />
                            ) : null}
                            <span>{item.name}</span>
                          </div>
                        </td>
                        <td className="is-numeric">{item.quantity}</td>
                        <td className="is-numeric text-muted">
                          {formatMinor(item.unitPriceMinor)}
                        </td>
                        <td className="is-numeric">{formatMinor(item.lineTotalMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="summary-panel">
                <div className="totals">
                  <span className="totals__label">Subtotal</span>
                  <span className="totals__value">{formatMinor(order.pricing.subtotalMinor)}</span>
                </div>
                {order.pricing.discountMinor > 0 ? (
                  <div className="totals totals--discount">
                    <span className="totals__label">Discount</span>
                    <span className="totals__value">
                      −{formatMinor(order.pricing.discountMinor)}
                    </span>
                  </div>
                ) : null}
                <div className="totals">
                  <span className="totals__label">Tax</span>
                  <span className="totals__value">{formatMinor(order.pricing.taxMinor)}</span>
                </div>
                <div className="totals">
                  <span className="totals__label">Shipping</span>
                  <span className="totals__value">{formatMinor(order.pricing.shippingMinor)}</span>
                </div>
                <div className="totals totals--grand">
                  <span className="totals__label">Charged</span>
                  <span className="totals__value">{formatMinor(order.pricing.totalMinor)}</span>
                </div>
              </div>
            </div>

            <div>
              <p className="field__label">Payment attempts</p>
              {attempts.length === 0 ? (
                <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                  No charge was ever attempted for this order.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th className="is-numeric">Amount</th>
                        <th>Provider ref</th>
                        <th>Code</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.map((attempt) => (
                        <tr key={attempt.id}>
                          <td>
                            <Badge tone={paymentTone(attempt.status)}>
                              {humanise(attempt.status)}
                            </Badge>
                          </td>
                          <td className="is-numeric">{formatMinor(attempt.amountMinor)}</td>
                          <td className="mono text-muted">{attempt.providerRef ?? '—'}</td>
                          <td className="mono text-muted">
                            {attempt.providerCode ?? attempt.providerMessage ?? '—'}
                          </td>
                          <td className="text-muted">{formatRelative(attempt.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <p className="field__label">Idempotency claims</p>
              {claims.length === 0 ? (
                <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                  This order was not created through a keyed checkout request.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Key</th>
                        <th>Status</th>
                        <th className="is-numeric">Attempts</th>
                        <th className="is-numeric">Takeovers</th>
                        <th>Recorded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claims.map((claim) => (
                        <tr key={claim.id}>
                          <td className="mono">{claim.key}</td>
                          <td>
                            <Badge
                              tone={
                                claim.status === 'completed'
                                  ? 'success'
                                  : claim.status === 'processing'
                                    ? 'warning'
                                    : 'neutral'
                              }
                            >
                              {humanise(claim.status)}
                            </Badge>
                          </td>
                          <td className="is-numeric">{claim.attempts}</td>
                          <td className="is-numeric">
                            {claim.takeoverCount > 0 ? (
                              <Badge tone="warning">{claim.takeoverCount}</Badge>
                            ) : (
                              <span className="text-subtle">0</span>
                            )}
                          </td>
                          <td className="text-muted">{formatRelative(claim.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <OrderTimeline order={order} attempts={attempts} claims={claims} />
          </div>
        ) : (
          <LoadingRow label="Loading the order…" />
        )}
      </Drawer>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => runAction(confirm.kind)}
        busy={actionBusy}
        tone={confirm?.kind === 'cancel' ? 'danger' : 'primary'}
        confirmLabel={
          confirm?.kind === 'cancel'
            ? 'Cancel the order'
            : confirm?.kind === 'fulfill'
              ? 'Mark as fulfilled'
              : 'Refund it'
        }
        title={
          confirm?.kind === 'cancel'
            ? 'Cancel this order?'
            : confirm?.kind === 'fulfill'
              ? 'Fulfill this order?'
              : 'Refund this charge?'
        }
        body={
          confirm?.kind === 'cancel'
            ? `${confirm.order.orderNumber} is awaiting payment, so cancelling releases its reserved stock without implying a refund.`
            : confirm?.kind === 'fulfill'
              ? `${confirm?.order?.orderNumber} is paid and ready for dispatch. Marking fulfilled completes its operational lifecycle.`
              : `${confirm?.order?.orderNumber}: the provider is asked to refund ${formatMinor(
                  confirm?.order?.pricing.totalMinor ?? 0,
                )}. The operation is idempotent — refunding twice reports that it was already refunded rather than paying out again.`
        }
      />
    </>
  );
}

function OrderTimeline({ order, attempts = [], claims = [] }) {
  const steps = [];

  // 1. Ingestion & Idempotency
  const primaryClaim = claims[0];
  steps.push({
    key: 'ingestion',
    title: '1. Ingestion & Idempotency Check',
    state: 'done',
    badge: primaryClaim ? `Key: ${primaryClaim.key.slice(0, 8)}…` : 'Direct Request',
    tone: 'neutral',
    detail: primaryClaim
      ? `Claim status: ${primaryClaim.status} · Attempts: ${primaryClaim.attempts} · Takeovers: ${primaryClaim.takeoverCount}`
      : 'Order submitted directly without idempotency key',
  });

  // 2. Pricing Snapshot & Reservation (TX1)
  const totalUnits = order.items.reduce((s, i) => s + i.quantity, 0);
  steps.push({
    key: 'tx1',
    title: '2. Pricing Snapshot & Reservation (TX1)',
    state: 'done',
    badge: 'Stock Reserved',
    tone: 'accent',
    detail: `${totalUnits} units reserved across ${order.items.length} SKU(s). Hold expires at ${formatDate(order.reservationExpiresAt)}`,
  });

  // 3. Payment Lease (Mid-flight reaper guard)
  if (order.paymentLeaseExpiresAt || attempts.length > 0) {
    const isLeaseActive =
      order.paymentLeaseExpiresAt && new Date(order.paymentLeaseExpiresAt) > new Date();
    steps.push({
      key: 'lease',
      title: '3. Payment Lease Acquisition (ADR-08)',
      state: isLeaseActive ? 'active' : 'done',
      badge: isLeaseActive ? 'Lease Active' : 'Lease Released',
      tone: isLeaseActive ? 'warning' : 'neutral',
      detail: isLeaseActive
        ? `Mid-flight protection held until ${formatDate(order.paymentLeaseExpiresAt)}. Reaper will not expire this order while charge is in flight.`
        : 'Payment lease acquired and safely released upon settlement.',
    });
  }

  // 4. Payment Gateway Attempts
  if (attempts.length > 0) {
    attempts.forEach((att, idx) => {
      const isSuccess = att.status === 'succeeded';
      const isFailed = att.status === 'declined' || att.status === 'failed';
      steps.push({
        key: `attempt-${att.id || idx}`,
        title: `4.${idx + 1} Gateway Charge (${att.provider})`,
        state: isSuccess ? 'done' : isFailed ? 'failed' : 'active',
        badge: att.status.toUpperCase(),
        tone: isSuccess ? 'success' : isFailed ? 'danger' : 'warning',
        detail: `Amount: ${formatMinor(att.amountMinor)} · Ref: ${att.providerRef || 'none'} · Latency: ${att.latencyMs ?? '—'}ms ${att.providerMessage ? `· ${att.providerMessage}` : ''}`,
      });
    });
  }

  // 5. Status Transitions (CAS TX2 / TX3)
  if (order.statusHistory?.length) {
    order.statusHistory.forEach((hist, idx) => {
      const isCurrent = hist.to === order.status;
      const isPaid = hist.to === 'paid';
      const isFulfilled = hist.to === 'fulfilled';
      const isCompensated = ['payment_failed', 'expired', 'cancelled'].includes(hist.to);

      steps.push({
        key: `transition-${idx}`,
        title: `Transition: ${hist.from === 'none' ? 'Created' : statusLabel(hist.from)} → ${statusLabel(hist.to)}`,
        state: isCurrent ? 'active' : 'done',
        badge: isPaid
          ? 'Stock Committed (TX2)'
          : isCompensated
            ? 'Stock Released (TX3)'
            : isFulfilled
              ? 'Fulfilled'
              : hist.to,
        tone: isPaid || isFulfilled ? 'success' : isCompensated ? 'danger' : 'neutral',
        detail: `Actor: ${hist.actor} · Reason: ${hist.reason ?? '—'} · ${formatDate(hist.at)}`,
      });
    });
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--sp-2)',
        }}
      >
        <p className="field__label" style={{ margin: 0 }}>
          Saga & State Audit Trail
        </p>
        <span className="text-subtle" style={{ fontSize: 'var(--fs-2xs)' }}>
          Distributed Invariant Protected
        </span>
      </div>
      <div className="steps">
        {steps.map((s) => (
          <div className={`step step--${s.state}`} key={s.key}>
            <span className="step__marker" aria-hidden="true" />
            <div className="step__text" style={{ width: '100%' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--sp-2)',
                }}
              >
                <span className="step__title">{s.title}</span>
                {s.badge ? <Badge tone={s.tone}>{s.badge}</Badge> : null}
              </div>
              <div className="step__detail" style={{ marginTop: '2px' }}>
                {s.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

