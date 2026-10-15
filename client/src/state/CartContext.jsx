import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const CartContext = createContext(null);

/**
 * Returns a per-user storage key so that carts are never shared between
 * different accounts or a logged-out guest and a signed-in customer.
 * guest cart lives under 'ops.cart:guest'.
 */
function storageKey(userId) {
  return userId ? `ops.cart:${userId}` : 'ops.cart:guest';
}

function readStored(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Which simulated card the buyer presents. The gateway is driven deterministically
 * by the token, so these map to real server behaviour rather than a UI mock:
 * approval, decline, provider error, and a charge that never answers (which is how
 * the ambiguous `202` path is reached).
 *
 * Deliberately NOT part of the cart fingerprint: a different card is the same
 * purchase, and the server's request hash excludes the instrument for the same
 * reason — so fixing a declined card and retrying reuses the idempotency key
 * instead of failing as a key reuse.
 */
export const PAYMENT_SCENARIOS = [
  { token: 'tok_success', label: 'Approved', detail: 'The charge succeeds.' },
  { token: 'tok_decline', label: 'Declined', detail: 'Stock is released and the key stays retryable.' },
  { token: 'tok_error', label: 'Provider error', detail: 'Treated as a failed payment; stock is released.' },
  { token: 'tok_timeout', label: 'No answer', detail: 'The outcome is unknown; the order stays pending.' },
  { token: 'tok_random', label: 'Random (flaky)', detail: 'Simulates intermittent network/gateway degradation.' },
];

export function CartProvider({ userId, children }) {
  const [lines, setLines] = useState(() => readStored(userId));
  const [discountCode, setDiscountCode] = useState(null);
  const [paymentToken, setPaymentToken] = useState('tok_success');

  // When the user changes (login / logout / switch account) reload the
  // correct cart from storage and reset discount + token.
  useEffect(() => {
    setLines(readStored(userId));
    setDiscountCode(null);
    setPaymentToken('tok_success');
  }, [userId]);

  useEffect(() => {
    localStorage.setItem(storageKey(userId), JSON.stringify(lines));
  }, [lines, userId]);

  const add = useCallback((product, quantity = 1) => {
    setLines((current) => {
      const existing = current.find((l) => l.productId === product.id);
      if (existing) {
        return current.map((l) =>
          l.productId === product.id ? { ...l, quantity: l.quantity + quantity } : l,
        );
      }
      return [
        ...current,
        {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          priceMinor: product.priceMinor,
          quantity,
        },
      ];
    });
  }, []);

  const setQuantity = useCallback((productId, quantity) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((l) => l.productId !== productId)
        : current.map((l) => (l.productId === productId ? { ...l, quantity } : l)),
    );
  }, []);

  const remove = useCallback((productId) => {
    setLines((current) => current.filter((l) => l.productId !== productId));
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setDiscountCode(null);
  }, []);

  const resetAll = useCallback(() => {
    setLines([]);
    setDiscountCode(null);
    setPaymentToken('tok_success');
  }, []);

  const subtotalMinor = useMemo(
    () => lines.reduce((sum, l) => sum + l.priceMinor * l.quantity, 0),
    [lines],
  );

  /**
   * A stable fingerprint of what is being bought. The checkout hook compares it
   * to decide whether a previously issued idempotency key still describes this
   * cart or has to be replaced.
   */
  const cartFingerprint = useMemo(
    () =>
      JSON.stringify(
        [...lines]
          .map((l) => [l.productId, l.quantity])
          .sort((a, b) => a[0].localeCompare(b[0])),
      ) + `|${discountCode ?? ''}`,
    [lines, discountCode],
  );

  const value = useMemo(
    () => ({
      lines,
      count: lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotalMinor,
      discountCode,
      setDiscountCode,
      paymentToken,
      setPaymentToken,
      cartFingerprint,
      add,
      setQuantity,
      remove,
      clear,
      resetAll,
    }),
    [
      lines,
      subtotalMinor,
      discountCode,
      paymentToken,
      cartFingerprint,
      add,
      setQuantity,
      remove,
      clear,
      resetAll,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used inside CartProvider');
  return context;
}
