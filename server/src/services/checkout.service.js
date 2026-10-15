import { CHECKOUT_ENDPOINT, config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import { describeAvailability, reserve } from '../domain/inventory.js';
import { ORDER_STATUS } from '../domain/orderStatus.js';
import { presentOrder } from '../domain/presentation.js';
import { priceOrder, TAX_RATE_BPS } from '../domain/pricing.js';
import {
  AppError,
  CheckoutInProgressError,
  IdempotencyKeyReuseError,
  InsufficientStockError,
  isReleasable,
  PriceChangedError,
  ProductNotFoundError,
} from '../errors/index.js';
import { logger } from '../lib/logger.js';
import {
  IdempotencyKey,
  IDEMPOTENCY_STATUS,
  nextOrderNumber,
  Order,
  PaymentAttempt,
  PAYMENT_STATUS,
  Product,
} from '../models/index.js';
import { sweepExpiredReservations } from './expiry.service.js';
import {
  buildRequestHash,
  canonicalizeItems,
  claimIdempotency,
  takeOverClaim,
  waitForTerminal,
} from './idempotency.service.js';
import { settleFailure, settleSuccess } from './paymentSettlement.service.js';
import { GatewayTimeoutError, getGateway } from './payments/index.js';

/**
 * POST /api/checkout — the saga.
 *
 * Shape of the thing:
 *   CLAIM -> price -> TX1 (reserve + create order) -> CHARGE -> TX2/TX3 (settle)
 *
 * Payment is a genuinely external side effect, so it CANNOT be inside the
 * database transaction: a transaction callback can be re-run after a transient
 * error, and re-running a card charge is not acceptable. Instead each step is
 * compensable, and the compensation runs through a status compare-and-swap so it
 * happens exactly once (ADR-06).
 *
 * @returns {{ statusCode: number, body: object, replayed: boolean }}
 */
export async function checkout({ customerId, idempotencyKey, input }) {
  const items = canonicalizeItems(input.items);
  const requestHash = buildRequestHash({
    customerId,
    items,
    discountCode: input.discountCode ?? null,
  });

  const claim = await claimIdempotency({
    customerId,
    key: idempotencyKey,
    requestHash,
    endpoint: CHECKOUT_ENDPOINT,
  });

  // Same key, different intent: refuse rather than return someone else's order.
  if (claim.kind === 'conflict') throw new IdempotencyKeyReuseError();

  // Same key, already settled: replay without re-executing anything.
  if (claim.kind === 'replay') return replay(claim.doc);

  // A concurrent duplicate holds the key. Wait briefly for it to finish so
  // double-clicks coalesce onto the winner's response.
  if (claim.kind === 'in_flight') {
    // Wait on the CLAIM, not on its order: the winner may not have created the
    // order yet, but the claim is where the terminal status will be written.
    // (Gating this on `orderId` made every early duplicate fail with a 409 even
    // though the winner was about to succeed — caught by the 50-way test.)
    const settled = await waitForTerminal(claim.doc._id, config.IDEMPOTENCY_WAIT_MS);
    if (settled) return replay(settled);
    throw new CheckoutInProgressError(
      Math.max(1, new Date(claim.doc.leaseExpiresAt).getTime() - Date.now()),
    );
  }

  // 'acquired' | 'takeover' (lapsed or retention-expired) | 'retryable' (failed)
  let record = claim.doc;
  if (claim.kind === 'takeover' || claim.kind === 'retryable') {
    const taken = await takeOverClaim(record._id);
    if (!taken) {
      // Another contender won the takeover. Wait for its result.
      const settled = await waitForTerminal(record._id, config.IDEMPOTENCY_WAIT_MS);
      if (settled) return replay(settled);
      throw new CheckoutInProgressError(config.IDEMPOTENCY_WAIT_MS);
    }
    record = taken;
  }

  try {
    const result = await runCheckout({ customerId, items, input, record, idempotencyKey });
    return { ...result, replayed: false };
  } catch (err) {
    await finalizeFailure(record._id, err);
    throw err;
  }
}

/**
 * Replay (ADR-09): never re-executes anything. For responses that carry an
 * order, the order is re-serialised from CURRENT state, so a checkout that first
 * returned 202 and later succeeded replays as 201 rather than serving a stale
 * "still pending" body.
 */
async function replay(doc) {
  if (!doc) {
    return {
      statusCode: 409,
      body: {
        error: {
          code: 'CHECKOUT_IN_PROGRESS',
          message: 'An identical checkout is still in progress',
          retryable: true,
        },
      },
      replayed: true,
    };
  }

  if (doc.orderId) {
    const order = await Order.findById(doc.orderId);
    if (order) return { ...presentOrder(order, { replayed: true }), replayed: true };
  }

  if (doc.response?.body) {
    return {
      statusCode: doc.response.statusCode ?? 200,
      body: doc.response.body,
      replayed: true,
    };
  }

  return {
    statusCode: doc.response?.statusCode ?? 409,
    body: {
      error: {
        code: 'CHECKOUT_INCOMPLETE',
        message: 'This idempotency key did not produce an order',
        retryable: true,
      },
    },
    replayed: true,
  };
}

async function runCheckout({ customerId, items, input, record, idempotencyKey, attempt = 1 }) {
  // ---- Load the catalogue and price SERVER-SIDE. The client's prices are
  // ---- never read, and never trusted.
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const unavailable = items
    .filter((i) => !byId.has(i.productId) || !byId.get(i.productId).isActive)
    .map((i) => i.productId);
  if (unavailable.length > 0) throw new ProductNotFoundError(unavailable);

  const pricedLines = items.map((i) => {
    const product = byId.get(i.productId);
    return {
      productId: product._id,
      sku: product.sku,
      name: product.name,
      imageUrl: product.imageUrl ?? '',
      quantity: i.quantity,
      unitPriceMinor: product.priceMinor,
    };
  });

  const pricing = priceOrder({
    lines: pricedLines,
    taxRateBps: TAX_RATE_BPS,
    discountCode: input.discountCode ?? null,
  });

  // ---- Fast-fail the doomed (plan §9.1, mitigation 2).
  //
  // A request that obviously cannot be satisfied should not pay the cost of
  // opening a transaction and contending for a write lock on a hot product
  // document. This check is ADVISORY ONLY — correctness still rests entirely on
  // the conditional $inc inside the transaction, which re-checks atomically.
  //
  // It is also where a lapsed hold gets its chance: stock squatting behind a
  // crashed checkout is reclaimed here, on demand, and the request then proceeds.
  await fastFailIfUnavailable({ pricedLines, byId });

  // The cart the customer saw is stale. Tell them, with the authoritative
  // figures, instead of charging a different amount than they agreed to.
  if (input.expectedTotalMinor != null && input.expectedTotalMinor !== pricing.totalMinor) {
    throw new PriceChangedError(pricing);
  }

  // ---- Resume an interrupted attempt rather than reserving twice.
  // A crashed process can leave a claim that already owns a reservation; reusing
  // that order is what stops a retry from holding the same stock twice.
  if (record.orderId) {
    const prior = await Order.findById(record.orderId);
    if (prior) {
      if (prior.status === ORDER_STATUS.PENDING_PAYMENT) {
        logger.info('resuming an interrupted checkout', { orderId: String(prior._id) });
        return chargeAndSettle({
          order: await extendHold(prior),
          record,
          paymentMethod: input.paymentMethod,
        });
      }
      if (prior.status === ORDER_STATUS.PAID || prior.status === ORDER_STATUS.FULFILLED) {
        await IdempotencyKey.updateOne(
          { _id: record._id },
          {
            $set: {
              status: IDEMPOTENCY_STATUS.COMPLETED,
              leaseExpiresAt: new Date(),
              'response.statusCode': 201,
            },
          },
        );
        return { ...presentOrder(prior, { replayed: true }), replayed: true };
      }
      // Terminal and unfulfilled: fall through and start a fresh order.
    }
  }

  // ---- TX1: reserve + create the order atomically.
  const order = await createOrderWithReservation({
    customerId,
    pricedLines,
    pricing,
    record,
    // The key travels as its own argument from `checkout()`. It is NOT read off
    // `input`: that is the validated request body, whose strict schema has no
    // such field, so reading it here silently wrote `null` on every order and
    // left the forensic breadcrumb permanently empty.
    idempotencyKey,
  });

  return chargeAndSettle({ order, record, paymentMethod: input.paymentMethod });
}

/**
 * TX1. Because `reserve` throws on the first unavailable line, the transaction
 * aborts and EVERY reservation it made is rolled back: a 3-item cart whose third
 * item is out of stock reserves precisely zero units.
 *
 * On insufficient stock we first run a TARGETED reclaim for the products in this
 * cart and retry once (ADR-10). Stock that a crashed checkout is squatting on
 * comes back at the moment someone needs it, not at the next tick of a timer.
 */
async function createOrderWithReservation({ customerId, pricedLines, pricing, record, idempotencyKey }) {
  // Allocated OUTSIDE the transaction so the counter never becomes a hotspot
  // that serialises unrelated checkouts (ADR-11).
  const orderNumber = await nextOrderNumber();
  let lastError = null;

  for (let attempt = 1; attempt <= config.MAX_RESERVE_ATTEMPTS; attempt += 1) {
    try {
      return await withTransaction(async (session) => {
        await reserve(pricedLines, session);

        const now = Date.now();
        const [created] = await Order.create(
          [
            {
              orderNumber,
              customerId,
              status: ORDER_STATUS.PENDING_PAYMENT,
              currency: 'USD',
              items: pricedLines.map((line) => ({
                productId: line.productId,
                sku: line.sku,
                name: line.name,
                imageUrl: line.imageUrl ?? '',
                quantity: line.quantity,
                unitPriceMinor: line.unitPriceMinor,
                lineTotalMinor: line.unitPriceMinor * line.quantity,
              })),
              pricing,
              payment: { provider: getGateway().provider, status: 'none', attempts: 0 },
              reservationExpiresAt: new Date(now + config.RESERVATION_TTL_MS),
              // The payment lease is taken AT CREATION rather than just before
              // the charge. That is a deliberate strengthening of the plan's
              // step 7: it closes the (small) window between this transaction
              // committing and the lease being set, during which the reaper
              // could otherwise expire an order whose payment was imminent.
              paymentLeaseExpiresAt: new Date(now + config.PAYMENT_LEASE_MS),
              idempotencyKey,
              statusHistory: [
                {
                  from: 'none',
                  to: ORDER_STATUS.PENDING_PAYMENT,
                  at: new Date(now),
                  reason: 'checkout_started',
                  actor: 'customer',
                },
              ],
            },
          ],
          { session },
        );

        await IdempotencyKey.updateOne(
          { _id: record._id },
          {
            $set: {
              orderId: created._id,
              leaseExpiresAt: new Date(
                now + config.PAYMENT_LEASE_MS + config.GATEWAY_TIMEOUT_MS,
              ),
            },
          },
          { session },
        );

        return created;
      });
    } catch (err) {
      lastError = err;
      const canRetry =
        err instanceof InsufficientStockError && attempt < config.MAX_RESERVE_ATTEMPTS;

      if (!canRetry) {
        // Enrich with a full per-item report before surfacing it.
        if (err instanceof InsufficientStockError) {
          throw new InsufficientStockError(await describeAvailability(pricedLines));
        }
        throw err;
      }

      logger.info('reservation failed; reclaiming expired holds and retrying once', {
        products: pricedLines.length,
      });
      await sweepExpiredReservations({ productIds: pricedLines.map((l) => l.productId) });
    }
  }

  throw lastError;
}

/**
 * Reclaim-then-retry, once, before giving up — or throw if the stock is
 * genuinely gone. This is what makes the demand path, not the timer, the thing
 * that frees stock a crashed checkout is sitting on (ADR-10).
 */
async function fastFailIfUnavailable({ pricedLines, byId }) {
  if (!config.CHECKOUT_FAST_FAIL) return; // measured off in `npm run bench`

  const short = pricedLines.filter(
    (line) => (byId.get(String(line.productId))?.available ?? 0) < line.quantity,
  );
  if (short.length === 0) return;

  const productIds = short.map((line) => line.productId);
  await sweepExpiredReservations({ productIds });

  const refreshed = await Product.find({ _id: { $in: productIds } })
    .select('available')
    .lean();
  const availableNow = new Map(refreshed.map((p) => [String(p._id), p.available]));

  const stillShort = short.filter(
    (line) => (availableNow.get(String(line.productId)) ?? 0) < line.quantity,
  );

  if (stillShort.length > 0) {
    // Full per-item detail, because "out of stock" with no numbers is unusable.
    throw new InsufficientStockError(await describeAvailability(pricedLines));
  }
}

async function extendHold(order) {
  const now = Date.now();
  const extended = await Order.findOneAndUpdate(
    { _id: order._id, status: ORDER_STATUS.PENDING_PAYMENT },
    {
      $set: {
        reservationExpiresAt: new Date(now + config.RESERVATION_TTL_MS),
        paymentLeaseExpiresAt: new Date(now + config.PAYMENT_LEASE_MS),
      },
    },
    { returnDocument: 'after' },
  );
  return extended ?? order;
}

/** Charge, then hand the outcome to the settlement transactions. */
async function chargeAndSettle({ order, record, paymentMethod }) {
  const gateway = getGateway();
  const orderId = order._id;

  // Upserted rather than created: a RESUMED attempt must reuse its existing
  // payment record. The unique index on {provider, idempotencyKey=orderId} is
  // what guarantees an order is charged at most once, so the second attempt has
  // to find the first rather than insert a rival.
  const attempt = await PaymentAttempt.findOneAndUpdate(
    { provider: gateway.provider, idempotencyKey: String(orderId) },
    {
      $setOnInsert: {
        orderId,
        amountMinor: order.pricing.totalMinor,
        currency: order.currency,
        attempts: 1,
      },
      $set: { status: PAYMENT_STATUS.INITIATED },
    },
    { upsert: true, returnDocument: 'after' },
  );

  let outcome;
  try {
    outcome = await gateway.charge({
      orderId: String(orderId),
      amountMinor: order.pricing.totalMinor,
      currency: order.currency,
      token: paymentMethod.token,
      idempotencyKey: String(orderId),
      timeoutMs: config.GATEWAY_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof GatewayTimeoutError) {
      return handleAmbiguousOutcome({ order, record, providerRef: err.providerRef });
    }
    // A hard provider error is treated as a failed payment, so the reservation
    // is released rather than held by a charge that will never succeed.
    outcome = {
      providerRef: err?.providerRef ?? null,
      status: 'error',
      providerCode: err?.code ?? 'provider_error',
      providerMessage: err?.message ?? 'The payment provider failed',
      latencyMs: null,
    };
    logger.warn('gateway error treated as a failed payment', {
      orderId: String(orderId),
      code: outcome.providerCode,
    });
  }

  await PaymentAttempt.updateOne(
    { _id: attempt._id },
    {
      $set: {
        providerRef: outcome.providerRef ?? null,
        latencyMs: outcome.latencyMs ?? null,
        providerCode: outcome.providerCode ?? null,
        providerMessage: outcome.providerMessage ?? null,
      },
    },
  );

  if (outcome.status === 'succeeded') {
    return settleSuccess({ orderId, providerRef: outcome.providerRef, source: 'gateway' });
  }
  return settleFailure({ orderId, outcome, source: 'gateway' });
}

/**
 * The gateway accepted the charge and then went silent. We do NOT know whether
 * the customer's money moved, so we must not guess.
 *
 * The payment lease is cleared, handing the order back to the reservation
 * deadline: if the answer never arrives, the reaper expires the order and
 * releases the stock, and a late success becomes an explicit refund obligation.
 * The client gets 202 and a poll URL.
 */
async function handleAmbiguousOutcome({ order, record, providerRef }) {
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: ORDER_STATUS.PENDING_PAYMENT },
    {
      $set: {
        paymentLeaseExpiresAt: null,
        'payment.status': PAYMENT_STATUS.PENDING,
        'payment.providerRef': providerRef ?? null,
      },
    },
    { returnDocument: 'after' },
  );

  await PaymentAttempt.updateOne(
    { idempotencyKey: String(order._id) },
    { $set: { providerRef: providerRef ?? null, status: PAYMENT_STATUS.PENDING } },
  );

  await IdempotencyKey.updateOne(
    { _id: record._id },
    {
      $set: {
        status: IDEMPOTENCY_STATUS.COMPLETED,
        leaseExpiresAt: new Date(),
        'response.statusCode': 202,
        orderId: order._id,
      },
    },
  );

  const current = updated ?? (await Order.findById(order._id));
  logger.warn('payment outcome unknown; order left pending for out-of-band resolution', {
    orderId: String(order._id),
    providerRef: providerRef ?? null,
  });
  return presentOrder(current);
}

/**
 * Decide the fate of a claim after a failure.
 *
 * Two policies, deliberately different:
 *  - REQUEST-SHAPED failures (bad input, unknown product, stale price) release
 *    the claim entirely. Nothing was spent, so burning the key would force the
 *    client to invent a new one just to fix a typo.
 *  - BUSINESS failures (out of stock, declined payment) mark it `failed`, which
 *    stays retryable with the SAME key while the request hash matches — that is
 *    the "recovery from a failed checkout" requirement.
 */
async function finalizeFailure(recordId, err) {
  const statusCode = err instanceof AppError ? err.status : 500;

  if (isReleasable(err)) {
    await IdempotencyKey.deleteOne({ _id: recordId, status: IDEMPOTENCY_STATUS.PROCESSING });
    return;
  }

  await IdempotencyKey.updateOne(
    { _id: recordId, status: IDEMPOTENCY_STATUS.PROCESSING },
    {
      $set: {
        status: IDEMPOTENCY_STATUS.FAILED,
        leaseExpiresAt: new Date(),
        'response.statusCode': statusCode,
      },
    },
  );
}
