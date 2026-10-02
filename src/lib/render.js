'use strict';

const { page } = require('../views/layout');

// Renders a full page with the current user, CSRF token and flash message.
function render(req, res, opts, status = 200) {
  const flash = opts.flash ?? (typeof req.query.ok === 'string' ? req.query.ok : '');
  res.status(status).type('html').send(String(page({ ...opts, user: req.user, csrf: req.csrfToken, flash })));
}

function notFound(req, res) {
  const { html } = require('./html');
  render(req, res, { title: 'Not found', noindex: true, body: html`<section class="wrap page narrow"><h1>Page not found</h1><p>That page does not exist or you do not have access to it.</p><p><a class="btn" href="${req.user ? '/app' : '/'}">Go home</a></p></section>` }, 404);
}

module.exports = { render, notFound };
