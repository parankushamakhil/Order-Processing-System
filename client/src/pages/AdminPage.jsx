import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  BoltIcon,
  DatabaseIcon,
  GaugeIcon,
  PulseIcon,
  ReceiptIcon,
  RefreshIcon,
  SlidersIcon,
} from '../components/icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { Alert, Badge, Button, Card, LoadingRow } from '../components/ui.jsx';
import { formatRelative } from '../lib/format.js';
import ConcurrencyLabPanel from './admin/ConcurrencyLabPanel.jsx';
import OrdersPanel from './admin/OrdersPanel.jsx';
import OverviewPanel from './admin/OverviewPanel.jsx';
import ProductsPanel from './admin/ProductsPanel.jsx';
import RefundsPanel from './admin/RefundsPanel.jsx';

const TABS = [
  { id: 'overview', label: 'Overview', Icon: GaugeIcon },
  { id: 'inventory', label: 'Inventory', Icon: DatabaseIcon },
  { id: 'orders', label: 'Orders', Icon: ReceiptIcon },
  { id: 'refunds', label: 'Refunds', Icon: SlidersIcon },
  { id: 'lab', label: 'Concurrency Lab', Icon: BoltIcon },
];

/**
 * The operations console.
 *
 * One reconciliation snapshot is loaded here and handed to every panel. That is
 * deliberate: the KPI tiles, the inventory table and the refund list are then
 * guaranteed to describe the same instant, and any mutation reloads the snapshot
 * rather than patching a panel's local copy — so the server always has the last
 * word on what the counters are.
 */
export default function AdminPage() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [ordersFilter, setOrdersFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await api.reconcile();
      setReport(data);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function runSweep() {
    setSweeping(true);
    try {
      const { data } = await api.sweep();
      toast.info(
        'Reaper finished',
        `Released ${data.released} expired reservation(s) out of ${data.scanned ?? 0} scanned.`,
      );
      await load();
    } catch (err) {
      toast.error('The reaper failed', err.message);
    } finally {
      setSweeping(false);
    }
  }

  function openOrders(status) {
    setOrdersFilter(status);
    setTab('orders');
  }

  if (error) {
    return (
      <Alert tone="danger" title="Could not load the operations report">
        {error.message}
      </Alert>
    );
  }

  if (!report) {
    return (
      <Card>
        <LoadingRow label="Loading the reconciliation report…" />
      </Card>
    );
  }

  const problems = report.problems ?? [];
  const obligations = report.refundObligations ?? [];

  return (
    <>
      {/* Freshness and health, not the page name — the top bar has that. */}
      <div className="page-head">
        <div className="page-head__text">
          <p className="page-head__sub">
            Reconciled {formatRelative(report.checkedAt)} · one snapshot shared by every panel.
          </p>
        </div>
        <div className="page-head__actions">
          <Badge tone={report.consistent ? 'success' : 'danger'} dot>
            {report.consistent ? 'All invariants hold' : `${problems.length} problem(s)`}
          </Badge>
          <Button variant="default" icon={RefreshIcon} onClick={refresh} loading={refreshing}>
            Refresh
          </Button>
          <Button variant="default" icon={PulseIcon} onClick={runSweep} loading={sweeping}>
            Run reaper now
          </Button>
        </div>
      </div>

      <Card>
        <div className="tabs" role="tablist" aria-label="Operations sections">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
            >
              <entry.Icon size={15} />
              {entry.label}
              {entry.id === 'refunds' && obligations.length > 0 ? (
                <span className="tab__count">{obligations.length}</span>
              ) : null}
            </button>
          ))}
        </div>
      </Card>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        {tab === 'overview' ? (
          <OverviewPanel
            report={report}
            onOpenOrders={openOrders}
            onOpenRefunds={() => setTab('refunds')}
          />
        ) : tab === 'inventory' ? (
          <ProductsPanel report={report} reload={load} />
        ) : tab === 'orders' ? (
          <OrdersPanel report={report} reload={load} initialStatus={ordersFilter} />
        ) : tab === 'refunds' ? (
          <RefundsPanel report={report} reload={load} />
        ) : (
          <ConcurrencyLabPanel report={report} reload={load} />
        )}
      </div>
    </>
  );
}
