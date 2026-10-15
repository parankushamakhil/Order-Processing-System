const TOKEN_KEY = 'ops.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * One fetch wrapper for the whole app.
 *
 * On a non-2xx response it throws an Error carrying the API's error envelope, so
 * every caller can branch on `err.code` — the same machine-readable codes the
 * server documents. The idempotency key is passed explicitly by the checkout
 * code because only it knows when the key should be reused.
 */
export async function apiFetch(path, { method = 'GET', body, idempotencyKey, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const auth = token ?? getToken();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    error.code = payload?.error?.code ?? 'UNKNOWN';
    error.status = response.status;
    error.details = payload?.error?.details ?? null;
    error.retryable = payload?.error?.retryable ?? false;
    error.replayed = response.headers.get('Idempotency-Replayed') === 'true';
    throw error;
  }

  return { data: payload?.data ?? null, replayed: response.headers.get('Idempotency-Replayed') === 'true' };
}

export const api = {
  register: (body) => apiFetch('/api/auth/register', { method: 'POST', body }),
  login: (body) => apiFetch('/api/auth/login', { method: 'POST', body }),
  me: () => apiFetch('/api/auth/me'),

  products: (query = '') => apiFetch(`/api/products${query}`),
  createProduct: (body) => apiFetch('/api/products', { method: 'POST', body }),
  updateProduct: (id, body) => apiFetch(`/api/products/${id}`, { method: 'PATCH', body }),
  restock: (id, units) => apiFetch(`/api/products/${id}/stock`, { method: 'POST', body: { units } }),

  checkout: (body, idempotencyKey) =>
    apiFetch('/api/checkout', { method: 'POST', body, idempotencyKey }),
  orders: () => apiFetch('/api/orders'),
  order: (id) => apiFetch(`/api/orders/${id}`),

  reconcile: () => apiFetch('/api/admin/inventory/reconcile'),
  sweep: () => apiFetch('/api/admin/inventory/sweep', { method: 'POST' }),
  refundObligations: () => apiFetch('/api/admin/inventory/refund-obligations'),
  concurrencyLab: (body) =>
    apiFetch('/api/admin/concurrency-lab', { method: 'POST', body }),

  adminOrders: (query = '') => apiFetch(`/api/admin/orders${query}`),
  adminOrder: (id) => apiFetch(`/api/admin/orders/${id}`),
  cancelOrder: (id) => apiFetch(`/api/admin/orders/${id}/cancel`, { method: 'POST' }),
  reconcilePayment: (id) =>
    apiFetch(`/api/admin/orders/${id}/reconcile-payment`, { method: 'POST' }),
  refundPayment: (orderId) =>
    apiFetch(`/api/admin/payments/${orderId}/refund`, { method: 'POST' }),
};
