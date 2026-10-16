/**
 * Lightweight in-process metrics registry (T1.1 - Live Contention Telemetry).
 *
 * Tracks operational counters, reject reasons, contention retries, and latency
 * percentiles without adding an external dependency. Exposes both Prometheus
 * text format for /metrics and JSON snapshots for the Ops/Concurrency Lab UI.
 */

class MetricsRegistry {
  constructor() {
    this.reset();
  }

  reset() {
    this.counters = {
      checkout_attempts_total: 0,
      checkout_success_total: 0,
      checkout_rejections_total: {
        out_of_stock: 0,
        price_changed: 0,
        checkout_in_progress: 0,
        rate_limited: 0,
        other: 0,
      },
      transaction_retries_total: 0,
      idempotency_replays_total: 0,
      reservation_reclaims_total: {
        lazy_demand: 0,
        timer_sweep: 0,
      },
    };

    // Sliding window of recent checkout latencies (capped to 2000 samples)
    this.latencies = [];
    this.maxLatencySamples = 2000;
  }

  inc(metric, labels = {}, amount = 1) {
    if (metric === 'checkout_attempts_total') {
      this.counters.checkout_attempts_total += amount;
    } else if (metric === 'checkout_success_total') {
      this.counters.checkout_success_total += amount;
    } else if (metric === 'transaction_retries_total') {
      this.counters.transaction_retries_total += amount;
    } else if (metric === 'idempotency_replays_total') {
      this.counters.idempotency_replays_total += amount;
    } else if (metric === 'checkout_rejections_total') {
      const reason = labels.reason || 'other';
      if (reason in this.counters.checkout_rejections_total) {
        this.counters.checkout_rejections_total[reason] += amount;
      } else {
        this.counters.checkout_rejections_total.other += amount;
      }
    } else if (metric === 'reservation_reclaims_total') {
      const trigger = labels.trigger || 'lazy_demand';
      if (trigger in this.counters.reservation_reclaims_total) {
        this.counters.reservation_reclaims_total[trigger] += amount;
      }
    }
  }

  observeDuration(durationMs) {
    if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
      this.latencies.push(Math.round(durationMs));
      if (this.latencies.length > this.maxLatencySamples) {
        this.latencies.shift();
      }
    }
  }

  getPercentiles() {
    if (this.latencies.length === 0) {
      return { count: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p = (pct) => {
      const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
      return sorted[idx];
    };
    return {
      count: sorted.length,
      p50: p(50),
      p90: p(90),
      p95: p(95),
      p99: p(99),
    };
  }

  getSnapshot() {
    return {
      counters: {
        attempts: this.counters.checkout_attempts_total,
        success: this.counters.checkout_success_total,
        retries: this.counters.transaction_retries_total,
        replays: this.counters.idempotency_replays_total,
        rejections: { ...this.counters.checkout_rejections_total },
        reclaims: { ...this.counters.reservation_reclaims_total },
      },
      latencies: this.getPercentiles(),
      sampledAt: new Date().toISOString(),
    };
  }

  toPrometheus() {
    const lines = [];
    lines.push('# HELP checkout_attempts_total Total checkout requests initiated');
    lines.push('# TYPE checkout_attempts_total counter');
    lines.push(`checkout_attempts_total ${this.counters.checkout_attempts_total}`);

    lines.push('# HELP checkout_success_total Successfully settled checkouts');
    lines.push('# TYPE checkout_success_total counter');
    lines.push(`checkout_success_total ${this.counters.checkout_success_total}`);

    lines.push('# HELP checkout_rejections_total Rejection count partitioned by reason');
    lines.push('# TYPE checkout_rejections_total counter');
    for (const [reason, count] of Object.entries(this.counters.checkout_rejections_total)) {
      lines.push(`checkout_rejections_total{reason="${reason}"} ${count}`);
    }

    lines.push('# HELP transaction_retries_total Write conflicts retried inside withTransaction');
    lines.push('# TYPE transaction_retries_total counter');
    lines.push(`transaction_retries_total ${this.counters.transaction_retries_total}`);

    lines.push('# HELP idempotency_replays_total Checkouts returned from cache without side effects');
    lines.push('# TYPE idempotency_replays_total counter');
    lines.push(`idempotency_replays_total ${this.counters.idempotency_replays_total}`);

    lines.push('# HELP reservation_reclaims_total Expired holds returned to available stock');
    lines.push('# TYPE reservation_reclaims_total counter');
    for (const [trigger, count] of Object.entries(this.counters.reservation_reclaims_total)) {
      lines.push(`reservation_reclaims_total{trigger="${trigger}"} ${count}`);
    }

    const { count, p50, p90, p95, p99 } = this.getPercentiles();
    lines.push('# HELP checkout_duration_ms Latency percentiles in milliseconds');
    lines.push('# TYPE checkout_duration_ms gauge');
    lines.push(`checkout_duration_ms{quantile="0.5"} ${p50}`);
    lines.push(`checkout_duration_ms{quantile="0.9"} ${p90}`);
    lines.push(`checkout_duration_ms{quantile="0.95"} ${p95}`);
    lines.push(`checkout_duration_ms{quantile="0.99"} ${p99}`);
    lines.push(`checkout_duration_ms_count ${count}`);

    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();
