import { Router } from 'express';
import { restock } from '../domain/inventory.js';
import { NotFoundError } from '../errors/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { Product } from '../models/index.js';
import {
  objectIdSchema,
  productCreateSchema,
  productListQuerySchema,
  productUpdateSchema,
  restockSchema,
} from '../validation/schemas.js';
import { z } from 'zod';

const router = Router();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/', validate({ query: productListQuerySchema }), async (req, res) => {
  const { page, pageSize, q, inStock, includeInactive } = req.valid.query;

  const filter = {};
  if (includeInactive !== 'true') filter.isActive = true;
  if (inStock === 'true') filter.available = { $gt: 0 };
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: pattern }, { sku: pattern }];
  }

  const [items, total] = await Promise.all([
    Product.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    Product.countDocuments(filter),
  ]);

  res.json({
    data: {
      items: items.map((p) => p.toPublic()),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  });
});

router.get('/:id', validate({ params: z.object({ id: objectIdSchema }).strict() }), async (req, res) => {
  const product = await Product.findById(req.valid.params.id);
  if (!product || !product.isActive) {
    throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found');
  }
  res.json({ data: { product: product.toPublic() } });
});

router.post('/', requireAuth, requireAdmin, validate({ body: productCreateSchema }), async (req, res) => {
  const { sku, name, description = '', priceMinor, onHand } = req.valid.body;

  // A new product arrives with its physical units already available, so I1 holds
  // from the first document rather than relying on a later repair.
  const product = await Product.create({
    sku,
    name,
    description,
    priceMinor,
    onHand,
    reserved: 0,
    available: onHand,
    isActive: true,
  });
  res.status(201).json({ data: { product: product.toPublic() } });
});

router.patch('/:id', requireAuth, requireAdmin, validate({ params: z.object({ id: objectIdSchema }).strict(), body: productUpdateSchema }), async (req, res) => {
  // Price and metadata only. Stock is never set through a generic update, which
  // is why reserved/available are absent from the schema.
  const product = await Product.findOneAndUpdate(
    { _id: req.valid.params.id },
    { $set: req.valid.body },
    { returnDocument: 'after' },
  );
  if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found');
  res.json({ data: { product: product.toPublic() } });
});

router.post('/:id/stock', requireAuth, requireAdmin, validate({ params: z.object({ id: objectIdSchema }).strict(), body: restockSchema }), async (req, res) => {
  const { units } = req.valid.body;

  // onHand and available move together in one atomic update, so I1 is preserved
  // and the new units are buyable immediately.
  const ok = await restock(req.valid.params.id, units);
  if (!ok) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found');

  const product = await Product.findById(req.valid.params.id);
  res.json({ data: { product: product.toPublic() } });
});

export default router;
