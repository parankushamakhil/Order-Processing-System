import { useState } from 'react';
import { BagIcon, CartIcon, ShieldIcon, TrashIcon } from '../components/icons.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  SelectField,
  Stepper,
  monogram,
  productTileStyle,
} from '../components/ui.jsx';
import { useCheckout } from '../hooks/useCheckout.js';
import { formatMinor } from '../lib/format.js';
import { useAuth } from '../state/AuthContext.jsx';
import { useCart } from '../state/CartContext.jsx';

/** Mirrors the server's rules so the buyer sees a figure before committing. */
const DISCOUNTS = {
  SAVE10: { type: 'percentage', bps: 1000 },
  SAVE25: { type: 'percentage', bps: 2500 },
  FLAT5: { type: 'fixed', minor: 500 },
};

function halfUp(value) {
  return Math.floor(value + 0.5);
}

function estimate(subtotalMinor, code) {
  const rule = code ? DISCOUNTS[code] : null;
  const raw = rule
    ? rule.type === 'percentage'
      ? halfUp((subtotalMinor * rule.bps) / 10_000)
      : rule.minor
    : 0;
  const discountMinor = Math.max(0, Math.min(raw, subtotalMinor));
  const taxable = subtotalMinor - discountMinor;
  const taxMinor = halfUp((taxable * 800) / 10_000);
  const shippingMinor = taxable === 0 || taxable >= 5000 ? 0 : 599;
  return { discountMinor, taxMinor, shippingMinor, totalMinor: taxable + taxMinor + shippingMinor };
}

/** What each failure means for the buyer, and whether retrying is safe. */
function explainError(err) {
  switch (err.code) {
    case 'OUT_OF_STOCK':
      return {
        title: 'Not enough stock',
        summary: 'Another buyer took the last units while this cart was open.',
        retry: 'Retryable with the same key once stock returns.',
      };
    case 'PRICE_CHANGED':
      return {
        title: 'Prices changed while you were shopping',
        summary: 'The server recalculated the cart from the catalogue. It never charges a figure it did not quote.',
        retry: 'The key was released, so retrying starts cleanly.',
      };
    case 'PAYMENT_DECLINED':
      return {
        title: 'Payment declined',
        summary: 'The reserved stock has already been released back onto sale.',
        retry: 'The key is kept, so retrying recovers this checkout rather than starting a rival one.',
      };
    case 'PAYMENT_FAILED':
      return {
        title: 'The payment provider failed',
        summary: 'Nothing was captured and the reserved stock was released.',
        retry: 'Retryable with the same key.',
      };
    case 'CHECKOUT_IN_PROGRESS':
      return {
        title: 'An identical checkout is already running',
        summary: 'A duplicate submission is in flight; this one was not executed.',
        retry: 'Retry-After was sent, and the same key coalesces onto the original result.',
      };
    case 'IDEMPOTENCY_KEY_REUSE':
      return {
        title: 'This key belongs to a different cart',
        summary: 'The cart changed after the key was issued, so the server refused to return an unrelated order.',
        retry: 'Change the cart to issue a new key.',
      };
    case 'ORDER_EXPIRED':
      return {
        title: 'The reservation expired',
        summary: 'The hold lapsed and the stock went back on sale.',
        retry: 'Retryable with the same key.',
      };
    default:
      return { title: err.code ?? 'Something went wrong', summary: err.message };
  }
}

export default function CartPage({ onBrowse }) {
  const { user } = useAuth();
  const toast = useToast();
  const {
    lines,
    subtotalMinor,
    discountCode,
    setDiscountCode,
    setQuantity,
    remove,
    count,
  } = useCart();
  const { submit, busy, error, result } = useCheckout();
  const [autoRetry, setAutoRetry] = useState(0);

  const totals = estimate(subtotalMinor, discountCode);

  async function doCheckout(attempt = 0) {
    const outcome = await submit();
    if (outcome.ok) {
      if (outcome.replayed) {
        toast.info('Replayed from the idempotency record', 'Nothing was executed a second time.');
      } else if (outcome.order?.status === 'pending_payment') {
        toast.warning(
          'Payment outcome unknown',
          'The gateway did not answer. The order is tracking until it settles.',
        );
      } else {
        toast.success(
          `Order ${outcome.order?.orderNumber ?? ''} confirmed`,
          `${formatMinor(outcome.order?.pricing?.totalMinor ?? 0)} charged.`,
        );
      }
      setAutoRetry(0);
      return;
    }

    const code = outcome.error?.code;
    if (code === 'CHECKOUT_IN_PROGRESS' && attempt < 3) {
      const next = attempt + 1;
      setAutoRetry(next);
      setTimeout(() => doCheckout(next), 500 * next);
      return;
    }
    setAutoRetry(0);
    toast.error(explainError(outcome.error).title, outcome.error?.message);
  }

  if (count === 0 && !result) {
    return (
      <>
        {/* The empty state below already says the cart is empty; a heading plus
            "Nothing here yet" would be the third time. */}
        <Card>
          <EmptyState
            icon={CartIcon}
            title="Your cart is empty"
            body="Add something from the catalogue and it will appear here, priced with live availability."
            actions={
              <Button variant="primary" icon={BagIcon} onClick={onBrowse}>
                Browse the catalogue
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head__text">
          <p className="page-head__sub">
            Totals are an estimate — the server recalculates from the catalogue at checkout.
          </p>
        </div>
        <div className="page-head__actions">
          {count > 0 ? <Badge tone="neutral">{count} item{count === 1 ? '' : 's'}</Badge> : null}
        </div>
      </div>

      <div className="checkout-layout">
        <div className="stack">
          <Card>
            <CardHeader title="Items" subtitle={`${lines.length} line${lines.length === 1 ? '' : 's'}`} />
            <CardBody flush>
              {lines.map((line) => (
                <div className="line-item" key={line.productId}>
                  <span className="line-item__thumb tile" style={line.imageUrl ? { overflow: 'hidden', padding: 0 } : productTileStyle(line.sku)}>
                    {line.imageUrl ? (
                      <img
                        src={line.imageUrl}
                        alt={line.name}
                        referrerPolicy="no-referrer"
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                    ) : (
                      <span aria-hidden="true" style={{ fontSize: 15 }}>
                        {monogram(line.name)}
                      </span>
                    )}
                  </span>

                  <div style={{ minWidth: 0 }}>
                    <p className="line-item__name">{line.name}</p>
                    <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                      {formatMinor(line.priceMinor)} each
                    </p>
                  </div>

                  <Stepper
                    value={line.quantity}
                    onChange={(next) => setQuantity(line.productId, next)}
                    min={1}
                    max={99}
                    label={`Quantity for ${line.name}`}
                  />

                  <div className="cluster" style={{ justifyContent: 'flex-end' }}>
                    <span className="line-item__line-total">
                      {formatMinor(line.priceMinor * line.quantity)}
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon btn--sm"
                      onClick={() => {
                        remove(line.productId);
                        toast.info(`Removed ${line.name}`);
                      }}
                      aria-label={`Remove ${line.name}`}
                      title="Remove"
                    >
                      <TrashIcon size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>

        <div className="stack">
          <div className="summary-panel stack">
            <Card>
              <CardHeader title="Order summary" />
              <CardBody>
                <div style={{ marginBottom: 'var(--sp-4)' }}>
                  <SelectField
                    label="Discount code"
                    value={discountCode ?? ''}
                    onChange={(event) => setDiscountCode(event.target.value || null)}
                  >
                    <option value="">None</option>
                    <option value="SAVE10">SAVE10 — 10% off</option>
                    <option value="SAVE25">SAVE25 — 25% off</option>
                    <option value="FLAT5">FLAT5 — $5.00 off</option>
                  </SelectField>
                </div>

                <div className="totals">
                  <span className="totals__label">Subtotal</span>
                  <span className="totals__value">{formatMinor(subtotalMinor)}</span>
                </div>
                {totals.discountMinor > 0 ? (
                  <div className="totals totals--discount">
                    <span className="totals__label">Discount</span>
                    <span className="totals__value">−{formatMinor(totals.discountMinor)}</span>
                  </div>
                ) : null}
                <div className="totals">
                  <span className="totals__label">Tax (8%)</span>
                  <span className="totals__value">{formatMinor(totals.taxMinor)}</span>
                </div>
                <div className="totals">
                  <span className="totals__label">Shipping</span>
                  <span className="totals__value">
                    {totals.shippingMinor === 0 ? 'Free' : formatMinor(totals.shippingMinor)}
                  </span>
                </div>
                <div className="totals totals--grand">
                  <span>Total</span>
                  <span className="totals__value">{formatMinor(totals.totalMinor)}</span>
                </div>

                <div style={{ marginTop: 'var(--sp-4)' }}>
                  <Button
                    variant="primary"
                    size="lg"
                    block
                    loading={busy}
                    disabled={!user}
                    onClick={() => doCheckout(0)}
                    icon={ShieldIcon}
                  >
                    {busy
                      ? 'Processing…'
                      : autoRetry
                        ? `Retrying (${autoRetry}/3)…`
                        : `Pay ${formatMinor(totals.totalMinor)}`}
                  </Button>
                  {!user ? (
                    <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)', marginTop: 8 }}>
                      Sign in to check out.
                    </p>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      </div>

      {result || error ? (
        <div className="stack" style={{ marginTop: 'var(--sp-5)' }}>
          {result ? (
            <Card>
              <CardHeader
                title={result.pending ? 'Payment outcome unknown' : 'Order confirmed'}
                subtitle={result.order.orderNumber}
                actions={
                  <>
                    {result.replayed ? <Badge tone="warning">Replayed</Badge> : null}
                    <Badge tone={result.pending ? 'warning' : 'success'} dot>
                      {result.pending ? 'Awaiting provider' : 'Paid'}
                    </Badge>
                  </>
                }
              />
              <CardBody>
                {result.replayed ? (
                  <Alert tone="info" title="Nothing was executed twice">
                    This response came from the idempotency record, so the original result was replayed
                    rather than the order being created again.
                  </Alert>
                ) : null}
                {result.pending ? (
                  <Alert tone="warning" title="The gateway accepted the charge and went silent">
                    The hold is still in place. The outcome will be resolved by the provider webhook, or
                    the stock will be released when the reservation lapses. Track it on the Orders page.
                  </Alert>
                ) : null}
                <div className="totals totals--grand" style={{ marginTop: 'var(--sp-4)' }}>
                  <span>{result.pending ? 'Authorised (not yet settled)' : 'Charged'}</span>
                  <span className="totals__value">
                    {formatMinor(result.order.pricing.totalMinor)}
                  </span>
                </div>
                <div className="cluster" style={{ marginTop: 'var(--sp-4)' }}>
                  <Button variant="default" icon={BagIcon} onClick={onBrowse}>
                    Continue shopping
                  </Button>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {error ? (
            <Card>
              <CardHeader
                title={explainError(error).title}
                subtitle={`HTTP ${error.status} · ${error.code}${error.retryable ? ' · retryable' : ' · not retryable'}`}
                actions={
                  <Badge tone={error.retryable ? 'warning' : 'danger'}>
                    {error.retryable ? 'Safe to retry' : 'Needs a fix'}
                  </Badge>
                }
              />
              <CardBody>
                <Alert tone={error.retryable ? 'warning' : 'danger'} icon={false}>
                  <p>{explainError(error).summary}</p>
                  {explainError(error).retry ? <p>{explainError(error).retry}</p> : null}
                </Alert>

                {error.code === 'OUT_OF_STOCK' && error.details?.items?.length ? (
                  <div className="table-wrap" style={{ marginTop: 'var(--sp-4)' }}>
                    <table className="table table--hover">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th className="is-numeric">Requested</th>
                          <th className="is-numeric">Available now</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {error.details.items.map((item) => (
                          <tr key={item.productId}>
                            <td className="table__primary">{item.sku ?? item.productId}</td>
                            <td className="is-numeric">{item.requested}</td>
                            <td className="is-numeric">{item.available}</td>
                            <td className="text-muted">
                              {(item.reason ?? '').replace(/_/g, ' ') || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {error.code === 'PRICE_CHANGED' && error.details?.pricing ? (
                  <div className="stack-sm" style={{ marginTop: 'var(--sp-4)' }}>
                    <div className="totals totals--grand">
                      <span>Authoritative total</span>
                      <span className="totals__value">
                        {formatMinor(error.details.pricing.totalMinor)}
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="cluster" style={{ marginTop: 'var(--sp-4)' }}>
                  <Button
                    variant="primary"
                    loading={busy}
                    onClick={() => doCheckout(0)}
                    disabled={!error.retryable}
                  >
                    {error.retryable ? 'Try again' : 'Fix the cart first'}
                  </Button>
                  <Button variant="default" icon={BagIcon} onClick={onBrowse}>
                    Back to catalogue
                  </Button>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

