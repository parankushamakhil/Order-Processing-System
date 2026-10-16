/**
 * Deterministic Chaos & Fault Injection Service (T1.2).
 *
 * Allows injecting faults at critical saga steps to adversarially prove recovery
 * from crash-between-charge-and-record (F5), timeouts, and reservation failures.
 *
 * Opt-in via request header `x-chaos-fault` or test configuration.
 */

class ChaosService {
  constructor() {
    this.activeFault = null;
  }

  setFault(faultName) {
    this.activeFault = faultName;
  }

  clear() {
    this.activeFault = null;
  }

  check(stepName, req = null) {
    const fault = req?.headers?.['x-chaos-fault'] ?? this.activeFault;
    if (!fault) return;

    if (fault === stepName) {
      const err = new Error(`CHAOS_INJECTED: Fault triggered at step [${stepName}]`);
      err.code = 'CHAOS_FAULT';
      err.step = stepName;
      throw err;
    }
  }
}

export const chaos = new ChaosService();
