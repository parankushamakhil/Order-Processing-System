import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { BoxIcon, PlusIcon, SearchIcon } from '../../components/icons.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  SelectField,
  Switch,
  TextField,
} from '../../components/ui.jsx';
import { formatMinor } from '../../lib/format.js';

const PAGE_SIZE = 25;
const STOCK_FILTERS = [
  { value: 'all', label: 'All stock levels' },
  { value: 'out', label: 'Sold out' },
  { value: 'low', label: 'Low (1–5)' },
  { value: 'reserved', label: 'Has reservations' },
];

const EMPTY_FORM = { sku: '', name: '', description: '', price: '0.00', onHand: '0', isActive: true };

const toMinor = (dollars) => Math.round(Number(dollars || 0) * 100);
const toDollars = (minor) => (minor / 100).toFixed(2);

/**
 * Product and inventory management.
 *
 * The list is the reconciliation snapshot the console already holds, filtered in
 * the client: with a catalogue of this size it makes search instant and, more
 * importantly, guarantees the table and the KPI tiles are showing the same
 * instant. Every mutation reloads that snapshot rather than patching it locally,
 * so the server always has the last word on what the counters are.
 */
export default function ProductsPanel({ report, reload }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [stockFilter, setStockFilter] = useState('all');
  const [includeInactive, setIncludeInactive] = useState(true);
  const [page, setPage] = useState(1);

  const [dialog, setDialog] = useState(null); // { mode, product? }
  const [form, setForm] = useState(EMPTY_FORM);
  const [units, setUnits] = useState('10');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const inventory = report.inventory ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return inventory
      .filter((p) => (includeInactive ? true : p.isActive !== false))
      .filter((p) => {
        if (stockFilter === 'out') return p.available === 0;
        if (stockFilter === 'low') return p.available > 0 && p.available <= 5;
        if (stockFilter === 'reserved') return p.reserved > 0;
        return true;
      })
      .filter((p) => {
        if (!needle) return true;
        return (
          p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }, [inventory, query, stockFilter, includeInactive]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  // A filter change can leave the viewer past the end of the list entirely.
  useEffect(() => {
    setPage(1);
  }, [query, stockFilter, includeInactive]);

  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialog({ mode: 'create' });
  }

  function openEdit(product) {
    setForm({
      sku: product.sku,
      name: product.name,
      description: product.description ?? '',
      price: toDollars(product.priceMinor),
      onHand: String(product.onHand),
      isActive: product.isActive !== false,
    });
    setFormError(null);
    setDialog({ mode: 'edit', product });
  }

  function openRestock(product) {
    setUnits('10');
    setFormError(null);
    setDialog({ mode: 'restock', product });
  }

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      if (dialog.mode === 'create') {
        await api.createProduct({
          sku: form.sku.trim(),
          name: form.name.trim(),
          description: form.description.trim(),
          priceMinor: toMinor(form.price),
          onHand: Number(form.onHand || 0),
        });
        toast.success('Product created', `${form.sku} is live with ${form.onHand} units on hand.`);
      } else if (dialog.mode === 'edit') {
        await api.updateProduct(dialog.product.productId, {
          name: form.name.trim(),
          description: form.description.trim(),
          priceMinor: toMinor(form.price),
          isActive: form.isActive,
        });
        toast.success('Product updated', `${form.sku} saved.`);
      } else {
        await api.restock(dialog.product.productId, Number(units));
        toast.success(
          'Restocked',
          `+${units} units added to ${dialog.product.sku}. Stock moves additively through the API.`,
        );
      }
      await reload();
      setDialog(null);
    } catch (err) {
      // The server's validation is the real one; surface it rather than guess.
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(product) {
    try {
      await api.updateProduct(product.productId, { isActive: product.isActive === false });
      toast.success(
        product.isActive === false ? 'Reactivated' : 'Deactivated',
        `${product.sku} is ${product.isActive === false ? 'back in the catalogue' : 'hidden from the storefront'}.`,
      );
      await reload();
    } catch (err) {
      toast.error('Could not change the product', err.message);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Catalogue and stock"
          subtitle="Stock is only ever moved by the inventory primitives: restock adds, and the reservation and sale paths subtract."
          icon={BoxIcon}
          actions={
            <>
              <Badge tone="neutral">
                {filtered.length} of {inventory.length}
              </Badge>
              <Button size="sm" variant="primary" icon={PlusIcon} onClick={openCreate}>
                New product
              </Button>
            </>
          }
        />
        <CardBody>
          <div className="toolbar">
            <div className="toolbar__search">
              <TextField
                aria-label="Search products by name or SKU"
                placeholder="Search name or SKU…"
                icon={SearchIcon}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <SelectField
              aria-label="Filter by stock level"
              value={stockFilter}
              onChange={(event) => setStockFilter(event.target.value)}
              style={{ width: 190 }}
            >
              {STOCK_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectField>
            <Switch
              checked={includeInactive}
              onChange={setIncludeInactive}
              label="Include inactive"
            />
          </div>
        </CardBody>

        {visible.length === 0 ? (
          <CardBody>
            <EmptyState
              icon={query ? SearchIcon : BoxIcon}
              title={query ? `No products match “${query}”` : 'Nothing matches these filters'}
              body="Clear the search or widen the stock filter to see the rest of the catalogue."
              actions={
                <Button
                  variant="default"
                  onClick={() => {
                    setQuery('');
                    setStockFilter('all');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </CardBody>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="table table--hover">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="is-numeric">Price</th>
                    <th className="is-numeric">onHand</th>
                    <th className="is-numeric">reserved</th>
                    <th className="is-numeric">available</th>
                    <th className="is-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((product) => (
                    <tr key={product.productId} className={product.isActive === false ? 'is-muted' : ''}>
                      <td className="mono">{product.sku}</td>
                      <td className="table__primary">
                        {product.name}
                        {product.isActive === false ? (
                          <>
                            {' '}
                            <Badge tone="neutral" size="sm">
                              inactive
                            </Badge>
                          </>
                        ) : null}
                      </td>
                      <td className="is-numeric">{formatMinor(product.priceMinor)}</td>
                      <td className="is-numeric text-muted">{product.onHand}</td>
                      <td className="is-numeric">
                        {product.reserved > 0 ? (
                          <Badge tone="accent">{product.reserved}</Badge>
                        ) : (
                          <span className="text-subtle">0</span>
                        )}
                      </td>
                      <td className="is-numeric">
                        <Badge
                          tone={
                            product.available === 0
                              ? 'danger'
                              : product.available <= 5
                                ? 'warning'
                                : 'success'
                          }
                        >
                          {product.available}
                        </Badge>
                      </td>
                      <td className="is-actions">
                        <div className="cluster" style={{ justifyContent: 'flex-end' }}>
                          <Button size="sm" variant="default" onClick={() => openRestock(product)}>
                            Restock
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openEdit(product)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleActive(product)}
                          >
                            {product.isActive === false ? 'Activate' : 'Deactivate'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 ? (
              <div className="pager">
                <span className="pager__label">
                  Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)}{' '}
                  of {filtered.length}
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
                  <span className="pager__page">
                    {page} / {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="default"
                    disabled={page >= totalPages}
                    onClick={() => setPage((n) => Math.min(totalPages, n + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </CardBody>
        )}
      </Card>

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.mode === 'create'
            ? 'New product'
            : dialog?.mode === 'edit'
              ? `Edit ${dialog.product.sku}`
              : `Restock ${dialog?.product?.sku ?? ''}`
        }
        subtitle={
          dialog?.mode === 'create'
            ? 'A new product arrives with its physical units already available, so invariant I1 holds from the first document.'
            : dialog?.mode === 'edit'
              ? 'Price and metadata only. Stock is never set through a generic update — use Restock.'
              : 'Restock is additive: the API cannot destroy inventory, so stock only leaves through a reservation or a sale.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={submit}>
              {dialog?.mode === 'create'
                ? 'Create product'
                : dialog?.mode === 'edit'
                  ? 'Save changes'
                  : 'Add units'}
            </Button>
          </>
        }
      >
        <div className="stack">
          {formError ? (
            <Alert tone="danger" title="The server rejected that">
              {formError}
            </Alert>
          ) : null}

          {dialog?.mode === 'restock' ? (
            <>
              <TextField
                label="Units to add"
                type="number"
                min="1"
                value={units}
                onChange={(event) => setUnits(event.target.value)}
                hint={`Currently ${dialog.product.available} available of ${dialog.product.onHand} on hand.`}
              />
              <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                To reduce stock, sell it or cancel an order — both paths release the reservation
                through the same primitive, which is what keeps the counters provably consistent.
              </p>
            </>
          ) : (
            <>
              {dialog?.mode === 'create' ? (
                <TextField
                  label="SKU"
                  value={form.sku}
                  onChange={(event) => setForm({ ...form, sku: event.target.value })}
                  hint="Must be unique — the database enforces it."
                />
              ) : null}
              <TextField
                label="Name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
              <TextField
                label="Description"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
              <TextField
                label="Price (USD)"
                type="number"
                step="0.01"
                min="0"
                value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value })}
                hint="Stored as integer minor units, so no floating-point money."
              />
              {dialog?.mode === 'create' ? (
                <TextField
                  label="Units on hand"
                  type="number"
                  min="0"
                  value={form.onHand}
                  onChange={(event) => setForm({ ...form, onHand: event.target.value })}
                />
              ) : (
                <Switch
                  checked={form.isActive}
                  onChange={(isActive) => setForm({ ...form, isActive })}
                  label="Listed in the storefront"
                />
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
