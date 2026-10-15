import mongoose from 'mongoose';
import { ALL_STATUSES, ORDER_STATUS, HOLDING_STATUSES, TERMINAL_STATUSES } from '../domain/orderStatus.js';

const integer = (extra = {}) => ({
  type: Number,
  required: true,
  validate: { validator: Number.isInteger, message: 'must be an integer' },
  ...extra,
});

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    quantity: integer({ min: 1 }),
    // Price snapshot. A priced order is an immutable financial record: if the
    // catalogue price changes tomorrow, this order must still explain what the
    // customer was charged and why (ADR-01).
    unitPriceMinor: integer({ min: 0 }),
    lineTotalMinor: integer({ min: 0 }),
  },
  { _id: false },
);

const pricingSchema = new mongoose.Schema(
  {
    subtotalMinor: integer({ min: 0 }),
    discountMinor: integer({ min: 0, default: 0 }),
    taxMinor: integer({ min: 0, default: 0 }),
    shippingMinor: integer({ min: 0, default: 0 }),
    totalMinor: integer({ min: 0 }),
    taxRateBps: integer({ min: 0, default: 0 }),
    discountCode: { type: String, default: null },
    engineVersion: { type: String, required: true },
  },
  { _id: false },
);

const paymentSchema = new mongoose.Schema(
  {
    provider: { type: String, default: 'simulated' },
    status: {
      type: String,
      enum: ['none', 'initiated', 'succeeded', 'declined', 'failed', 'pending', 'refund_required', 'refunded'],
      default: 'none',
    },
    providerRef: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
  },
  { _id: false },
);

const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    at: { type: Date, required: true },
    reason: { type: String, default: null },
    actor: { type: String, default: 'system' },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    status: { type: String, enum: ALL_STATUSES, required: true, default: ORDER_STATUS.PENDING_PAYMENT },
    currency: { type: String, required: true, enum: ['USD'], default: 'USD' },
    items: { type: [orderItemSchema], required: true, validate: (v) => v.length > 0 },

    pricing: { type: pricingSchema, required: true },
    payment: { type: paymentSchema, default: () => ({}) },

    // Two deadlines, not one (ADR-08). `reservationExpiresAt` bounds the hold;
    // `paymentLeaseExpiresAt` marks a charge that is in flight, so the reaper
    // never expires an order it might be mid-payment on.
    reservationExpiresAt: { type: Date, required: true },
    paymentLeaseExpiresAt: { type: Date, default: null },

    statusHistory: { type: [statusHistorySchema], default: [] },
    idempotencyKey: { type: String, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'orders' },
);

orderSchema.index({ orderNumber: 1 }, { unique: true, name: 'order_number_unique' });
orderSchema.index({ customerId: 1, createdAt: -1 }, { name: 'customer_history' });
// The reaper's query shape.
orderSchema.index(
  { status: 1, reservationExpiresAt: 1, paymentLeaseExpiresAt: 1 },
  { name: 'expiry_scan' },
);
// Targeted lazy reclaim for one product (ADR-10).
orderSchema.index({ 'items.productId': 1, status: 1 }, { name: 'product_holds' });

orderSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    orderNumber: this.orderNumber,
    status: this.status,
    currency: this.currency,
    items: this.items.map((i) => ({
      productId: String(i.productId),
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPriceMinor: i.unitPriceMinor,
      lineTotalMinor: i.lineTotalMinor,
    })),
    pricing: {
      subtotalMinor: this.pricing.subtotalMinor,
      discountMinor: this.pricing.discountMinor,
      taxMinor: this.pricing.taxMinor,
      shippingMinor: this.pricing.shippingMinor,
      totalMinor: this.pricing.totalMinor,
      currency: this.currency,
    },
    payment: { provider: this.payment.provider, status: this.payment.status },
    holdsStock: HOLDING_STATUSES.includes(this.status),
    isTerminal: TERMINAL_STATUSES.includes(this.status),
    reservationExpiresAt: this.reservationExpiresAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Order = mongoose.model('Order', orderSchema);
