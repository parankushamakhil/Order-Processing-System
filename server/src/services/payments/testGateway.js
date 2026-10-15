import { config } from '../../config/index.js';
import { setGateway } from './index.js';
import { createSimulatedGateway } from './simulatedGateway.js';

/**
 * Rebuilds the simulated gateway before each test, so a withheld payment answer
 * recorded in one test cannot leak into the next.
 */
export function resetGateway() {
  return setGateway(
    createSimulatedGateway({
      latencyMs: config.PAYMENT_LATENCY_MS,
      failureRate: config.PAYMENT_FAILURE_RATE,
    }),
  );
}
