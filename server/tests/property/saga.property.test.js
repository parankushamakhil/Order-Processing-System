import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/transaction.js';
import { release } from '../../src/domain/inventory.js';
import { checkInvariants } from '../../src/domain/invariants.js';
import { transition } from '../../src/domain/orderState.js';
import { ORDER_STATUS } from '../../src/domain/orderStatus.js';
import { Order } from '../../src/models/index.js';
import { checkout } from '../../src/services/checkout.service.js';
import { sweepExpiredReservations } from '../../src/services/expiry.service.js';
import { getGateway } from '../../src/services/payments/index.js';
import { settlePaymentOutcome } from '../../src/services/paymentSettlement.service.js';
import {
  counters,
  createCustomer,
  createProduct,
} from '../helpers/factories.js';

describe('Model-Based Saga Interleaving Property Tests', () => {
  it('preserves all consistency invariants I1-I7 under randomized interleavings of saga actions', async () => {
    const customers = await Promise.all([
      createCustomer(),
      createCustomer(),
    ]);

    const arbAction = fc.record({
      type: fc.constantFrom(
        'checkout_success',
        'checkout_decline',
        'checkout_timeout',
        'cancel',
        'expire',
        'sweep',
        'reconcile',
        'fulfill',
      ),
      customerIdx: fc.integer({ min: 0, max: customers.length - 1 }),
      quantity: fc.integer({ min: 1, max: 2 }),
    });

    const arbActionPlan = fc.array(arbAction, { minLength: 4, maxLength: 8 });

    await fc.assert(
      fc.asyncProperty(arbActionPlan, async (plan) => {
        const product = await createProduct({ priceMinor: 500, onHand: 8 });
        const orders = [];

        for (const action of plan) {
          const customer = customers[action.customerIdx];

          if (action.type === 'checkout_success') {
            try {
              const res = await checkout({
                customerId: customer.id,
                idempotencyKey: randomUUID(),
                input: {
                  items: [{ productId: String(product._id), quantity: action.quantity }],
                  paymentMethod: { type: 'card', token: 'tok_success' },
                },
              });
              if (res.statusCode === 201) {
                orders.push(res.body.data.order);
              }
            } catch {
              // Expected when inventory exhausted or business error
            }
          } else if (action.type === 'checkout_decline') {
            try {
              await checkout({
                customerId: customer.id,
                idempotencyKey: randomUUID(),
                input: {
                  items: [{ productId: String(product._id), quantity: action.quantity }],
                  paymentMethod: { type: 'card', token: 'tok_decline' },
                },
              });
            } catch {
              // Expected decline
            }
          } else if (action.type === 'checkout_timeout') {
            try {
              const res = await checkout({
                customerId: customer.id,
                idempotencyKey: randomUUID(),
                input: {
                  items: [{ productId: String(product._id), quantity: action.quantity }],
                  paymentMethod: { type: 'card', token: 'tok_timeout' },
                },
              });
              if (res.statusCode === 202) {
                orders.push(res.body.data.order);
              }
            } catch {
              // Handled
            }
          } else if (action.type === 'cancel') {
            const pending = orders.find((o) => o.status === 'pending_payment');
            if (pending) {
              const cancelled = await withTransaction(async (session) => {
                const result = await transition(
                  pending.id,
                  ORDER_STATUS.PENDING_PAYMENT,
                  ORDER_STATUS.CANCELLED,
                  { reason: 'cancelled_by_user', actor: 'customer' },
                  session,
                );
                if (!result) return null;
                await release(
                  pending.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
                  session,
                );
                return result;
              });
              if (cancelled) {
                pending.status = 'cancelled';
              }
            }
          } else if (action.type === 'expire') {
            const pending = orders.find((o) => o.status === 'pending_payment');
            if (pending) {
              await Order.updateOne(
                { _id: pending.id },
                {
                  $set: {
                    reservationExpiresAt: new Date(Date.now() - 5000),
                    paymentLeaseExpiresAt: new Date(Date.now() - 5000),
                  },
                },
              );
            }
          } else if (action.type === 'sweep') {
            await sweepExpiredReservations();
          } else if (action.type === 'reconcile') {
            const pending = orders.find((o) => o.status === 'pending_payment');
            if (pending) {
              const charge = getGateway().resolvePending({ orderId: pending.id });
              if (charge) {
                await settlePaymentOutcome({
                  orderId: pending.id,
                  status: charge.finalStatus,
                  providerRef: charge.providerRef,
                  source: 'reconcile',
                });
                pending.status = charge.finalStatus === 'succeeded' ? 'paid' : 'payment_failed';
              }
            }
          } else if (action.type === 'fulfill') {
            const paid = orders.find((o) => o.status === 'paid');
            if (paid) {
              const updated = await transition(
                paid.id,
                ORDER_STATUS.PAID,
                ORDER_STATUS.FULFILLED,
                { reason: 'property_test_fulfill', actor: 'admin' },
              );
              if (updated) {
                paid.status = 'fulfilled';
              }
            }
          }

          // Invariant check on every step prefix of the interleaving
          const prefixProblems = await checkInvariants();
          expect(prefixProblems).toHaveLength(0);
        }

        // Verify that database is strictly consistent after any interleaving
        const problems = await checkInvariants();
        expect(problems).toHaveLength(0);

        const currentCounters = await counters(product._id);
        expect(currentCounters.onHand).toBeGreaterThanOrEqual(0);
        expect(currentCounters.reserved).toBeGreaterThanOrEqual(0);
        expect(currentCounters.available).toBeGreaterThanOrEqual(0);
        expect(currentCounters.onHand).toBe(currentCounters.available + currentCounters.reserved);
      }),
      { numRuns: 10 },
    );
  }, 120_000);
});

