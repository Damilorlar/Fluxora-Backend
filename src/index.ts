/**
 * Fluxora Backend - server entry point.
 *
 * Responsibilities:
 *  - Bind the Express app to a TCP port.
 *  - Register OS signal handlers for graceful shutdown.
 *
 * Everything else (routes, middleware, app config) lives in app.ts.
 * Shutdown logic (drain + hooks) lives in shutdown.ts.
 */

import http from 'node:http';
import { createApp } from './app.js';
import { gracefulShutdown, addShutdownHook, addDrainableShutdownHook } from './shutdown.js';
import { logger } from './lib/logger.js';
import { checkPendingMigrations } from './db/migrate.js';
import { getPool } from './db/pool.js';
import { createStreamHub, getStreamHub } from './ws/hub.js';
import { webhookDispatcher } from './webhooks/service.js';

// Export a pre-built app instance for use in tests and other consumers.
export { app } from './app.js';

const NODE_ENV = process.env.NODE_ENV || 'development';

async function startServer() {
  try {
    const { initializeConfig } = await import('./config/env.js');
    const config = initializeConfig();

    // Guard: fail fast if any migrations are pending.
    // Migrations must be applied (e.g. via `pnpm migrate`) before starting.
    await checkPendingMigrations();

    const { createApp } = await import('./app.js');
    const app = createApp({ config });
    const server = http.createServer(app);

    // Initialize WebSocket hub (registered on the HTTP server as a side effect)
    createStreamHub(server);
    logger.info('WebSocket hub initialized', undefined, { path: '/ws/streams' });

    // Register shutdown hooks
    webhookDispatcher.start();
    addDrainableShutdownHook(webhookDispatcher);

    addShutdownHook(async () => {
      logger.info('Closing database connections...');
      const pool = getPool();
      await pool.end();
      logger.info('Database connections closed');
    });

    addShutdownHook(async () => {
      logger.info('Closing WebSocket hub...');
      const currentHub = getStreamHub();
      if (currentHub) {
        await new Promise<void>((resolve) => {
          currentHub.close(() => {
            logger.info('WebSocket hub closed');
            resolve();
          });
        });
      }
    });

    // Register signal handlers for graceful shutdown
    process.on('SIGTERM', () => {
      logger.warn('SIGTERM received, initiating graceful shutdown');
      void gracefulShutdown(server, 'SIGTERM').then(() => {
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.warn('SIGINT received, initiating graceful shutdown');
      void gracefulShutdown(server, 'SIGINT').then(() => {
        process.exit(0);
      });
    });

    // Start listening
    server.listen(config.port, () => {
      logger.info('Fluxora API listening', undefined, { 
        port: config.port,
        nodeEnv: NODE_ENV,
        pid: process.pid 
      });
    });

  } catch (err) {
    if (err instanceof Error && err.name === 'EnvironmentError') {
      console.error(err.message);
    }

    logger.error('Failed to start Fluxora API', undefined, {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    process.exit(1);
  }
}

// Global unhandled rejection handler
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', undefined, { 
    reason: String(reason) 
  });
  // In production, we might want to exit here to allow a clean restart
  if (NODE_ENV === 'production') {
    process.exit(1);
  }
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', undefined, { 
    error: err.message,
    stack: err.stack 
  });
  process.exit(1);
});

// Skip server bootstrapping when this module is imported by tests.  Tests
// pull in `{ app }` for supertest; they should not bind a port or wire up
// signal handlers.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  void startServer();
}
