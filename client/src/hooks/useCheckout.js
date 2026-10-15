import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { useCart } from '../state/CartContext.jsx';

const KEY_STORAGE = 'ops.checkoutKey';

function newKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback for non-secure contexts; still high-entropy enough for a demo.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readStored() {
  try {
    const raw = localStorage.getItem(KEY_STORAGE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(value) {
  if (value) localStorage.setItem(KEY_STORAGE, JSON.stringify(value));
  else localStorage.removeItem(KEY_STORAGE);
}

/**
 * The client half of idempotency — the subtle half.
 *
 * A key that is regenerated on every click protects nothing; a key that never
 * changes blocks a legitimate second purchase. So the key is bound to a
 * fingerprint of the cart:
 *
 *   - network retry, timeout, manual "try again"  -> SAME key (must not double-charge)
 *   - the cart changes                            -> NEW key (a different purchase)
 *   - the purchase succeeds                       -> key cleared with the cart
 *
 * On a business failure (declined card, out of stock) the key is deliberately
 * kept, so retrying after fixing the problem reuses the server's `failed` claim
 * and recovers the checkout instead of starting a rival one.
 */
export function useCheckout() {
  const { lines, discountCode, cartFingerprint, paymentToken, clear } = useCart();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const keyForCart = useCallback(() => {
    const stored = readStored();
    if (stored && stored.fingerprint === cartFingerprint && stored.key) return stored.key;
    const fresh = { key: newKey(), fingerprint: cartFingerprint };
    writeStored(fresh);
    return fresh.key;
  }, [cartFingerprint]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);

    const idempotencyKey = keyForCart();
    const body = {
      items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      // The instrument is presentable but not part of the request hash, so
      // changing it and retrying recovers the same checkout (see ADR-07).
      paymentMethod: { type: 'card', token: paymentToken },
    };
    if (discountCode) body.discountCode = discountCode;

    try {
      const { data, replayed } = await api.checkout(body, idempotencyKey);
      setResult({ order: data.order, replayed, pending: Boolean(data.pending), pollUrl: data.pollUrl });

      // The purchase is done: a new attempt should be a new purchase with a new
      // key, not a replay of this one.
      if (data.order && !data.pending) {
        writeStored(null);
        clear();
      }
      return { ok: true, order: data.order, replayed };
    } catch (err) {
      // Keep the key for retryable business failures; the server's `failed`
      // claim exists precisely so the same key can try again.
      writeStored({ key: idempotencyKey, fingerprint: cartFingerprint });
      setError(err);
      return { ok: false, error: err };
    } finally {
      setBusy(false);
    }
  }, [lines, discountCode, paymentToken, cartFingerprint, keyForCart, clear]);

  return {
    submit,
    busy,
    result,
    error,
    currentKey: readStored()?.key ?? null,
    // Exposed so the UI can show whether the key in hand still describes this
    // cart, rather than asserting a state it has not checked.
    keyState: describeKeyState(cartFingerprint),
  };
}

/** Used by the UI to prove the key lifecycle is behaving. */
export function describeKeyState(cartFingerprint) {
  const stored = readStored();
  if (!stored) return { state: 'none', key: null };
  if (stored.fingerprint === cartFingerprint) return { state: 'reused', key: stored.key };
  return { state: 'stale', key: stored.key };
}
