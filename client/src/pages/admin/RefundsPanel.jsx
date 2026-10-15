import { useState } from 'react';
import { api } from '../../api.js';
import { CheckCircleIcon, SlidersIcon } from '../../components/icons.jsx';
import { ConfirmDialog } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  StatTile,
} from '../../components/ui.jsx';
import { formatDate, formatMinor } from '../../lib/format.js';
import { StatusPill } from './shared.jsx';

/**
 * Money that was taken for an order this system could not fulfil.
 *
 * This is the visible half of ADR-08: the charge-versus-expiry race cannot be
 * eliminated, so it is narrowed, then DETECTED and COMPENSATED. Anything that
 * lands here is a recorded obligation rather than a silent loss — which is the
 * difference between a system that handles the race and one that hides it.
 */
export default function RefundsPanel({ report, reload }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const obligations = report.refundObligations ?? [];
  const totalMinor = obligations.reduce((sum, o) => sum + o.amountMinor, 0);

  async function resolve() {
    const obligation = confirm;
    setBusy(true);
    try {
      const { data: body } = await api.refundPayment(obligation.orderId);
      toast.success(
        body.refund?.alreadyRefunded ? 'Already refunded' : 'Refund recorded',
        `${obligation.orderNumber ?? obligation.orderId} — ${formatMinor(obligation.amountMinor)}.`,
      );
      await reload();
      setConfirm(null);
    } catch (err) {
      toast.error('Refund failed', err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="kpi-grid">
        <StatTile
          label="Outstanding"
          value={obligations.length}
          tone={obligations.length > 0 ? 'danger' : 'success'}
          meta="Charges awaiting compensation"
        />
        <StatTile
          label="Amount owed"
          value={formatMinor(totalMinor)}
          tone={obligations.length > 0 ? 'warning' : 'neutral'}
          meta="Sum of the obligations below"
        />
        <StatTile
          label="Refund path"
          value="Idempotent"
          meta="Refunding twice reports alreadyRefunded"
        />
      </div>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <Card>
          <CardHeader
            title="Refund obligations"
            subtitle="A charge succeeded after the order it was for had already expired or been cancelled."
            icon={SlidersIcon}
            actions={
              <Badge tone={obligations.length > 0 ? 'danger' : 'success'} dot>
                {obligations.length > 0 ? `${obligations.length} open` : 'clear'}
              </Badge>
            }
          />
          {obligations.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={CheckCircleIcon}
                title="No money is owed"
                body="Nothing has been charged for an order this system could not fulfil. When the race does happen, the obligation appears here rather than disappearing into a log."
              />
            </CardBody>
          ) : (
            <CardBody flush>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Order status</th>
                      <th className="is-numeric">Amount</th>
                      <th>Provider ref</th>
                      <th>Detected</th>
                      <th className="is-actions">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {obligations.map((obligation) => (
                      <tr key={obligation.paymentAttemptId}>
                        <td className="mono table__primary">{obligation.orderNumber ?? '—'}</td>
                        <td>
                          <StatusPill status={obligation.orderStatus ?? 'cancelled'} />
                        </td>
                        <td className="is-numeric">{formatMinor(obligation.amountMinor)}</td>
                        <td className="mono text-muted">{obligation.providerRef ?? '—'}</td>
                        <td className="text-muted">{formatDate(obligation.createdAt)}</td>
                        <td className="is-actions">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={!obligation.orderId}
                            onClick={() => setConfirm(obligation)}
                          >
                            Refund
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <Alert tone="info">
          The window is narrowed with two deadlines — <code>reservationExpiresAt</code> bounds the
          hold and <code>paymentLeaseExpiresAt</code> marks a charge that is in flight, so the
          reaper never expires an order it might be mid-payment on. Where an overlap remains, it is
          recorded here and compensated, never ignored.
        </Alert>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={resolve}
        busy={busy}
        tone="primary"
        confirmLabel="Issue the refund"
        title="Refund this charge?"
        body={`${confirm?.orderNumber ?? ''} — ${formatMinor(confirm?.amountMinor ?? 0)} ${
          confirm?.providerRef ? `(provider ref ${confirm.providerRef})` : ''
        }. The call is idempotent, so repeating it cannot pay out twice.`}
      />
    </>
  );
}
