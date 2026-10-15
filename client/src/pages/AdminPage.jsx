import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  BoltIcon,
  CheckCircleIcon,
  DatabaseIcon,
  InfoIcon,
  PulseIcon,
  RefreshIcon,
  ShieldIcon,
  TrendUpIcon,
} from '../components/icons.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckList,
  EmptyState,
  Legend,
  LoadingRow,
  SegmentedControl,
  SelectField,
  StackedBar,
  StatTile,
  TextField,
} from '../components/ui.jsx';
import { formatMinor, formatRelative } from '../lib/format.js';

const BUYER_PRESETS = [
  { value: '10', label: '10' },
  { value: '50', label: '50' },
  { value: '200', label: '200' },
  { value: '500', label: '500' },
];

/** The seven invariants, as the reconciliation report checks them. */
const INVARIANTS = [
  { code: 'I1', label: 'I1', detail: 'available = onHand − reserved' },
  { code: 'I2', label: 'I2', detail: 'no counter is negative' },
  { code: 'I3', label: 'I3', detail: 'reserved = Σ units held by pending orders' },
  { code: 'I4', label: 'I4', detail: 'no order is stranded past its reservation' },
  { code: 'I5', label: 'I5', detail: 'every order line points at a real product' },
  { code: 'I6', label: 'I6', detail: 'every payment attempt belongs to an order' },
  { code: 'I7', label: 'I7', detail: 'no idempotency claim without its order' },
];

/**
 * A Lab default that is actually interesting: the SCARCEST product. Running a
 * concurrency demo against 200 units proves nothing; running it against 10
 * proves the thing that matters.
 */
function prepareInventory(inventory) {
  const bySku = [...inventory].sort((a, b) => a.sku.localeCompare(b.sku));
  const scarcest =
    [...inventory].filter((p) => p.available > 0).sort((a, b) => a.available - b.available)[0] ??
    bySku[0];
  return { bySku, scarcestId: scarcest?.productId ?? '' };
}

export default function AdminPage() {
  const toast = useToast();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sweeping, setSweeping] = useState(false);

  const [productId, setProductId] = useState('');
  const [buyers, setBuyers] = useState('200');
  const [quantity, setQuantity] = useState(1);
  const [targetStock, setTargetStock] = useState(10);
  const [lab, setLab] = useState(null);
  const [labBusy, setLabBusy] = useState(false);
  const [labError, setLabError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const labStart = useRef(0);

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

  const { bySku, scarcestId } = prepareInventory(report?.inventory ?? []);
  const selected = report?.inventory.find((product) => product.productId === productId) ?? null;

  useEffect(() => {
    if (!productId && scarcestId) setProductId(scarcestId);
  }, [productId, scarcestId]);

  // A live counter while the Lab runs: 200 concurrent transactions take real
  // time, and a frozen spinner reads as a hung page.
  useEffect(() => {
    if (!labBusy) return undefined;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((Date.now() - labStart.current) / 1000), 100);
    return () => clearInterval(timer);
  }, [labBusy]);

  const totals = useMemo(() => {
    const inventory = report?.inventory ?? [];
    const ordersByStatus = report?.ordersByStatus ?? {};
    return {
      skus: inventory.length,
      onHand: inventory.reduce((sum, p) => sum + p.onHand, 0),
      reserved: inventory.reduce((sum, p) => sum + p.reserved, 0),
      soldOut: inventory.filter((p) => p.available === 0).length,
      low: inventory.filter((p) => p.available > 0 && p.available <= 5).length,
      paid: (ordersByStatus.paid ?? 0) + (ordersByStatus.fulfilled ?? 0),
      orders: Object.values(ordersByStatus).reduce((sum, n) => sum + n, 0),
    };
  }, [report]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function restock(product, units) {
    try {
      await api.restock(product.productId, units);
      toast.success(`Restocked ${product.sku}`, `+${units} units added to available stock.`);
      await load();
    } catch (err) {
      toast.error('Restock failed', err.message);
    }
  }

  /** Bring available stock up to exactly N, using only additive restocks. */
  async function resetStock() {
    if (!selected) return;
    const delta = Number(targetStock) - selected.available;
    if (delta < 0) {
      setLabError(
        `Inventory is never destroyed through the API: ${selected.sku} has ${selected.available} available, and stock only leaves through a reservation or a sale. Restock is additive by design.`,
      );
      return;
    }
    setLabError(null);
    if (delta > 0) await api.restock(selected.productId, delta);
    await load();
    toast.success(`${selected.sku} set to ${targetStock} available`, delta === 0 ? 'Already there.' : `+${delta} units.`);
  }

  async function runLab() {
    if (!selected) return;
    setLabBusy(true);
    setLab(null);
    setLabError(null);
    labStart.current = Date.now();
    try {
      const { data } = await api.concurrencyLab({
        productId: selected.productId,
        buyers: Number(buyers),
        quantityPerBuyer: Number(quantity),
      });
      setLab(data);
      const passed =
        !data.oversold && data.invariantsHeld && data.soldQuantity === data.expectedConfirmed;
      if (passed) {
        toast.success(
          'No overselling',
          `${data.tally.confirmed} confirmed for ${data.initialAvailable} available units.`,
        );
      } else {
        toast.error('The Lab found a problem', 'See the result panel for details.');
      }
    } catch (err) {
      setLabError(err.message);
      toast.error('The Lab could not complete', err.message);
    } finally {
      setLabBusy(false);
      await load();
    }
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
  const labTotal = lab ? lab.tally.confirmed + lab.tally.outOfStock + lab.tally.other : 0;
  const labPassed =
    lab && !lab.oversold && lab.invariantsHeld && lab.soldQuantity === lab.expectedConfirmed;

  const invariantItems = INVARIANTS.map((invariant) => {
    const related = problems.filter((problem) => String(problem.I) === invariant.code);
    return {
      label: invariant.label,
      detail: related.length === 0 ? `${invariant.detail} — holding` : `${invariant.detail} — ${related.length} violation(s)`,
      ok: related.length === 0,
    };
  });

  const leftoverOrderStates = Object.entries(report.ordersByStatus ?? {}).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <>
      {/* Freshness and health, not the page name — the top bar has that. */}
      <div className="page-head">
        <div className="page-head__text">
          <p className="page-head__sub">Reconciled {formatRelative(report.checkedAt)}.</p>
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

      <div className="kpi-grid">
        <StatTile
          label="Invariants"
          value={report.consistent ? 'Holding' : 'Violated'}
          tone={report.consistent ? 'success' : 'danger'}
          meta={`7 checks · ${problems.length} problem(s)`}
        />
        <StatTile label="Units on hand" value={totals.onHand} meta={`${totals.skus} SKUs tracked`} />
        <StatTile
          label="Units reserved"
          value={totals.reserved}
          tone={totals.reserved > 0 ? 'accent' : 'neutral'}
          meta="Held by unpaid orders"
        />
        <StatTile
          label="Unavailable"
          value={totals.soldOut}
          tone={totals.soldOut > 0 ? 'warning' : 'neutral'}
          meta={`${totals.low} low on stock`}
        />
        <StatTile
          label="Paid orders"
          value={totals.paid}
          meta={`${totals.orders} total across all states`}
        />
        <StatTile
          label="Refund obligations"
          value={obligations.length}
          tone={obligations.length > 0 ? 'danger' : 'success'}
          meta={obligations.length > 0 ? 'Money taken, order unfulfilled' : 'None outstanding'}
        />
      </div>

      <div className="split-grid">
        <Card>
          <CardHeader
            title="Inventory"
            subtitle="Counters are the server's own figures, not a client calculation."
            icon={DatabaseIcon}
            actions={<Badge tone="neutral">{bySku.length} products</Badge>}
          />
          <CardBody flush>
            <div className="table-wrap">
              <table className="table table--hover">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="is-numeric">onHand</th>
                    <th className="is-numeric">reserved</th>
                    <th className="is-numeric">available</th>
                    <th className="is-actions">Restock</th>
                  </tr>
                </thead>
                <tbody>
                  {bySku.map((product) => (
                    <tr key={product.productId}>
                      <td className="mono">{product.sku}</td>
                      <td className="table__primary">{product.name}</td>
                      <td className="is-numeric text-muted">{product.onHand}</td>
                      <td className="is-numeric">
                        {product.reserved > 0 ? (
                          <Badge tone="accent">{product.reserved}</Badge>
                        ) : (
                          <span className="text-subtle">0</span>
                        )}
                      </td>
                      <td className="is-numeric">
                        <Badge
                          tone={
                            product.available === 0
                              ? 'danger'
                              : product.available <= 5
                                ? 'warning'
                                : 'success'
                          }
                        >
                          {product.available}
                        </Badge>
                      </td>
                      <td className="is-actions">
                        <div className="cluster" style={{ justifyContent: 'flex-end' }}>
                          <Button size="sm" variant="default" onClick={() => restock(product, 10)}>
                            +10
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => restock(product, 100)}>
                            +100
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>

        <div className="stack">
          <Card>
            <CardHeader
              title="Reconciliation"
              subtitle="Executable invariants, run against live data."
              icon={ShieldIcon}
            />
            <CardBody>
              <CheckList items={invariantItems} />
              {problems.length > 0 ? (
                <pre className="code-block" style={{ marginTop: 'var(--sp-4)', color: 'var(--danger)' }}>
                  {JSON.stringify(problems, null, 2)}
                </pre>
              ) : null}
            </CardBody>
          </Card>

          {obligations.length > 0 ? (
            <Card>
              <CardHeader
                title={`${obligations.length} refund obligation(s)`}
                subtitle="Money was taken for an order that could not be fulfilled."
              />
              <CardBody flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th className="is-numeric">Amount</th>
                        <th>Provider ref</th>
                      </tr>
                    </thead>
                    <tbody>
                      {obligations.map((obligation) => (
                        <tr key={obligation.paymentAttemptId}>
                          <td className="mono">{obligation.orderNumber}</td>
                          <td className="is-numeric">{formatMinor(obligation.amountMinor)}</td>
                          <td className="mono text-muted">{obligation.providerRef ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Orders by status" icon={TrendUpIcon} />
            <CardBody>
              {leftoverOrderStates.length === 0 ? (
                <EmptyState
                  icon={InfoIcon}
                  title="No orders yet"
                  body="Place an order from the catalogue and its state will appear here."
                />
              ) : (
                <div className="stack-sm">
                  {leftoverOrderStates.map(([state, count]) => (
                    <div key={state}>
                      <div className="totals" style={{ padding: '2px 0' }}>
                        <span className="totals__label">{state.replace(/_/g, ' ')}</span>
                        <span className="totals__value">{count}</span>
                      </div>
                      <div className="progress" style={{ height: 5 }}>
                        <div
                          className="progress__fill"
                          style={{
                            width: `${totals.orders ? (count / totals.orders) * 100 : 0}%`,
                            background:
                              state === 'paid' || state === 'fulfilled'
                                ? 'var(--success)'
                                : state === 'pending_payment'
                                  ? 'var(--warning)'
                                  : 'var(--danger)',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <Card>
          <CardHeader
            title="Concurrency Lab"
            subtitle="Fire genuinely concurrent checkouts at one product, then read the tally against a live invariant check."
            icon={BoltIcon}
            actions={
              lab ? (
                <Badge tone={labPassed ? 'success' : 'danger'} dot>
                  {labPassed ? 'No overselling' : 'Review required'}
                </Badge>
              ) : null
            }
          />
          <CardBody>
            <div className="split-grid">
              <div className="stack">
                <SelectField
                  label="Target product"
                  value={productId}
                  onChange={(event) => setProductId(event.target.value)}
                  hint="Defaults to the scarcest product with stock — the case worth proving."
                >
                  {bySku.map((product) => (
                    <option key={product.productId} value={product.productId}>
                      {product.sku} — {product.name} ({product.available} available)
                    </option>
                  ))}
                </SelectField>

                <div>
                  <p className="field__label" style={{ marginBottom: 6 }}>
                    Concurrent buyers
                  </p>
                  <div className="preset-row">
                    <SegmentedControl
                      ariaLabel="Number of concurrent buyers"
                      value={buyers}
                      onChange={setBuyers}
                      options={BUYER_PRESETS}
                    />
                    <TextField
                      aria-label="Custom buyer count"
                      type="number"
                      min="1"
                      max="500"
                      value={buyers}
                      onChange={(event) => setBuyers(event.target.value)}
                      style={{ width: 92 }}
                    />
                  </div>
                </div>

                <div className="preset-row">
                  <TextField
                    label="Units per buyer"
                    type="number"
                    min="1"
                    max="10"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    style={{ width: 120 }}
                  />
                  <TextField
                    label="Reset available stock to"
                    type="number"
                    min="0"
                    value={targetStock}
                    onChange={(event) => setTargetStock(Number(event.target.value))}
                    style={{ width: 150 }}
                  />
                  <div style={{ alignSelf: 'flex-end' }}>
                    <Button variant="default" onClick={resetStock} disabled={!selected}>
                      Set stock
                    </Button>
                  </div>
                </div>

                {selected ? (
                  <Alert tone="info" icon={false}>
                    <span className="mono">
                      {selected.sku}: onHand {selected.onHand} · reserved {selected.reserved} ·
                      available {selected.available}
                    </span>
                  </Alert>
                ) : null}

                <Button
                  variant="primary"
                  size="lg"
                  icon={BoltIcon}
                  loading={labBusy}
                  onClick={runLab}
                  disabled={!selected || Number(buyers) < 1}
                >
                  {labBusy
                    ? `Firing ${buyers} checkouts… ${elapsed.toFixed(1)}s`
                    : `Fire ${buyers} concurrent checkouts`}
                </Button>

                {labError ? <Alert tone="warning" title="Lab could not run">{labError}</Alert> : null}
              </div>

              <div className="stack">
                {labBusy ? (
                  <Card>
                    <CardBody>
                      <LoadingRow
                        label={`${buyers} concurrent checkouts in flight, ${quantity} unit(s) each…`}
                      />
                    </CardBody>
                  </Card>
                ) : lab ? (
                  <>
                    <div className={`verdict ${labPassed ? 'verdict--pass' : 'verdict--fail'}`}>
                      <CheckCircleIcon size={20} />
                      <span>
                        <span className="verdict__text">
                          {labPassed
                            ? `Exactly ${lab.expectedConfirmed} sales, and not one more`
                            : 'The tally does not match what the stock allowed'}
                        </span>
                        <span className="verdict__sub" style={{ display: 'block' }}>
                          {lab.initialAvailable} available before · {lab.soldQuantity} units recorded
                          as sold · {lab.durationMs} ms
                        </span>
                      </span>
                    </div>

                    <StackedBar
                      ariaLabel={`${lab.tally.confirmed} confirmed, ${lab.tally.outOfStock} rejected, ${lab.tally.other} other`}
                      segments={[
                        { tone: 'confirmed', label: 'Confirmed', value: lab.tally.confirmed },
                        { tone: 'rejected', label: 'Out of stock', value: lab.tally.outOfStock },
                        { tone: 'other', label: 'Other', value: lab.tally.other },
                      ]}
                    />
                    <Legend
                      items={[
                        { tone: 'confirmed', label: 'Confirmed', value: lab.tally.confirmed },
                        { tone: 'rejected', label: 'Out of stock', value: lab.tally.outOfStock },
                        { tone: 'other', label: 'Other', value: lab.tally.other },
                      ]}
                    />

                    <div className="lab-result-grid">
                      <StatTile label="Confirmed" value={lab.tally.confirmed} tone="success" />
                      <StatTile label="Rejected" value={lab.tally.outOfStock} tone="danger" />
                      <StatTile
                        label="Oversold"
                        value={lab.oversold ? 'Yes' : 'No'}
                        tone={lab.oversold ? 'danger' : 'success'}
                      />
                      <StatTile
                        label="Invariants"
                        value={lab.invariantsHeld ? 'Hold' : 'Broken'}
                        tone={lab.invariantsHeld ? 'success' : 'danger'}
                      />
                    </div>

                    <div className="table-wrap">
                      <table className="table">
                        <tbody>
                          <tr>
                            <td className="text-muted">Available before</td>
                            <td className="is-numeric">{lab.initialAvailable}</td>
                          </tr>
                          <tr>
                            <td className="text-muted">Expected confirmations</td>
                            <td className="is-numeric">{lab.expectedConfirmed}</td>
                          </tr>
                          <tr>
                            <td className="text-muted">Units actually sold</td>
                            <td className="is-numeric table__primary">{lab.soldQuantity}</td>
                          </tr>
                          <tr>
                            <td className="text-muted">Final onHand / reserved / available</td>
                            <td className="is-numeric mono">
                              {lab.finalCounters.onHand} / {lab.finalCounters.reserved} /{' '}
                              {lab.finalCounters.available}
                            </td>
                          </tr>
                          <tr>
                            <td className="text-muted">Other outcomes</td>
                            <td className="is-numeric">
                              {lab.tally.other}
                              {lab.tally.otherCodes?.length
                                ? ` (${lab.tally.otherCodes.join(', ')})`
                                : ''}
                            </td>
                          </tr>
                          <tr>
                            <td className="text-muted">Duration</td>
                            <td className="is-numeric">{lab.durationMs} ms</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {lab.invariantProblems?.length > 0 ? (
                      <Alert tone="danger" title="Invariant problems after the run">
                        <pre className="code-block">
                          {JSON.stringify(lab.invariantProblems, null, 2)}
                        </pre>
                      </Alert>
                    ) : null}

                    {lab.note ? <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>{lab.note}</p> : null}
                  </>
                ) : (
                  <Card>
                    <CardBody>
                      <EmptyState
                        icon={BoltIcon}
                        title="Nothing has run yet"
                        body={`Set a stock level, then fire ${buyers} checkouts at once. With 10 units and 200 buyers, exactly 10 must succeed — and the units recorded against inventory must equal 10.`}
                      />
                    </CardBody>
                  </Card>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
