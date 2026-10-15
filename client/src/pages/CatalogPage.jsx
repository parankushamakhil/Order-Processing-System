import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { BoxIcon, CartIcon, RefreshIcon, SearchIcon, XIcon } from '../components/icons.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  SelectField,
  SkeletonCardGrid,
  Stepper,
  Switch,
  TextField,
  monogram,
  productTileStyle,
} from '../components/ui.jsx';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts.js';
import { EVENTS, on } from '../lib/bus.js';
import { formatMinor } from '../lib/format.js';
import { useAuth } from '../state/AuthContext.jsx';
import { useCart } from '../state/CartContext.jsx';

const SORTS = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'stock-desc', label: 'Availability (most first)' },
  { value: 'stock-asc', label: 'Availability (fewest first)' },
  { value: 'price-asc', label: 'Price (low to high)' },
  { value: 'price-desc', label: 'Price (high to low)' },
];

const LOW_STOCK = 5;

function sortProducts(products, sort) {
  const list = [...products];
  switch (sort) {
    case 'price-asc':
      return list.sort((a, b) => a.priceMinor - b.priceMinor);
    case 'price-desc':
      return list.sort((a, b) => b.priceMinor - a.priceMinor);
    case 'stock-asc':
      return list.sort((a, b) => a.available - b.available);
    case 'stock-desc':
      return list.sort((a, b) => b.available - a.available);
    default:
      return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function StockMeter({ available, reference }) {
  const ratio = reference > 0 ? Math.min(1, available / reference) : 0;
  const tone = available === 0 ? 'stock-meter--out' : available <= LOW_STOCK ? 'stock-meter--low' : '';
  return (
    <div className={`stock-meter ${tone}`}>
      <div className="stock-meter__row">
        <span>{available === 0 ? 'Out of stock' : available <= LOW_STOCK ? 'Low stock' : 'In stock'}</span>
        <span className="stock-meter__value">{available} available</span>
      </div>
      <div
        className="stock-meter__bar"
        role="img"
        aria-label={`${available} units available to sell`}
      >
        <div className="stock-meter__fill" style={{ width: `${Math.max(4, ratio * 100)}%` }} />
      </div>
    </div>
  );
}

export default function CatalogPage({ onGoToCart }) {
  const { user } = useAuth();
  const { add, count } = useCart();
  const toast = useToast();

  const [products, setProducts] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [quantities, setQuantities] = useState({});
  const searchRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.products(query ? `?q=${encodeURIComponent(query)}` : '');
      setProducts(data.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 220 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  // "/" lives in the shared keymap rather than here, so all bindings are
  // declared in one place and none of them can silently shadow another.
  useGlobalShortcuts([{ combo: '/', run: () => searchRef.current?.focus() }]);

  // The palette does not know this view exists; it announces an intent and this
  // view — the only one with a catalogue search — answers it.
  useEffect(
    () =>
      on(EVENTS.focusCatalogueSearch, ({ query: next } = {}) => {
        if (typeof next === 'string') setQuery(next);
        searchRef.current?.focus();
        searchRef.current?.select();
      }),
    [],
  );

  useEffect(() => on(EVENTS.refreshView, () => load()), [load]);

  const visible = useMemo(() => {
    const filtered = inStockOnly ? products.filter((p) => p.inStock) : products;
    return sortProducts(filtered, sort);
  }, [products, sort, inStockOnly]);

  const reference = useMemo(
    () => Math.max(10, ...products.map((p) => p.available)),
    [products],
  );

  const outOfStock = products.filter((p) => !p.inStock).length;

  function addToCart(product) {
    const quantity = quantities[product.id] ?? 1;
    add(product, quantity);
    setQuantities((current) => ({ ...current, [product.id]: 1 }));
    toast.success(
      `Added ${quantity} × ${product.name}`,
      `Cart now holds ${count + quantity} item${count + quantity === 1 ? '' : 's'}.`,
    );
  }

  return (
    <>
      {/* No heading here on purpose: the top bar already names the page, and
          repeating it 40px below is the visual equivalent of saying it twice. */}
      {/* Rendered only when it holds something. An empty action row that
          reserves 52px for no action is exactly the kind of hollow furniture a
          designer removes. */}
      {count > 0 ? (
        <div className="page-head">
          <div className="page-head__actions">
            <Button variant="primary" icon={CartIcon} onClick={onGoToCart}>
              Review cart ({count})
            </Button>
          </div>
        </div>
      ) : null}

      <Card>
        <div className="toolbar">
          <div className="toolbar__search">
            <TextField
              ref={searchRef}
              icon={SearchIcon}
              placeholder="Search by name or SKU"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the catalogue"
              suffix={query ? undefined : 'Press /'}
            />
          </div>

          <div style={{ minWidth: 190 }}>
            <SelectField label="" aria-label="Sort products" value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectField>
          </div>

          <Switch checked={inStockOnly} onChange={setInStockOnly} label="In stock only" />

          <div className="cluster-end">
            <span className="result-count">
              {loading ? 'Loading…' : `${visible.length} of ${products.length} products`}
              {outOfStock > 0 && !loading ? ` · ${outOfStock} unavailable` : ''}
            </span>
            {query ? (
              <Button
                size="sm"
                variant="ghost"
                icon={XIcon}
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                Clear
              </Button>
            ) : null}
            <Button size="sm" variant="default" icon={RefreshIcon} onClick={load} loading={loading}>
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {error ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Alert tone="danger" title="Could not load the catalogue">
            {error.message}
          </Alert>
        </div>
      ) : null}

      {loading && products.length === 0 ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <SkeletonCardGrid count={6} />
        </div>
      ) : null}

      {!loading && visible.length === 0 ? (
        <Card style={{ marginTop: 'var(--sp-4)' }}>
          <EmptyState
            icon={BoxIcon}
            title={query ? `No products match “${query}”` : 'No products to show'}
            body={
              query
                ? 'Try a shorter search, or clear it to see the whole catalogue.'
                : 'Run npm run seed:demo to load the demo catalogue, then refresh.'
            }
            actions={
              query ? (
                <Button variant="default" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : (
                <Button variant="primary" icon={RefreshIcon} onClick={load}>
                  Refresh
                </Button>
              )
            }
          />
        </Card>
      ) : null}

      <div className="product-grid">
        {visible.map((product) => {
          const quantity = quantities[product.id] ?? 1;
          return (
            <article className="product-card" key={product.id}>
              <div className="tile" style={productTileStyle(product.sku)}>
                <span aria-hidden="true">{monogram(product.name)}</span>
                <span className="tile__sku">{product.sku}</span>
                {!product.inStock ? (
                  <span className="tile__badge">
                    <Badge tone="danger" size="sm">
                      Unavailable
                    </Badge>
                  </span>
                ) : product.available <= LOW_STOCK ? (
                  <span className="tile__badge">
                    <Badge tone="warning" size="sm">
                      Only {product.available} left
                    </Badge>
                  </span>
                ) : null}
              </div>

              <div className="product-card__body">
                <div>
                  {/* h2, not h3: with the page name in the top bar this is the
                      first heading level below h1, and skipping a level is the
                      one heading mistake assistive tech actually reports. */}
                  <h2 className="product-card__name">{product.name}</h2>
                  <p className="product-card__desc">{product.description}</p>
                </div>

                <span className="product-card__price">
                  {formatMinor(product.priceMinor, product.currency)}
                </span>

                <StockMeter available={product.available} reference={reference} />

                <div className="product-card__footer">
                  {product.inStock ? (
                    <>
                      <Stepper
                        value={quantity}
                        onChange={(next) =>
                          setQuantities((current) => ({ ...current, [product.id]: next }))
                        }
                        min={1}
                        max={Math.min(product.available, 99)}
                      />
                      <Button
                        variant="primary"
                        icon={CartIcon}
                        onClick={() => addToCart(product)}
                        disabled={!user}
                        title={user ? undefined : 'Sign in to add items to your cart'}
                        style={{ flex: 1 }}
                      >
                        Add to cart
                      </Button>
                    </>
                  ) : (
                    <Button variant="default" disabled block>
                      Out of stock
                    </Button>
                  )}
                </div>

                {!user ? (
                  <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                    Sign in to check out.
                  </p>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
