import { useCallback, useEffect, useMemo, useState } from 'react';
import CommandPalette from './components/CommandPalette.jsx';
import {
  BagIcon,
  CartIcon,
  ChevronDownIcon,
  CopyIcon,
  GaugeIcon,
  GridIcon,
  KeyboardIcon,
  LogoutIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  ReceiptIcon,
  RefreshIcon,
  SearchIcon,
  SunIcon,
  UserIcon,
} from './components/icons.jsx';
import { Menu } from './components/Menu.jsx';
import ShortcutsDialog from './components/ShortcutsDialog.jsx';
import { ToastProvider, useToast } from './components/Toast.jsx';
import { useGlobalShortcuts, modKeyLabel } from './hooks/useGlobalShortcuts.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { EVENTS, emitOnce } from './lib/bus.js';
import AdminPage from './pages/AdminPage.jsx';
import AuthPage from './pages/AuthPage.jsx';
import CartPage from './pages/CartPage.jsx';
import CatalogPage from './pages/CatalogPage.jsx';
import OrdersPage from './pages/OrdersPage.jsx';
import { AuthProvider, useAuth } from './state/AuthContext.jsx';
import { CartProvider, useCart } from './state/CartContext.jsx';
import { ThemeProvider, useTheme } from './state/ThemeContext.jsx';

/**
 * The shell.
 *
 * Everything reachable by mouse is reachable by keyboard, and the two share one
 * source of truth: the same `navigate` used by the sidebar drives the palette
 * and the `g`-chords, so a new view cannot be added to one and forgotten in the
 * other.
 */

const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };

const ROUTES = {
  shop: { title: 'Catalogue', meta: 'Availability is live: on hand minus reserved.' },
  cart: { title: 'Cart', meta: 'Review and place your order.' },
  orders: { title: 'Orders', meta: 'Every checkout, successful or not.' },
  admin: { title: 'Operations', meta: 'Inventory, reconciliation and the Concurrency Lab.' },
  signin: { title: 'Sign in', meta: null },
};

function initials(email = '') {
  const [name] = email.split('@');
  return (name || '?').slice(0, 2);
}

function Sidebar({ route, navigate, tabs, user, isAdmin, onSignOut, onShowShortcuts }) {
  const accountItems = user
    ? [
        { type: 'label', label: isAdmin ? 'Administrator' : 'Customer' },
        {
          id: 'account-email',
          label: user.email,
          icon: UserIcon,
          hint: 'Copy address',
          onSelect: () => {
            navigator.clipboard?.writeText(user.email).catch(() => {});
          },
        },
        { type: 'separator' },
        {
          id: 'shortcuts',
          label: 'Keyboard shortcuts',
          icon: KeyboardIcon,
          trailing: '?',
          onSelect: onShowShortcuts,
        },
        { type: 'separator' },
        { id: 'signout', label: 'Sign out', icon: LogoutIcon, tone: 'danger', onSelect: onSignOut },
      ]
    : [];

  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true">
          <BagIcon size={17} />
        </span>
        <span className="brand-text">
          <span className="brand-text__name">Meridian Supply</span>
          <span className="brand-text__env">Order operations</span>
        </span>
      </div>

      <nav className="sidebar__nav">
        <p className="nav-section">Storefront</p>
        {tabs
          .filter((tab) => tab.group === 'store')
          .map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="nav-item"
              aria-current={route === tab.id ? 'page' : undefined}
              onClick={() => navigate(tab.id)}
            >
              <tab.Icon size={16} />
              <span className="nav-item__label">{tab.label}</span>
              {tab.count ? <span className="nav-item__count">{tab.count}</span> : null}
            </button>
          ))}

        {isAdmin ? (
          <>
            <p className="nav-section">Operations</p>
            {tabs
              .filter((tab) => tab.group === 'ops')
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="nav-item"
                  aria-current={route === tab.id ? 'page' : undefined}
                  onClick={() => navigate(tab.id)}
                >
                  <tab.Icon size={16} />
                  <span className="nav-item__label">{tab.label}</span>
                </button>
              ))}
          </>
        ) : null}
      </nav>

      <div className="sidebar__footer">
        {user ? (
          <Menu items={accountItems} side="up" align="stretch">
            {(triggerProps) => (
              <button
                type="button"
                className="user-card user-card--button"
                aria-label={`Account menu for ${user.email}`}
                {...triggerProps}
              >
                <span className="avatar" aria-hidden="true">
                  {initials(user.email)}
                </span>
                <span className="user-card__meta">
                  <span className="user-card__name">{user.email}</span>
                  <span className="user-card__role">{isAdmin ? 'Administrator' : 'Customer'}</span>
                </span>
                <ChevronDownIcon size={15} className="user-card__chevron" />
              </button>
            )}
          </Menu>
        ) : (
          <button
            type="button"
            className="btn btn--default btn--block"
            onClick={() => navigate('signin')}
          >
            <UserIcon size={15} />
            Sign in
          </button>
        )}
      </div>
    </aside>
  );
}

function Shell() {
  const { user, logout, isAdmin, loading } = useAuth();
  const { count } = useCart();
  const { preference, setTheme } = useTheme();
  const toast = useToast();
  const [route, navigate] = useHashRoute('shop', ['shop', 'cart', 'orders', 'admin', 'signin']);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const tabs = useMemo(
    () => [
      { id: 'shop', label: 'Catalogue', group: 'store', Icon: GridIcon },
      { id: 'cart', label: 'Cart', group: 'store', Icon: CartIcon, count },
      { id: 'orders', label: 'Orders', group: 'store', Icon: ReceiptIcon },
      { id: 'admin', label: 'Operations', group: 'ops', Icon: GaugeIcon },
    ],
    [count],
  );

  // Views that need a session, and views a signed-in user has no business on.
  useEffect(() => {
    if (loading) return;
    if (!user && (route === 'orders' || route === 'admin')) navigate('signin');
    if (user && route === 'signin') navigate('shop');
    if (user && !isAdmin && route === 'admin') navigate('shop');
  }, [loading, user, isAdmin, route, navigate]);

  useEffect(() => {
    setNavOpen(false);
  }, [route]);

  const mod = modKeyLabel();

  const palettePages = useMemo(() => {
    const pages = [
      {
        id: 'shop',
        label: 'Catalogue',
        meta: 'Browse products and live availability',
        keywords: 'shop store products inventory browse',
        Icon: GridIcon,
        run: () => navigate('shop'),
      },
      {
        id: 'cart',
        label: 'Cart',
        meta: count > 0 ? `${count} item${count === 1 ? '' : 's'} waiting` : 'Empty',
        keywords: 'basket checkout order',
        Icon: CartIcon,
        run: () => navigate('cart'),
      },
    ];

    if (user) {
      pages.push({
        id: 'orders',
        label: 'Orders',
        meta: 'Purchase history and payment outcomes',
        keywords: 'history receipts purchases payments',
        Icon: ReceiptIcon,
        run: () => navigate('orders'),
      });
    } else {
      pages.push({
        id: 'signin',
        label: 'Sign in',
        meta: 'Access your orders',
        keywords: 'login auth account session',
        Icon: UserIcon,
        run: () => navigate('signin'),
      });
    }

    if (isAdmin) {
      pages.push({
        id: 'admin',
        label: 'Operations console',
        meta: 'Inventory, reconciliation and the Concurrency Lab',
        keywords: 'admin inventory reconcile sweep lab concurrency oversell',
        Icon: GaugeIcon,
        run: () => navigate('admin'),
      });
    }

    return pages;
  }, [navigate, count, user, isAdmin]);

  const paletteActions = useMemo(() => {
    const actions = [
      {
        id: 'focus-search',
        label: 'Search the catalogue',
        hint: 'Jump to the catalogue and focus its search field',
        keywords: 'find filter query',
        Icon: SearchIcon,
        run: () => {
          navigate('shop');
          emitOnce(EVENTS.focusCatalogueSearch, {});
        },
      },
      {
        id: 'refresh-catalogue',
        label: 'Refresh catalogue',
        hint: 'Re-fetch prices and availability',
        keywords: 'reload sync update stock',
        Icon: RefreshIcon,
        run: () => {
          navigate('shop');
          emitOnce(EVENTS.refreshView, null);
        },
      },
      ...['system', 'light', 'dark'].map((option) => ({
        id: `theme-${option}`,
        label: `Theme: ${option}`,
        hint: option === 'system' ? 'Match the operating system' : `Always ${option}`,
        keywords: 'appearance dark light colour color contrast',
        Icon: THEME_ICON[option],
        trailing: preference === option ? 'current' : undefined,
        run: () => setTheme(option),
      })),
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        hint: 'See every binding',
        Icon: KeyboardIcon,
        trailing: '?',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'copy-link',
        label: 'Copy link to this view',
        hint: 'Share exactly what you are looking at',
        keywords: 'share url clipboard',
        Icon: CopyIcon,
        run: () => {
          navigator.clipboard
            ?.writeText(window.location.href)
            .then(() => toast.success('Link copied', window.location.href))
            .catch(() => toast.error('Could not copy the link', 'Your browser blocked clipboard access.'));
        },
      },
    ];

    if (user) {
      actions.push({
        id: 'signout',
        label: 'Sign out',
        hint: user.email,
        keywords: 'logout exit',
        Icon: LogoutIcon,
        run: () => {
          logout();
          navigate('shop');
        },
      });
    } else {
      actions.push({
        id: 'signin-action',
        label: 'Sign in',
        hint: 'Seeded accounts are listed on the sign-in screen',
        keywords: 'login',
        Icon: UserIcon,
        run: () => navigate('signin'),
      });
    }

    return actions;
  }, [navigate, preference, setTheme, user, logout, toast]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  // The shell owns the keymap: one declaration, checked against the same routes
  // the sidebar renders, and suspended while a palette or dialog is on top so a
  // global binding never fights the layer the user is actually in.
  useGlobalShortcuts(
    [
      { combo: 'mod+k', run: openPalette },
      { combo: '?', run: openShortcuts },
      { combo: 'g s', run: () => navigate('shop') },
      { combo: 'g c', run: () => navigate('cart') },
      { combo: 'g o', run: () => (user ? navigate('orders') : navigate('signin')) },
      {
        combo: 'g a',
        run: () => {
          if (isAdmin) {
            navigate('admin');
            return;
          }
          // A chord that quietly does something else looks like a broken key.
          // Non-admins are told why the console is not open to them.
          toast.info(
            'Operations needs an administrator',
            'Sign in as admin@shop.test to open the console.',
          );
        },
      },
    ],
    { enabled: !paletteOpen && !shortcutsOpen },
  );

  if (!user && route === 'signin') {
    return <AuthPage onSignedIn={() => navigate('shop')} />;
  }

  const head = ROUTES[route] ?? ROUTES.shop;
  const ThemeIcon = THEME_ICON[preference] ?? MonitorIcon;

  const themeItems = [
    { type: 'label', label: 'Appearance' },
    { id: 'theme-system', label: 'System', hint: 'Match the operating system', icon: MonitorIcon, checked: preference === 'system', onSelect: () => setTheme('system') },
    { id: 'theme-light', label: 'Light', icon: SunIcon, checked: preference === 'light', onSelect: () => setTheme('light') },
    { id: 'theme-dark', label: 'Dark', icon: MoonIcon, checked: preference === 'dark', onSelect: () => setTheme('dark') },
    { type: 'separator' },
    { id: 'theme-shortcuts', label: 'Keyboard shortcuts', icon: KeyboardIcon, trailing: '?', onSelect: openShortcuts },
  ];

  return (
    <div className="app" data-nav-open={navOpen ? 'true' : 'false'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      {navOpen ? (
        <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      ) : null}

      <Sidebar
        route={route}
        navigate={navigate}
        tabs={tabs}
        user={user}
        isAdmin={isAdmin}
        onShowShortcuts={openShortcuts}
        onSignOut={() => {
          logout();
          navigate('shop');
        }}
      />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn--ghost btn--icon menu-toggle"
            onClick={() => setNavOpen((open) => !open)}
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
          >
            <MenuIcon size={17} />
          </button>

          <div className="topbar__head">
            <h1 className="topbar__title">{head.title}</h1>
            {head.meta ? <p className="topbar__meta">{head.meta}</p> : null}
          </div>

          <div className="topbar__actions">
            <button
              type="button"
              className="search-trigger"
              onClick={openPalette}
              aria-keyshortcuts="Meta+K Control+K"
              aria-label={`Search products, pages and actions (${mod}+K)`}
            >
              <SearchIcon size={15} />
              <span className="search-trigger__label">Search or jump to…</span>
              <span className="search-trigger__kbd" aria-hidden="true">
                <kbd className="kbd">{mod}</kbd>
                <kbd className="kbd">K</kbd>
              </span>
            </button>

            <Menu items={themeItems} side="down" align="end">
              {(triggerProps) => (
                <button
                  type="button"
                  className="btn btn--ghost btn--icon"
                  aria-label={`Appearance: ${preference}`}
                  title="Appearance"
                  {...triggerProps}
                >
                  <ThemeIcon size={17} />
                </button>
              )}
            </Menu>

            <button
              type="button"
              className="icon-btn"
              onClick={() => navigate('cart')}
              aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}
              title="Cart"
            >
              <CartIcon size={18} />
              {count > 0 ? <span className="icon-btn__dot">{count}</span> : null}
            </button>
          </div>
        </header>

        <main className="content" id="main">
          {loading ? (
            <p className="text-muted">Restoring your session…</p>
          ) : (
            <>
              {route === 'shop' && <CatalogPage onGoToCart={() => navigate('cart')} />}
              {route === 'cart' && <CartPage onBrowse={() => navigate('shop')} />}
              {route === 'orders' && <OrdersPage onBrowse={() => navigate('shop')} />}
              {route === 'admin' && isAdmin && <AdminPage />}
            </>
          )}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        pages={palettePages}
        actions={paletteActions}
      />

      <ShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <CartProvider>
          <ToastProvider>
            <Shell />
          </ToastProvider>
        </CartProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
