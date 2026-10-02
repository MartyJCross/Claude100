'use strict';

const config = require('./config');
const { createApp } = require('./app');
const scheduler = require('./lib/scheduler');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`${config.brand} running on ${config.baseUrl} (PayFast: ${config.payfast.mode})`);
});

if (!config.disableScheduler) scheduler.start();

function shutdown() {
  scheduler.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
