import mongoose from 'mongoose';

const integer = (extra = {}) => ({
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isInteger, message: 'must be an integer' },
  ...extra,
});

/**
 * Product is the contended document: every checkout that touches it takes a
 * write lock on it, so it is deliberately small and its indexes are chosen for
 * the two hot queries — "is there enough stock" (available) and the catalogue
 * listing (isActive).
 *
 * onHand / reserved / available are mutated ONLY by the three primitives in
 * domain/inventory.js. Nothing else in the codebase writes them, which is what
 * keeps `available === onHand - reserved` true (invariant I1).
 */
const productSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 5000 },
    priceMinor: integer(),
    currency: { type: String, required: true, enum: ['USD'], default: 'USD' },
    onHand: { ...integer(), default: 0 },
    reserved: { ...integer(), default: 0 },
    available: { ...integer(), default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false, collection: 'products' },
);

productSchema.index({ sku: 1 }, { unique: true, name: 'sku_unique' });
productSchema.index({ isActive: 1, available: 1 }, { name: 'listing' });
// Prefix/substring search support. A text index was considered and rejected: its
// whole-word stemming gives worse product-search behaviour than a simple
// case-insensitive prefix match for a catalogue this size.
productSchema.index({ name: 1 }, { name: 'name_search' });

productSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    sku: this.sku,
    name: this.name,
    description: this.description,
    priceMinor: this.priceMinor,
    currency: this.currency,
    // `onHand` is deliberately excluded: a shopper has no business knowing
    // physical stock, only what is buyable.
    available: this.available,
    inStock: this.available > 0,
    isActive: this.isActive,
  };
};

export const Product = mongoose.model('Product', productSchema);
