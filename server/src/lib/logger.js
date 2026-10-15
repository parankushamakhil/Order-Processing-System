import { config } from '../config/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = LEVELS[config.LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? threshold;
}

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  });
  // Errors to stderr, everything else to stdout, so log levels can be routed
  // separately by the platform.
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  child: (base) => ({
    debug: (msg, meta) => emit('debug', msg, { ...base, ...meta }),
    info: (msg, meta) => emit('info', msg, { ...base, ...meta }),
    warn: (msg, meta) => emit('warn', msg, { ...base, ...meta }),
    error: (msg, meta) => emit('error', msg, { ...base, ...meta }),
  }),
};
