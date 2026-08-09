'use strict';

/**
 * Static server for developing the phone app.
 *
 * http://localhost is a "secure context" as far as browsers are concerned, so
 * service workers, crypto.subtle and the PKCE flow all work here exactly as
 * they will on an HTTPS host — no certificate needed to test the real thing.
 *
 *   node serve.js          -> http://localhost:5173
 *   PORT=5000 node serve.js
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let file = path.join(ROOT, decodeURIComponent(url.pathname));

  // Anything that is not a real file falls back to index.html, so returning
  // from Microsoft with ?code=... on a deep path still loads the app.
  if (!path.resolve(file).startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(ROOT, 'index.html');
  }

  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // The service worker would otherwise serve yesterday's app all day.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(404).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`[mobile] http://localhost:${PORT}`);
  console.log('[mobile] register this exact URL as a SPA redirect URI:');
  console.log(`[mobile]   http://localhost:${PORT}/`);
});
