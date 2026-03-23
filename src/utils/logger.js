'use strict';

const pino = require('pino');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * Main application logger — structured JSON via pino.
 *
 * In production, pipe stdout through `pino-pretty` for human-readable output:
 *   node src/index.js | npx pino-pretty
 * Without pino-pretty the output is plain JSON, which is ideal for log
 * aggregators (CloudWatch, Datadog, Loki, etc.).
 */
const logger = pino({
  level: LOG_LEVEL,
  base: { service: 'slack-jira-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * A Bolt-compatible logger adapter that forwards to pino.
 * Pass this as the `logger` option when constructing the Bolt App.
 */
const boltLogger = {
  debug: (...args) => logger.debug(args.join(' ')),
  info:  (...args) => logger.info(args.join(' ')),
  warn:  (...args) => logger.warn(args.join(' ')),
  error: (...args) => logger.error(args.join(' ')),
  setLevel: () => {},
  getLevel: () => LOG_LEVEL,
};

module.exports = { logger, boltLogger };
