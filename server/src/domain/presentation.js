import { ORDER_STATUS } from './orderStatus.js';

/**
 * The ONE place an order is turned into an HTTP response.
 *
 * Used for the first response AND for every replay, which is what makes the
 * replay rule in ADR-09 fall out for free rather than being a second code path:
 * a replay is side-effect-free and reflects the order's CURRENT state, so a
 * checkout that first returned 202 and later succeeded replays as 201 instead of
 * serving a stale "still pending" body.
 */
export function presentOrder(order, { replayed = false } = {}) {
  const publicOrder = typeof order.toPublic === 'function' ? order.toPublic() : order;
  const base = { order: publicOrder, replayed };

  switch (order.status) {
    case ORDER_STATUS.PAID:
    case ORDER_STATUS.FULFILLED:
      return { statusCode: 201, body: { data: base } };

    case ORDER_STATUS.PENDING_PAYMENT:
      return {
        statusCode: 202,
        body: {
          data: {
            ...base,
            pending: true,
            message: 'The payment outcome is still unknown; poll the order until it settles',
            pollUrl: `/api/orders/${String(order._id)}`,
          },
        },
      };

    case ORDER_STATUS.PAYMENT_FAILED: {
      // Distinguish "the card was declined" from "the provider broke". Both mean
      // the hold was released, but they call for different customer action, so
      // they get different codes.
      const declined = order.payment?.status === 'declined';
      return {
        statusCode: 402,
        body: {
          error: {
            code: declined ? 'PAYMENT_DECLINED' : 'PAYMENT_FAILED',
            message: declined
              ? 'Payment was declined and the reserved stock has been released'
              : 'The payment provider could not process this payment and the reserved stock has been released',
            details: {
              orderId: String(order._id),
              order: publicOrder,
              providerMessage: order.payment?.lastError ?? null,
              retryable: true,
            },
          },
        },
      };
    }

    case ORDER_STATUS.EXPIRED:
      return {
        statusCode: 409,
        body: {
          error: {
            code: 'ORDER_EXPIRED',
            message: 'The reservation expired before payment completed and the stock was released',
            details: { orderId: String(order._id), order: publicOrder, retryable: true },
          },
        },
      };

    case ORDER_STATUS.CANCELLED:
      return {
        statusCode: 409,
        body: {
          error: {
            code: 'ORDER_CANCELLED',
            message: 'This order was cancelled and the reserved stock was released',
            details: { orderId: String(order._id), order: publicOrder, retryable: true },
          },
        },
      };

    default:
      return { statusCode: 200, body: { data: base } };
  }
}
