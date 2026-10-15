import { useId, useState } from 'react';
import {
  BagIcon,
  BoltIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  ShieldIcon,
  UserIcon,
} from '../components/icons.jsx';
import { Alert, Button, Field, SegmentedControl } from '../components/ui.jsx';
import { useAuth } from '../state/AuthContext.jsx';

const SEEDED = [
  { role: 'Administrator', email: 'admin@shop.test', hint: 'Operations and the Concurrency Lab' },
  { role: 'Customer', email: 'shopper@shop.test', hint: 'Storefront only' },
];

const PASSWORD = 'password1234';

const POINTS = [
  {
    Icon: ShieldIcon,
    title: 'Stock cannot be oversold',
    body: 'Every reservation is a single conditional update, so two buyers racing for the last unit cannot both win.',
  },
  {
    Icon: BoltIcon,
    title: 'Retries are safe by construction',
    body: 'Checkout carries an idempotency key. A timeout, a double click or a network retry resolves to one order — never two.',
  },
  {
    Icon: BagIcon,
    title: 'Nothing is lost in the gaps',
    body: 'Declines, abandoned carts and interrupted payments all return their stock, and the reconciliation report proves it.',
  },
];

export default function AuthPage({ onSignedIn }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('shopper@shop.test');
  const [password, setPassword] = useState(PASSWORD);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const emailId = useId();
  const passwordId = useId();

  async function submit(event, customEmail, customPassword) {
    if (event?.preventDefault) event.preventDefault();
    setBusy(true);
    setError(null);
    const targetEmail = customEmail || email;
    const targetPassword = customPassword || password;
    try {
      let loggedUser;
      if (mode === 'signin') {
        loggedUser = await login(targetEmail, targetPassword);
      } else {
        loggedUser = await register(targetEmail, targetPassword, targetEmail.split('@')[0]);
      }
      onSignedIn?.(loggedUser);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <aside className="auth__aside">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="brand-mark" aria-hidden="true">
            <BagIcon size={17} />
          </span>
          <span className="brand-text">
            <span className="brand-text__name">Meridian Supply</span>
            <span className="brand-text__env">Order operations</span>
          </span>
        </div>

        <div>
          <h1 className="auth__headline">Inventory that tells the truth under load.</h1>
          <p className="auth__lede">
            A storefront and back office for teams who would rather explain a rejected checkout than
            a double sale.
          </p>
        </div>

        <div className="auth__points">
          {POINTS.map((point) => (
            <div className="auth__point" key={point.title}>
              <span className="auth__point-icon">
                <point.Icon size={15} />
              </span>
              <span>
                <strong>{point.title}.</strong> {point.body}
              </span>
            </div>
          ))}
        </div>
      </aside>

      <div className="auth__panel">
        <div className="auth__form">
          <div className="auth__form-head">
            <SegmentedControl
              ariaLabel="Authentication mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'signin', label: 'Sign in' },
                { value: 'register', label: 'Create account' },
              ]}
            />
          </div>

          {mode === 'signin' && (
            <div style={{ marginBottom: 'var(--sp-4)' }}>
              <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)', marginBottom: 'var(--sp-2)' }}>
                Choose role to sign in:
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: 'var(--sp-3)',
                    height: 'auto',
                    border: email === 'admin@shop.test' ? '2px solid var(--accent)' : '1px solid var(--border)',
                    borderRadius: 'var(--r-md)',
                    textAlign: 'left',
                    background: email === 'admin@shop.test' ? 'var(--surface-subtle)' : 'var(--surface)',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setEmail('admin@shop.test');
                    setPassword(PASSWORD);
                    submit(null, 'admin@shop.test', PASSWORD);
                  }}
                  title="Sign in as Administrator (Operations & Inventory Lab)"
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>
                    <ShieldIcon size={14} /> Admin
                  </div>
                  <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)', marginTop: 2 }}>
                    admin@shop.test
                  </span>
                </button>

                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: 'var(--sp-3)',
                    height: 'auto',
                    border: email === 'shopper@shop.test' ? '2px solid var(--accent)' : '1px solid var(--border)',
                    borderRadius: 'var(--r-md)',
                    textAlign: 'left',
                    background: email === 'shopper@shop.test' ? 'var(--surface-subtle)' : 'var(--surface)',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setEmail('shopper@shop.test');
                    setPassword(PASSWORD);
                    submit(null, 'shopper@shop.test', PASSWORD);
                  }}
                  title="Sign in as Customer (Storefront & Shopping Cart)"
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>
                    <UserIcon size={14} /> Customer
                  </div>
                  <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-subtle)', marginTop: 2 }}>
                    shopper@shop.test
                  </span>
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', margin: 'var(--sp-4) 0 var(--sp-2)', color: 'var(--text-subtle)', fontSize: 'var(--fs-xs)' }}>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                <span>or enter credentials</span>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
            </div>
          )}

          <form onSubmit={submit} className="stack" noValidate>
            <Field label="Work email" htmlFor={emailId}>
              <div className="input-group">
                <UserIcon size={15} className="input-group__icon" />
                <input
                  id={emailId}
                  className="input"
                  type="email"
                  name="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
            </Field>

            <Field
              label="Password"
              htmlFor={passwordId}
              hint={mode === 'register' ? 'At least 8 characters.' : undefined}
            >
              <div className="input-group">
                <LockIcon size={15} className="input-group__icon" />
                <input
                  id={passwordId}
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  required
                  style={{ paddingRight: 38 }}
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm"
                  style={{ position: 'absolute', right: 4 }}
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
                </button>
              </div>
            </Field>

            {error ? (
              <Alert tone="danger" title={mode === 'signin' ? 'Could not sign in' : 'Could not register'}>
                {error.message}
              </Alert>
            ) : null}

            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              {busy ? (mode === 'signin' ? 'Signing in…' : 'Creating account…') : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <div className="stack" style={{ marginTop: 'var(--sp-6)' }}>
            <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
              Demo accounts, created by <code>npm run seed:demo</code>. Password is{' '}
              <code>{PASSWORD}</code> for both.
            </p>
            <div className="seed-chips">
              {SEEDED.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  className="seed-chip"
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(PASSWORD);
                    setMode('signin');
                    setError(null);
                  }}
                  title={account.hint}
                >
                  <span aria-hidden="true">
                    {account.role === 'Administrator' ? <ShieldIcon size={13} /> : <UserIcon size={13} />}
                  </span>
                  {account.email}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
