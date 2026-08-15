/**
 * Process entry point. Deliberately thin: load config, build the
 * logger, open the database and migrate it, build and start the
 * Fastify app, then wire up graceful shutdown. Anything more belongs in
 * `app.ts` or `platform/`.
 */
import { loadConfig, ConfigError } from './platform/config.js';
import { createLogger } from './platform/logger.js';
import { openAppDatabase } from './platform/db.js';
import { runMigrations, migrations, MigrationError } from './platform/migrations/index.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // No logger exists yet — config must be valid before we can even
    // pick a log level. This is the one place a plain console.error is
    // correct rather than a smell.
    console.error(err instanceof ConfigError ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel });

  for (const warning of config.warnings) {
    logger.warn(warning);
  }

  const db = openAppDatabase(config.dataDir);

  try {
    runMigrations(db, migrations);
  } catch (err) {
    if (err instanceof MigrationError) {
      logger.fatal({ err }, err.message);
    } else {
      logger.fatal({ err }, 'Unexpected error while running database migrations');
    }
    db.close();
    process.exitCode = 1;
    return;
  }

  const app = await buildApp({ config, logger });

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    logger.info({ address, appMode: config.appMode }, 'Server listening');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    db.close();
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

    // Safety net: if closing hangs (a stuck in-flight request, a wedged
    // DB handle), force-exit rather than leaving a zombie process behind.
    const forceExit = setTimeout(() => {
      logger.warn('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    app
      .close() // stops accepting new connections, waits for in-flight ones
      .catch((err: unknown) => {
        logger.error({ err }, 'Error while closing the server');
      })
      .finally(() => {
        db.close();
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
