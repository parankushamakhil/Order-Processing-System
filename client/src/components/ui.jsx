import { useId } from 'react';
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
  MinusIcon,
  PlusIcon,
} from './icons.jsx';

/* ------------------------------------------------------------------ Button */

/**
 * One button, explicit variants, no size guessing. `loading` is a first-class
 * state: a busy button keeps its label and gains a spinner, so the layout does
 * not jump and the user is not left wondering whether the click registered.
 */
export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  icon: IconCmp,
  iconRight: IconRightCmp,
  block = false,
  className = '',
  children,
  type = 'button',
  disabled,
  ...rest
}) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size !== 'md' ? `btn--${size}` : '',
    block ? 'btn--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="spinner" aria-hidden="true" />
      ) : IconCmp ? (
        <IconCmp aria-hidden="true" />
      ) : null}
      {children}
      {IconRightCmp && !loading ? <IconRightCmp aria-hidden="true" /> : null}
    </button>
  );
}

export function IconButton({ label, icon: IconCmp, size = 'md', variant = 'ghost', ...rest }) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--icon${size === 'sm' ? ' btn--sm' : ''}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      <IconCmp aria-hidden="true" />
    </button>
  );
}

/* ------------------------------------------------------------------- Badge */

const BADGE_TONES = {
  neutral: '',
  success: 'badge--success',
  warning: 'badge--warning',
  danger: 'badge--danger',
  info: 'badge--info',
  accent: 'badge--accent',
};

export function Badge({ tone = 'neutral', dot = false, size = 'md', children, ...rest }) {
  return (
    <span
      className={`badge ${BADGE_TONES[tone] ?? ''}${size === 'sm' ? ' badge--sm' : ''}`}
      {...rest}
    >
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------- Card */

export function Card({ className = '', children, ...rest }) {
  return (
    <section className={`card ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, actions, stacked = false, icon: IconCmp, id }) {
  return (
    <header className={`card__header${stacked ? ' card__header--stacked' : ''}`}>
      {IconCmp ? <IconCmp size={18} className="text-subtle" /> : null}
      <div style={{ minWidth: 0 }}>
        <h2 className="card__title" id={id}>
          {title}
        </h2>
        {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="card__actions">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ flush = false, className = '', children }) {
  return (
    <div className={`card__body${flush ? ' card__body--flush' : ''} ${className}`}>{children}</div>
  );
}

export function CardFooter({ children }) {
  return <footer className="card__footer">{children}</footer>;
}

/* ------------------------------------------------------------------ Fields */

export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="field">
      {label ? (
        <label className="field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="field__error" role="alert">
          <AlertCircleIcon size={13} />
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextField({ label, hint, error, icon: IconCmp, suffix, ...inputProps }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <div className="input-group">
        {IconCmp ? <IconCmp size={15} className="input-group__icon" /> : null}
        <input
          id={id}
          className="input"
          aria-invalid={error ? 'true' : undefined}
          {...inputProps}
        />
        {suffix ? <span className="input-group__suffix">{suffix}</span> : null}
      </div>
    </Field>
  );
}

export function SelectField({ label, hint, error, children, ...selectProps }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <select id={id} className="select" {...selectProps}>
        {children}
      </select>
    </Field>
  );
}

/**
 * Quantity stepper. Used on product cards and cart lines, so the two cannot
 * drift apart in behaviour or style.
 */
export function Stepper({ value, onChange, min = 1, max = 99, label = 'Quantity' }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label="Decrease quantity"
      >
        <MinusIcon size={13} />
      </button>
      <span className="stepper__value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label="Increase quantity"
      >
        <PlusIcon size={13} />
      </button>
    </div>
  );
}

export function Switch({ checked, onChange, label, name }) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function SegmentedControl({ options, value, onChange, size = 'md', ariaLabel }) {
  return (
    <div
      className={`segmented${size === 'sm' ? ' segmented--sm' : ''}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- Alert */

const ALERT_TONES = {
  info: { cls: 'alert--info', Icon: InfoIcon },
  success: { cls: 'alert--success', Icon: CheckCircleIcon },
  warning: { cls: 'alert--warning', Icon: AlertTriangleIcon },
  danger: { cls: 'alert--danger', Icon: AlertCircleIcon },
};

export function Alert({ tone = 'info', title, children, actions, icon = true }) {
  const { cls, Icon: ToneIcon } = ALERT_TONES[tone] ?? ALERT_TONES.info;
  return (
    <div className={`alert ${cls}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon ? <ToneIcon size={17} className="alert__icon" /> : null}
      <div className="alert__body" style={{ flex: 1 }}>
        {title ? <p className="alert__title">{title}</p> : null}
        {children}
        {actions ? (
          <div className="cluster" style={{ marginTop: 12 }}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Stats */

export function StatTile({ label, value, unit, meta, tone = 'neutral' }) {
  return (
    <div className={`stat${tone !== 'neutral' ? ` stat--${tone}` : ''}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </span>
      {meta ? <span className="stat__meta">{meta}</span> : null}
    </div>
  );
}

export function StackedBar({ segments, ariaLabel }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="stacked-bar" role="img" aria-label={ariaLabel}>
      {segments.map((segment) => (
        <div
          key={segment.tone}
          className={`stacked-bar__seg stacked-bar__seg--${segment.tone}`}
          style={{ width: total ? `${(segment.value / total) * 100}%` : '0%' }}
          title={`${segment.label}: ${segment.value}`}
        />
      ))}
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="legend__item" key={item.label}>
          <span
            className="legend__swatch"
            style={{
              background:
                item.tone === 'confirmed'
                  ? 'var(--success)'
                  : item.tone === 'rejected'
                    ? 'var(--danger)'
                    : 'var(--warning)',
            }}
          />
          {item.label}
          <strong className="tnum" style={{ color: 'var(--text)' }}>
            {item.value}
          </strong>
        </span>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- Skeleton */

export function Skeleton({ variant = 'text', width, height, style }) {
  return (
    <span
      className={`skeleton skeleton--${variant}`}
      style={{ width, height, display: 'block', ...style }}
      aria-hidden="true"
    />
  );
}

export function SkeletonCardGrid({ count = 6 }) {
  return (
    <div className="product-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="product-card" key={index}>
          <Skeleton variant="block" style={{ height: 116, borderRadius: 0 }} />
          <div className="product-card__body">
            <Skeleton variant="title" width="72%" />
            <Skeleton variant="text" width="46%" />
            <Skeleton variant="pill" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonTableRows({ rows = 5, cols = 4 }) {
  return (
    <div style={{ padding: 'var(--sp-4) var(--sp-5)' }} aria-hidden="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: 'var(--sp-4)',
            padding: '10px 0',
          }}
        >
          {Array.from({ length: cols }, (_, colIndex) => (
            <Skeleton key={colIndex} variant="text" width={colIndex === 0 ? '60%' : '38%'} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Empty state */

export function EmptyState({ icon: IconCmp, title, body, actions }) {
  return (
    <div className="empty">
      {IconCmp ? (
        <span className="empty__icon">
          <IconCmp size={20} />
        </span>
      ) : null}
      <p className="empty__title">{title}</p>
      {body ? <p className="empty__body">{body}</p> : null}
      {actions ? <div className="empty__actions">{actions}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------- Small bits */

export function KeyValue({ rows }) {
  return (
    <dl className="kv">
      {rows.map((row) => (
        <div key={row.k} style={{ display: 'contents' }}>
          <dt className="kv__k">{row.k}</dt>
          <dd className="kv__v">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CheckList({ items }) {
  return (
    <div className="check-list">
      {items.map((item) => (
        <div className="check-list__item" key={item.label}>
          <span className={`check-list__mark${item.ok ? '' : ' check-list__mark--bad'}`}>
            {item.ok ? <CheckIcon size={11} strokeWidth={2.5} /> : <ClockIcon size={11} />}
          </span>
          <span className="check-list__text">
            <strong>{item.label}</strong> {item.detail}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Disclosure({ summary, children, defaultOpen = false }) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="disclosure__content">{children}</div>
    </details>
  );
}

export function Spinner({ large = false, label }) {
  return (
    <span className={`spinner${large ? ' spinner--lg' : ''}`} role="status">
      <span className="visually-hidden">{label ?? 'Loading'}</span>
    </span>
  );
}

export function LoadingRow({ label = 'Loading…' }) {
  return (
    <div className="loading-row" role="status">
      <Spinner />
      {label}
    </div>
  );
}

/**
 * Product art. The catalogue has no images, so a deterministic tinted panel
 * derived from the SKU stands in — consistent between the grid, the cart and the
 * admin table, and obviously deliberate rather than a broken <img>.
 */
export function productTileStyle(sku = '') {
  let hash = 0;
  for (let i = 0; i < sku.length; i += 1) hash = (hash * 31 + sku.charCodeAt(i)) % 360;
  return { '--tile-h': hash, '--tile-h2': (hash + 32) % 360 };
}

export function monogram(name = '') {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
