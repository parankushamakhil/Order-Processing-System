import {
  DatabaseIcon,
  InfoIcon,
  ShieldIcon,
  SlidersIcon,
  TrendUpIcon,
} from '../../components/icons.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckList,
  EmptyState,
  StatTile,
} from '../../components/ui.jsx';
import { formatMinor } from '../../lib/format.js';
import { INVARIANTS, StatusPill, statusLabel } from './shared.jsx';

/**
 * The health of the system at a glance, then the detail behind each number.
 *
 * Every figure here comes from the reconciliation endpoint — the same function
 * the test suite runs after every integration test — so the console cannot be
 * showing a kinder story than the tests are held to.
 */
export default function OverviewPanel({ report, onOpenOrders, onOpenRefunds }) {
  const problems = report.problems ?? [];
  const obligations = report.refundObligations ?? [];
  const inventory = report.inventory ?? [];
  const ordersByStatus = report.ordersByStatus ?? {};

  const totalOrders = Object.values(ordersByStatus).reduce((sum, n) => sum + n, 0);
  const totals = {
    skus: inventory.length,
    onHand: inventory.reduce((sum, p) => sum + p.onHand, 0),
    reserved: inventory.reduce((sum, p) => sum + p.reserved, 0),
    unavailable: inventory.filter((p) => p.available === 0).length,
    low: inventory.filter((p) => p.available > 0 && p.available <= 5).length,
    inactive: inventory.filter((p) => p.isActive === false).length,
    paid: (ordersByStatus.paid ?? 0) + (ordersByStatus.fulfilled ?? 0),
  };

  const invariantItems = INVARIANTS.map((invariant) => {
    const related = problems.filter((problem) => String(problem.invariant) === invariant.code);
    return {
      label: invariant.code,
      detail:
        related.length === 0
          ? `${invariant.detail} — holding`
          : `${invariant.detail} — ${related.length} violation(s)`,
      ok: related.length === 0,
    };
  });

  const statuses = Object.entries(ordersByStatus).sort((a, b) => b[1] - a[1]);

  return (
    <>
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
          value={totals.unavailable}
          tone={totals.unavailable > 0 ? 'warning' : 'neutral'}
          meta={`${totals.low} low on stock`}
        />
        <StatTile
          label="Paid orders"
          value={totals.paid}
          meta={`${totalOrders} total across all states`}
        />
        <StatTile
          label="Refund obligations"
          value={obligations.length}
          tone={obligations.length > 0 ? 'danger' : 'success'}
          meta={obligations.length > 0 ? 'Money taken, order unfulfilled' : 'None outstanding'}
        />
      </div>

      {totals.inactive > 0 ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Alert tone="info" icon={false}>
            {totals.inactive} inactive product{totals.inactive === 1 ? '' : 's'} still hold their
            stock counters and are excluded from the storefront listing.
          </Alert>
        </div>
      ) : null}

      <div className="split-grid" style={{ marginTop: 'var(--sp-5)' }}>
        <Card>
          <CardHeader
            title="Reconciliation"
            subtitle="Executable invariants, run against live data — not a dashboard of cached figures."
            icon={ShieldIcon}
            actions={
              <Badge tone={report.consistent ? 'success' : 'danger'} dot>
                {report.consistent ? 'all hold' : `${problems.length} broken`}
              </Badge>
            }
          />
          <CardBody>
            <CheckList items={invariantItems} />
            {problems.length > 0 ? (
              <pre
                className="code-block"
                style={{ marginTop: 'var(--sp-4)', color: 'var(--danger)' }}
              >
                {JSON.stringify(problems, null, 2)}
              </pre>
            ) : (
              <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--sp-4)' }}>
                The same checker runs after every integration and concurrency test, so a test that
                leaves the database inconsistent fails even when it was testing something else.
              </p>
            )}
          </CardBody>
        </Card>

        <div className="stack">
          <Card>
            <CardHeader
              title="Orders by status"
              subtitle="Select a state to open the queue filtered to it."
              icon={TrendUpIcon}
            />
            <CardBody>
              {statuses.length === 0 ? (
                <EmptyState
                  icon={InfoIcon}
                  title="No orders yet"
                  body="Place an order from the catalogue and its state will appear here."
                />
              ) : (
                <div className="stack-sm">
                  {statuses.map(([status, count]) => (
                    <button
                      key={status}
                      type="button"
                      className="status-row"
                      onClick={() => onOpenOrders(status)}
                      title={`Open the queue filtered to ${statusLabel(status)}`}
                    >
                      <div className="totals" style={{ padding: '2px 0' }}>
                        <span className="totals__label">
                          <StatusPill status={status} dot={false} />
                        </span>
                        <span className="totals__value">{count}</span>
                      </div>
                      <div className="progress" style={{ height: 5 }}>
                        <div
                          className="progress__fill"
                          style={{
                            width: `${totalOrders ? (count / totalOrders) * 100 : 0}%`,
                            background:
                              status === 'paid' || status === 'fulfilled'
                                ? 'var(--success)'
                                : status === 'pending_payment'
                                  ? 'var(--warning)'
                                  : 'var(--danger)',
                          }}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Refund obligations"
              subtitle="The detect-and-compensate half of the charge-versus-expiry race."
              icon={SlidersIcon}
              actions={
                obligations.length > 0 ? (
                  <Button size="sm" variant="default" onClick={onOpenRefunds}>
                    Open refunds
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {obligations.length === 0 ? (
                <EmptyState
                  icon={SlidersIcon}
                  title="Nothing outstanding"
                  body="No charge has been taken for an order this system could not fulfil."
                />
              ) : (
                <div className="stack-sm">
                  {obligations.slice(0, 4).map((obligation) => (
                    <div className="totals" key={obligation.paymentAttemptId}>
                      <span className="totals__label mono">{obligation.orderNumber}</span>
                      <span className="totals__value mono">
                        {formatMinor(obligation.amountMinor)}
                      </span>
                    </div>
                  ))}
                  {obligations.length > 4 ? (
                    <p className="text-subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                      and {obligations.length - 4} more…
                    </p>
                  ) : null}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <Card>
          <CardHeader
            title="Inventory counters"
            subtitle="The largest holdings first. Counters are the server's own figures, never a client calculation."
            icon={DatabaseIcon}
            actions={<Badge tone="neutral">{totals.skus} products</Badge>}
          />
          <CardBody flush>
            <div className="table-wrap table-wrap--scrolled">
              <table className="table table--hover">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="is-numeric">onHand</th>
                    <th className="is-numeric">reserved</th>
                    <th className="is-numeric">available</th>
                  </tr>
                </thead>
                <tbody>
                  {[...inventory]
                    .sort((a, b) => b.onHand - a.onHand)
                    .slice(0, 12)
                    .map((product) => (
                      <tr key={product.productId}>
                        <td className="mono">{product.sku}</td>
                        <td className="table__primary">
                          {product.name}
                          {product.isActive === false ? (
                            <>
                              {' '}
                              <Badge tone="neutral" size="sm">
                                inactive
                              </Badge>
                            </>
                          ) : null}
                        </td>
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
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
