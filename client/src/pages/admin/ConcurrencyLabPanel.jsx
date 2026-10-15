import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { BoltIcon, CheckCircleIcon } from '../../components/icons.jsx';
import { useToast } from '../../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Legend,
  LoadingRow,
  SegmentedControl,
  SelectField,
  StackedBar,
  StatTile,
  TextField,
} from '../../components/ui.jsx';
import { prepareInventory } from './shared.jsx';

const BUYER_PRESETS = [
  { value: '10', label: '10' },
  { value: '50', label: '50' },
  { value: '200', label: '200' },
  { value: '500', label: '500' },
];

/**
 * The Concurrency Lab.
 *
 * Fires genuinely concurrent checkouts at one product and reports the tally,
 * the final counters and a live invariant check — so the anti-oversell guarantee
 * can be WATCHED rather than taken on trust from the test suite.
 */
export default function ConcurrencyLabPanel({ report, reload }) {
  const toast = useToast();

  const [productId, setProductId] = useState('');
  const [buyers, setBuyers] = useState('200');
  const [quantity, setQuantity] = useState(1);
  const [targetStock, setTargetStock] = useState(10);
  const [lab, setLab] = useState(null);
  const [labBusy, setLabBusy] = useState(false);
  const [labError, setLabError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const labStart = useRef(0);

  const { bySku, scarcestId } = prepareInventory(report.inventory ?? []);
  const selected = bySku.find((product) => product.productId === productId) ?? null;

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
    await reload();
    toast.success(
      `${selected.sku} set to ${targetStock} available`,
      delta === 0 ? 'Already there.' : `+${delta} units.`,
    );
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
      await reload();
    }
  }

  const labPassed =
    lab && !lab.oversold && lab.invariantsHeld && lab.soldQuantity === lab.expectedConfirmed;

  return (
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

            {labError ? (
              <Alert tone="warning" title="Lab could not run">
                {labError}
              </Alert>
            ) : null}
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
                      {lab.initialAvailable} available before · {lab.soldQuantity} units recorded as
                      sold · {lab.durationMs} ms
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

                {lab.note ? (
                  <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                    {lab.note}
                  </p>
                ) : null}
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
  );
}
