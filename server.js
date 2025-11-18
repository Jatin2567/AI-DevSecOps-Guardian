// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const webhookRoutes = require('./src/routes/webhook');
const fpStore = require('./src/db/fingerprintStore');

async function bootstrap() {
  try {
    // ───────────────────────────────────────────────
    // 1. Initialize fingerprint DB BEFORE app starts
    // ───────────────────────────────────────────────
    await fpStore.init();
    console.log(JSON.stringify({
      level: 'info',
      msg: 'fingerprint.db.initialized',
      path: fpStore.DB_PATH
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'fingerprint.db.init_failed',
      error: err.message
    }));
    process.exit(1); // fail fast
  }

  // ───────────────────────────────────────────────
  // 2. Start Express AFTER DB is ready
  // ───────────────────────────────────────────────
  const app = express();
  app.use(bodyParser.json({ limit: '5mb' }));

  // routes
  app.use('/webhook', webhookRoutes);

  // health endpoints
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/ready', (req, res) => res.status(200).json({ status: 'ready' }));

  // ───────────────────────────────────────────────
  // 3. Start HTTP server
  // ───────────────────────────────────────────────
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'server.started',
      port
    }));
  });

  // graceful shutdown
  function gracefulShutdown(signal) {
    console.log(JSON.stringify({ level: 'info', msg: 'shutdown.signal', signal }));
    server.close(() => {
      console.log(JSON.stringify({ level: 'info', msg: 'shutdown.complete' }));
      process.exit(0);
    });
    setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', msg: 'shutdown.timeout' }));
      process.exit(1);
    }, 10000);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

// ───────────────────────────────────────────────
// Bootstrap the whole service
// ───────────────────────────────────────────────
bootstrap();
