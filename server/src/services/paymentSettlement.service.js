import { withTransaction } from '../db/transaction.js';
import { capture, release } from '../domain/inventory.js';
import { transition } from '../domain/orderState.js';
import { ORDER_STATUS } from '../domain/orderStatus.js';
import { presentOrder } from '../domain/presentation.js';
import { logger } from '../lib/logger.js';
import { IdempotencyKey, IDEMPOTENCY_STATUS } from '../models/IdempotencyKey.js';
import { Order } from '../models/Order.js';
import { PaymentAttempt, PAYMENT_STATUS } from '../models/PaymentAttempt.js';
import { getGateway } from './payments/index.js';

const holdLines = (order) =>
  order.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
  }));

/**
 * Upserted, not plain-updated.
 *
 * In the normal flow the attempt already exists because checkout writes it
 * before calling the gateway. But the refund-obligation path is the one place
 * where MONEY HAS MOVED and the database must not be able to lose the record of
 * it: if the row were missing, a plain update would silently match nothing and
 * the obligation would vanish. Upserting makes that impossible.
 */
async function setAttempt(order, patch) {
  await PaymentAttempt.updateOne(
    { provider: getGateway().provider, idempotencyKey: String(order._id) },
    {
      $set: patch,
      $setOnInsert: {
        orderId: order._id,
        amountMinor: order.pricing.totalMinor,
        currency: order.currency,
      },
    },
    { upsert: true },
  );
}

function isAlreadyPaid(order) {
  return (
    Boolean(order) &&
    (order.status === ORDER_STATUS.PAID || order.status === ORDER_STATUS.FULFILLED)
  );
}

/**
 * TX2 — apply a confirmed charge.
 *
 * The first action is a compare-and-swap on the order status. Three outcomes:
 *
 *  a) It matches  -> the order is paid, the hold is converted into a sale, and
 *     the idempotency claim is completed IN THE SAME TRANSACTION, so "the order
 *     exists" and "the key is spent" can never disagree.
 *
 *  b) It loses because the order is ALREADY PAID -> a duplicate webhook, or a
 *     retry of a successful checkout. This is a no-op. The charge is legitimate
 *     and the order is fulfilled; treating it as unfulfillable would invent a
 *     refund for a perfectly good order.
 *
 *  c) It loses because the order EXPIRED or was CANCELLED -> the customer's money
 *     was taken for something we cannot fulfil. That is recorded as an explicit
 *     REFUND OBLIGATION rather than swallowed (ADR-08).
 */
export async function settleSuccess({ orderId, providerRef = null, source = 'gateway' }) {
  const order = await Order.findById(orderId);
  if (!order) throw new Error(`settleSuccess: order ${orderId} not found`);

  const result = await withTransaction(async (session) => {
    const paid = await transition(
      orderId,
      ORDER_STATUS.PENDING_PAYMENT,
      ORDER_STATUS.PAID,
      {
        reason: `payment_approved:${source}`,
        actor: source,
        'payment.status': PAYMENT_STATUS.SUCCEEDED,
        'payment.providerRef': providerRef,
        paymentLeaseExpiresAt: null,
      },
      session,
    );
    if (!paid) return { lost: true };

    await capture(holdLines(order), session);

    await IdempotencyKey.updateOne(
      { orderId },
      {
        $set: {
          status: IDEMPOTENCY_STATUS.COMPLETED,
          leaseExpiresAt: new Date(),
          'response.statusCode': 201,
        },
      },
      { session },
    );

    return { lost: false, order: paid };
  });

  if (!result.lost) {
    await setAttempt(order, {
      status: PAYMENT_STATUS.SUCCEEDED,
      providerRef,
      providerCode: null,
      providerMessage: null,
    });
    return { lost: false, order: result.order, ...presentOrder(result.order) };
  }

  const current = await Order.findById(orderId);

  // (b) Already paid: idempotent no-op.
  if (isAlreadyPaid(current)) {
    logger.info('ignoring a duplicate successful payment for an already paid order', {
      orderId: String(orderId),
      source,
    });
    const patch = { status: PAYMENT_STATUS.SUCCEEDED };
    if (providerRef) patch.providerRef = providerRef;
    await setAttempt(current, patch);
    return { lost: true, alreadyPaid: true, ...presentOrder(current, { replayed: true }) };
  }

  // (c) Charged for an order we cannot fulfil.
  logger.error('charged for an order that was already settled — refund required', {
    orderId: String(orderId),
    orderStatus: current?.status ?? null,
    source,
  });
  await setAttempt(current, {
    status: PAYMENT_STATUS.REFUND_REQUIRED,
    providerRef,
    providerCode: 'settled_elsewhere',
    providerMessage: 'Charged for an order that was already settled; refund required',
  });
  // Leave the claim retryable rather than pinning the client behind a key that
  // can never resolve.
  await IdempotencyKey.updateOne(
    { orderId },
    {
      $set: {
        status: IDEMPOTENCY_STATUS.FAILED,
        leaseExpiresAt: new Date(),
        'response.statusCode': 409,
      },
    },
  );

  return {
    lost: true,
    refundRequired: true,
    statusCode: 409,
    body: {
      error: {
        code: 'ORDER_NOT_PENDING',
        message:
          'The order was settled before this payment completed; a refund has been recorded',
        details: {
          orderId: String(orderId),
          orderStatus: current?.status ?? null,
          refundObligation: true,
          retryable: true,
        },
      },
    },
  };
}

/**
 * TX3 — apply a decline or a provider error: fail the order and RELEASE the
 * reservation, so the units go back on sale immediately.
 *
 * A late or duplicated decline for an order that is ALREADY PAID is ignored: it
 * must not release stock for a sale that succeeded, nor overwrite a successful
 * charge record.
 */
export async function settleFailure({ orderId, outcome = {}, source = 'gateway' }) {
  const order = await Order.findById(orderId);
  if (!order) throw new Error(`settleFailure: order ${orderId} not found`);

  const declined = outcome.status === 'declined';
  const nextPaymentStatus = declined ? PAYMENT_STATUS.DECLINED : PAYMENT_STATUS.ERROR;
  const attemptPatch = {
    status: nextPaymentStatus,
    providerRef: outcome.providerRef ?? null,
    providerCode: outcome.providerCode ?? null,
    providerMessage: outcome.providerMessage ?? null,
  };

  const result = await withTransaction(async (session) => {
    const failed = await transition(
      orderId,
      ORDER_STATUS.PENDING_PAYMENT,
      ORDER_STATUS.PAYMENT_FAILED,
      {
        reason: `payment_${nextPaymentStatus}:${source}`,
        actor: source,
        failureReason: outcome.providerCode ?? nextPaymentStatus,
        'payment.status': nextPaymentStatus,
        'payment.providerRef': outcome.providerRef ?? null,
        'payment.lastError': outcome.providerMessage ?? null,
        paymentLeaseExpiresAt: null,
      },
      session,
    );
    if (!failed) return { lost: true };

    await release(holdLines(order), session);

    await IdempotencyKey.updateOne(
      { orderId },
      {
        $set: {
          status: IDEMPOTENCY_STATUS.FAILED,
          leaseExpiresAt: new Date(),
          'response.statusCode': 402,
        },
      },
      { session },
    );

    return { lost: false, order: failed };
  });

  if (!result.lost) {
    await setAttempt(order, attemptPatch);
    return { lost: false, order: result.order, ...presentOrder(result.order) };
  }

  const current = await Order.findById(orderId);

  if (isAlreadyPaid(current)) {
    logger.warn('ignoring a decline for an already paid order', {
      orderId: String(orderId),
      source,
    });
    return { lost: true, ignored: true, ...presentOrder(current, { replayed: true }) };
  }

  await setAttempt(current, attemptPatch);
  return { lost: true, ...presentOrder(current) };
}

/**
 * Shared entry point for out-of-band resolutions — the webhook and the
 * reconciliation poll both call this, so both apply identical, idempotent
 * transitions and neither can take a route the inline saga would not.
 */
export async function settlePaymentOutcome({
  orderId,
  status,
  providerRef = null,
  providerMessage = null,
  source = 'webhook',
}) {
  if (status === 'succeeded') {
    return settleSuccess({ orderId, providerRef, source });
  }
  return settleFailure({
    orderId,
    source,
    outcome: {
      status: status === 'declined' ? 'declined' : 'error',
      providerRef,
      providerCode: status === 'declined' ? 'card_declined' : 'provider_error',
      providerMessage: providerMessage ?? 'Resolved asynchronously',
    },
  });
}
