import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { EVENTS, emit } from '../lib/bus.js';
import { formatMinor } from '../lib/format.js';
import { fuzzyMatch } from '../lib/fuzzy.js';
import { SearchIcon, XIcon } from './icons.jsx';
import { useDialogBehavior } from './Modal.jsx';
import { monogram } from './ui.jsx';

const RECENT_KEY = 'ops.recent';
const MAX_RECENT = 4;
const PER_SECTION = 5;

/* --------------------------------------------------------------- rendering */

/** Split a label into plain and matched spans so the match can be marked. */
function highlight(text, ranges) {
  if (!ranges || ranges.length === 0) return text;
  const parts = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark className="cmdk__hit" key={`${start}-${index}`}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/* ------------------------------------------------------------- recent list */

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(id) {
  try {
    const next = [id, ...readRecent().filter((value) => value !== id)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage is optional: recents are a convenience, never a dependency */
  }
}

/* ------------------------------------------------------------------ palette */

/**
 * Command palette (⌘K / Ctrl+K).
 *
 * Three things make this worth having rather than decorative:
 *
 *  1. It searches the real catalogue, not a hard-coded list — products come from
 *     the same endpoint the grid uses, so a result here is priced and stocked
 *     like anywhere else.
 *  2. Selecting a product hands the term to the catalogue search instead of
 *     pretending to be a detail page the app does not have.
 *  3. It follows the combobox pattern: focus never leaves the input, DOM focus
 *     stays put while `aria-activedescendant` tracks the highlighted row, so
 *     arrows move the selection and a screen reader follows along.
 *
 * Matching lives in `lib/fuzzy.js`; this file exports a component and nothing
 * else, which is what keeps edits to it a hot update rather than a reload.
 */
export default function CommandPalette({ open, onClose, pages, actions }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productError, setProductError] = useState(null);
  const [recentIds, setRecentIds] = useState(readRecent);

  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const optionRefs = useRef([]);
  const listId = useId();

  // Escape is handled by the dialog hook, which lives outside React's render
  // tree; a ref is how it sees the current query without a stale closure.
  const queryRef = useRef('');
  queryRef.current = query;

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  // Products are fetched when the palette opens and filtered in memory after
  // that: the catalogue is small, and a request per keystroke would make the
  // fastest path in the app feel like the slowest.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoadingProducts(true);
    setProductError(null);

    api
      .products()
      .then(({ data }) => {
        if (!cancelled) setProducts(data.items);
      })
      .catch((error) => {
        if (!cancelled) setProductError(error);
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleEscape = useCallback(() => {
    // First Escape clears the query, second closes. Losing a typed query because
    // you wanted to back out one step is a small betrayal.
    if (queryRef.current) {
      setQuery('');
      return true;
    }
    return false;
  }, []);

  useDialogBehavior({ open, onClose, panelRef, focusRef: inputRef, onEscape: handleEscape });

  const close = useCallback(() => {
    onClose();
    setQuery('');
  }, [onClose]);

  const sections = useMemo(() => {
    const term = query.trim();

    const runSection = (source, mapper) =>
      source
        .map((entry) => mapper(entry))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, PER_SECTION);

    if (!term) {
      const byId = new Map([...pages, ...actions].map((entry) => [entry.id, entry]));
      const recent = recentIds.map((id) => byId.get(id)).filter(Boolean);
      return [
        { key: 'recent', label: 'Recent', items: recent.map((entry) => ({ ...entry, ranges: [] })) },
        {
          key: 'pages',
          label: 'Go to',
          items: pages.map((entry) => ({ ...entry, ranges: [], meta: entry.meta })),
        },
        {
          key: 'actions',
          label: 'Actions',
          items: actions.map((entry) => ({ ...entry, ranges: [], meta: entry.hint })),
        },
      ].filter((section) => section.items.length > 0);
    }

    const pageHits = runSection(pages, (entry) => {
      const direct = fuzzyMatch(entry.label, term);
      const aliased = entry.keywords ? fuzzyMatch(entry.keywords, term) : null;
      if (!direct && !aliased) return null;
      const best = direct && (!aliased || direct.score >= aliased.score) ? direct : { score: aliased.score - 4, ranges: [] };
      return { ...entry, ranges: best.ranges, meta: entry.meta, score: best.score };
    });

    const productHits = runSection(
      products.filter((product) => product.inStock || fuzzyMatch(product.sku, term)),
      (product) => {
        const byName = fuzzyMatch(product.name, term);
        const bySku = fuzzyMatch(product.sku, term);
        if (!byName && !bySku) return null;
        const useSku = !byName || (bySku && bySku.score > byName.score);
        return {
          id: `product-${product.id}`,
          label: product.name,
          ranges: useSku ? [] : byName.ranges,
          sku: product.sku,
          skuRanges: useSku ? bySku.ranges : [],
          product,
          score: (useSku ? bySku.score - 1 : byName.score) + (product.inStock ? 2 : -4),
          // The catalogue has no detail route, so a product result hands its SKU
          // to the catalogue search rather than inventing a page that does not exist.
          run: () => {
            window.location.hash = '#/shop';
            emit(EVENTS.focusCatalogueSearch, { query: product.sku });
          },
        };
      },
    );

    const actionHits = runSection(actions, (entry) => {
      const direct = fuzzyMatch(entry.label, term);
      const aliased = entry.keywords ? fuzzyMatch(entry.keywords, term) : null;
      if (!direct && !aliased) return null;
      const best = direct && (!aliased || direct.score >= aliased.score) ? direct : { score: aliased.score - 4, ranges: [] };
      return { ...entry, ranges: best.ranges, meta: entry.hint, score: best.score };
    });

    /*
     * Sections are ranked, not fixed, once there is a query. With a fixed order
     * the first row of the first section is selected by default — so typing the
     * name of an action and pressing Enter would run a *page* that merely came
     * first in the layout. Section order follows the best hit instead; the
     * curated order (Recent, Go to, Actions) still applies with an empty query,
     * where browsing matters more than matching.
     */
    return [
      { key: 'pages', label: 'Go to', items: pageHits },
      { key: 'products', label: 'Products', items: productHits },
      { key: 'actions', label: 'Actions', items: actionHits },
    ]
      .filter((section) => section.items.length > 0)
      .sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
  }, [query, pages, actions, products, recentIds]);

  const flat = useMemo(
    () => sections.flatMap((section) => section.items.map((item) => ({ ...item, section: section.key }))),
    [sections],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex > flat.length - 1) setActiveIndex(Math.max(0, flat.length - 1));
  }, [flat.length, activeIndex]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const runItem = useCallback(
    (item) => {
      if (!item) return;
      // Products route through the catalogue, so they are not "recent" commands;
      // everything else is something you would want one keystroke away again.
      if (item.section !== 'products') {
        pushRecent(item.id);
        setRecentIds(readRecent());
      }
      item.run?.();
      close();
    },
    [close],
  );

  function onInputKeyDown(event) {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      if (flat.length) setActiveIndex((index) => (index + 1) % flat.length);
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      if (flat.length) setActiveIndex((index) => (index - 1 + flat.length) % flat.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runItem(flat[activeIndex]);
    }
  }

  if (!open) return null;

  const total = flat.length;
  let optionIndex = -1;

  return (
    <div className="cmdk-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="cmdk__search">
          <SearchIcon size={17} className="cmdk__search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="cmdk__input"
            placeholder="Search products, pages and actions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            aria-label="Search products, pages and actions"
            autoComplete="off"
            spellCheck="false"
          />
          {query ? (
            <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => setQuery('')} aria-label="Clear query">
              <XIcon size={14} />
            </button>
          ) : null}
          <kbd className="kbd">esc</kbd>
        </div>

        <div className="cmdk__list" id={listId} role="listbox" aria-label="Results">
          {total === 0 ? (
            <div className="cmdk__empty">
              <p className="cmdk__empty-title">No matches for “{query}”</p>
              <p className="cmdk__empty-body">
                {loadingProducts
                  ? 'Still loading the catalogue…'
                  : 'Try a product name, an SKU like SKU-TEE-001, or a page name.'}
              </p>
            </div>
          ) : null}

          {sections.map((section) => (
            <div className="cmdk__group" key={section.key}>
              <p className="cmdk__group-label" role="presentation">
                {section.label}
                {section.key === 'products' && loadingProducts ? <span className="cmdk__group-note">loading…</span> : null}
              </p>

              {section.items.map((item) => {
                optionIndex += 1;
                const index = optionIndex;
                const active = index === activeIndex;
                return (
                  <div
                    key={`${section.key}-${item.id}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={active}
                    className={`cmdk__item${active ? ' cmdk__item--active' : ''}`}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    onMouseMove={() => !active && setActiveIndex(index)}
                    onClick={() => runItem({ ...item, section: section.key })}
                  >
                    <span className="cmdk__item-icon" aria-hidden="true">
                      {item.product ? monogram(item.product.name) : item.Icon ? <item.Icon size={16} /> : null}
                    </span>

                    <span className="cmdk__item-text">
                      <span className="cmdk__item-label">{highlight(item.label, item.ranges)}</span>
                      {item.sku ? (
                        <span className="cmdk__item-sub">
                          <span className="mono">{highlight(item.sku, item.skuRanges)}</span>
                        </span>
                      ) : item.meta ? (
                        <span className="cmdk__item-sub">{item.meta}</span>
                      ) : null}
                    </span>

                    {item.product ? (
                      <span className="cmdk__item-side">
                        <span className="tnum">{formatMinor(item.product.priceMinor, item.product.currency)}</span>
                        <span className={item.product.available === 0 ? 'cmdk__stock cmdk__stock--out' : 'cmdk__stock'}>
                          {item.product.available === 0 ? 'Out of stock' : `${item.product.available} in stock`}
                        </span>
                      </span>
                    ) : item.trailing ? (
                      <span className="cmdk__item-side">{item.trailing}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}

          {productError ? (
            <p className="cmdk__note" role="status">
              The catalogue could not be reached, so product results are missing. {' '}
              {productError.message}
            </p>
          ) : null}
        </div>

        <div className="cmdk__footer">
          <span className="cmdk__hint">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> navigate
          </span>
          <span className="cmdk__hint">
            <kbd className="kbd">↵</kbd> open
          </span>
          <span className="cmdk__hint">
            <kbd className="kbd">esc</kbd> {query ? 'clear' : 'close'}
          </span>
          <span className="cmdk__count tnum">
            {loadingProducts && total === 0 ? 'searching…' : `${total} result${total === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>
    </div>
  );
}
