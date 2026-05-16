import pino from 'pino';

// Redact keys that may contain secrets or user-controlled strings that
// shouldn't land in log aggregation. Paths follow pino's dot-notation;
// `*` wildcard matches any intermediate key.
const REDACT_PATHS = [
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'password',
  'secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.password',
  '*.secret',
  'env.*',
  'env_snapshot.*',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger = pino({
  level: process.env.KNOLDR_LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino/file', options: { destination: 1 } } : undefined,
});
