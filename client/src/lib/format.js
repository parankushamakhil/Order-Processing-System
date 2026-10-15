/** Money is stored and transferred as integer minor units; format only here. */
export function formatMinor(minor, currency = 'USD') {
  if (minor == null) return '—';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${currency === 'USD' ? '$' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

/**
 * Relative time for table cells: a column of timestamps is scanned, not read,
 * and "4 minutes ago" answers the question a reader actually has. The absolute
 * value stays available on hover and in the detail view.
 */
export function formatRelative(value) {
  if (!value) return '—';
  const then = new Date(value).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  return new Date(value).toLocaleDateString();
}

export const STATUS_LABELS = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  payment_failed: 'Payment failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
  fulfilled: 'Fulfilled',
};

/** Order status → badge tone. One mapping, so every surface agrees. */
export function statusTone(status) {
  if (status === 'paid' || status === 'fulfilled') return 'success';
  if (status === 'pending_payment') return 'warning';
  if (status === 'expired') return 'neutral';
  return 'danger';
}

/** Payment attempt status → badge tone. */
export function paymentTone(status) {
  if (status === 'succeeded') return 'success';
  if (status === 'pending' || status === 'initiated') return 'warning';
  if (status === 'refund_required') return 'danger';
  if (status === 'refunded') return 'info';
  return 'neutral';
}
