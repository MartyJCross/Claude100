'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { sessionMiddleware, csrfUnlessMultipart, securityHeaders } = require('./lib/security');
const { pageViews } = require('./lib/analytics');
const { notFound, render } = require('./lib/render');
const { html } = require('./lib/html');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  // PayFast posts here server-to-server: no session, no CSRF, raw body for signature checks.
  app.use(require('./routes/billing').itn);

  app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 500 }));
  app.use(sessionMiddleware);
  app.use(csrfUnlessMultipart);
  app.use(pageViews);

  app.use(require('./routes/marketing'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/properties'));
  app.use(require('./routes/disputes'));
  app.use(require('./routes/billing'));
  app.use(require('./routes/account'));
  app.use(require('./routes/admin'));

  app.use(notFound);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return;
    if (!req.cookies) req.cookies = {};
    try {
      render(req, res, { title: 'Something went wrong', noindex: true, body: html`<section class="wrap page narrow"><h1>Something went wrong</h1><p>Sorry, that did not work. Please try again. If it keeps happening, email <a href="mailto:${config.supportEmail}">${config.supportEmail}</a>.</p></section>` }, 500);
    } catch {
      res.status(500).send('Something went wrong.');
    }
  });

  return app;
}

module.exports = { createApp };
