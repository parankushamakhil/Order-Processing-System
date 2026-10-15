import { config } from '../../config/index.js';
import { createSimulatedGateway } from './simulatedGateway.js';

/**
 * A single gateway instance per process, swappable. The rest of the system
 * depends only on the shape { provider, charge, refund }, so a real provider is
 * a drop-in rather than a rewrite.
 */
let gateway = createSimulatedGateway({
  latencyMs: config.PAYMENT_LATENCY_MS,
  failureRate: config.PAYMENT_FAILURE_RATE,
});

export function getGateway() {
  return gateway;
}

export function setGateway(next) {
  gateway = next;
  return gateway;
}

export { createSimulatedGateway };
export { GatewayError, GatewayTimeoutError, PAYMENT_TOKENS } from './simulatedGateway.js';
