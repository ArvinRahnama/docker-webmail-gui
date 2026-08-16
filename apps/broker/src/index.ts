/**
 * Process entry point (M4 — ARCHITECTURE.md §6, §11). Deliberately thin:
 * load config, build the logger and the real Docker adapter, build and
 * start the Fastify app, wire graceful shutdown. Every line here runs
 * with access to the Docker socket, so anything more belongs in `app.ts`
 * or one of the focused modules it composes.
 */
import pino from 'pino';
import { BROKER_SECRET_HEADER } from '@dwg/shared';
import { loadBrokerConfig, BrokerConfigError } from './config.js';
import { createRealDockerApi } from './docker-client.js';
import { buildBrokerApp } from './app.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadBrokerConfig();
  } catch (err) {
    // No logger exists yet — config must be valid before we can even
    // pick a log level. This is the one place a plain console.error is
    // correct rather than a smell (mirrors apps/server/src/index.ts).
    console.error(err instanceof BrokerConfigError ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const logger = pino({
    name: '@dwg/broker',
    level: config.logLevel,
    // The broker's own redaction list: the shared secret must never
    // reach a log line, whether it shows up as the inbound header or as
    // a plain config field on an object that gets logged wholesale
    // (SECURITY.md §3.10).
    redact: {
      paths: [BROKER_SECRET_HEADER, `*.${BROKER_SECRET_HEADER}`, 'sharedSecret', '*.sharedSecret'],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  const docker = createRealDockerApi(config.dockerSocketPath);
  const app = buildBrokerApp({ config, logger, docker });

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    logger.info({ address }, 'Broker listening');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start broker');
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Safety net: if closing hangs (a stuck in-flight request), force-exit
    // rather than leaving a zombie process behind.
    const forceExit = setTimeout(() => {
      logger.warn('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    app
      .close()
      .catch((err: unknown) => {
        logger.error({ err }, 'Error while closing the broker');
      })
      .finally(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exitCode = 1;
});
