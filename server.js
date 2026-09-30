/**
 * cherri-proxy — server.js
 * Node 18+, Express 4
 *
 * Routes:
 *   GET  /                    → serves the cherri frontend (public/index.html)
 *   GET  /proxy?url=<url>     → proxies the target URL, strips frame-kill headers,
 *                               rewrites absolute/relative URLs so sub-requests
 *                               (CSS, JS, images, links) also route through this proxy
 *   GET  /raw?url=<url>       → raw passthrough for assets (images, fonts, media)
 *                               with header stripping but no HTML rewriting
 *
 * Deploy:
 *   PORT env var controls listen port (default 3000)
 *   Set ALLOWED_ORIGINS if you want CORS locked to your domain
 */

'use strict';

const express  = require('express');
// Node 18+ has fetch built-in globally — no node-fetch needed
const cheerio  = require('cheerio');
const path     = require('path');
const { URL }  = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Headers we always strip from proxied responses ───────────────────────────
const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-content-type-options',   // keep it? stripping to avoid sniff blocks on rewritten HTML
  'strict-transport-security', // we handle TLS ourselves
  'expect-ct',
  'permissions-policy',
  'report-to',
  'nel',
]);

// ── Headers we never forward TO the target (would expose our proxy) ───────────
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
]);

// ── Serve static frontend ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Utility: build a proxied URL ──────────────────────────────────────────────
function proxyURL(target, base) {
  // Resolve relative URLs against base, then wrap in /proxy?url=...
  try {
    const resolved = new URL(target, base).href;
    return `/proxy?url=${encodeURIComponent(resolved)}`;
  } catch {
    return target; // leave malformed ones alone
  }
}

function rawURL(target, base) {
  try {
    const resolved = new URL(target, base).href;
    return `/raw?url=${encodeURIComponent(resolved)}`;
  } catch {
    return target;
  }
}

// ── Rewrite HTML: patch all URLs to go through this proxy ────────────────────
function rewriteHTML(html, baseURL) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // <a href> — proxy the link
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      $(el).attr('href', proxyURL(href, baseURL));
    }
  });

  // <link href> — stylesheets, icons, etc.
  $('link[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', rawURL(href, baseURL));
  });

  // <script src>
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', rawURL(src, baseURL));
  });

  // <img src> and <img srcset>
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('data:')) $(el).attr('src', rawURL(src, baseURL));
  });

  $('img[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (srcset) {
      const rewritten = srcset.replace(/(\S+)(\s+\S+)/g, (match, url, descriptor) => {
        return rawURL(url, baseURL) + descriptor;
      });
      $(el).attr('srcset', rewritten);
    }
  });

  // <source srcset> (picture, video)
  $('source[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (srcset) {
      const rewritten = srcset.replace(/(\S+)(\s+\S+)/g, (match, url, descriptor) => {
        return rawURL(url, baseURL) + descriptor;
      });
      $(el).attr('srcset', rewritten);
    }
  });

  $('source[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', rawURL(src, baseURL));
  });

  // <form action>
  $('form[action]').each((_, el) => {
    const action = $(el).attr('action');
    if (action) $(el).attr('action', proxyURL(action, baseURL));
  });

  // <iframe src> — nested iframes also proxied
  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('data:')) $(el).attr('src', proxyURL(src, baseURL));
  });

  // CSS url() in inline <style> blocks
  $('style').each((_, el) => {
    const css = $(el).html();
    if (css) {
      $(el).html(rewriteCSS(css, baseURL));
    }
  });

  // Inline style attributes
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (style) $(el).attr('style', rewriteCSS(style, baseURL));
  });

  // Inject a small JS shim that intercepts window.location and fetch inside
  // the proxied page so in-page navigation stays inside cherri
  const shimScript = buildShim(baseURL);
  $('head').prepend(`<script>${shimScript}</script>`);

  return $.html();
}

// ── Rewrite CSS: url(...) references ─────────────────────────────────────────
function rewriteCSS(css, baseURL) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
    if (url.startsWith('data:')) return match;
    return `url(${quote}${rawURL(url, baseURL)}${quote})`;
  });
}

// ── JS shim injected into every proxied page ─────────────────────────────────
// Intercepts fetch, XMLHttpRequest, and pushState so in-page requests
// and navigation stay inside the proxy
function buildShim(baseURL) {
  const encoded = JSON.stringify(baseURL);
  return `
(function() {
  var _base = ${encoded};
  var _proxyPath = '/proxy?url=';
  var _rawPath   = '/raw?url=';

  function toProxy(url) {
    try {
      var abs = new URL(url, _base).href;
      return _proxyPath + encodeURIComponent(abs);
    } catch(e) { return url; }
  }
  function toRaw(url) {
    try {
      var abs = new URL(url, _base).href;
      return _rawPath + encodeURIComponent(abs);
    } catch(e) { return url; }
  }

  // Patch fetch
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = toRaw(input);
    else if (input && input.url) input = new Request(toRaw(input.url), input);
    return _fetch.call(this, input, init);
  };

  // Patch XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = toRaw(url);
    return _open.apply(this, arguments);
  };

  // Patch history pushState/replaceState
  var _push    = history.pushState.bind(history);
  var _replace = history.replaceState.bind(history);
  history.pushState = function(state, title, url) {
    if (url) url = toProxy(url);
    return _push(state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url) url = toProxy(url);
    return _replace(state, title, url);
  };
})();
`;
}

// ── Build clean request headers ───────────────────────────────────────────────
function buildRequestHeaders(incomingHeaders, targetURL) {
  const out = {};
  for (const [k, v] of Object.entries(incomingHeaders)) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  // Spoof origin/referer to match target so sites don't reject the request
  const parsed = new URL(targetURL);
  out['host']    = parsed.host;
  out['origin']  = parsed.origin;
  out['referer'] = parsed.origin + '/';
  // Common UA — looks like a real browser
  out['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  out['accept-language'] = 'en-US,en;q=0.9';
  return out;
}

// ── Build clean response headers ─────────────────────────────────────────────
function buildResponseHeaders(fetchHeaders) {
  const out = {};
  for (const [k, v] of fetchHeaders.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  // Allow this response to be framed by anything
  out['x-frame-options']               = 'ALLOWALL';
  out['access-control-allow-origin']   = '*';
  out['access-control-allow-headers']  = '*';
  out['access-control-allow-methods']  = '*';
  return out;
}

// ── Validate target URL ───────────────────────────────────────────────────────
function parseTarget(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

// ── /proxy — full HTML proxy with URL rewriting ───────────────────────────────
app.get('/proxy', async (req, res) => {
  const target = parseTarget(req.query.url);
  if (!target) return res.status(400).send('Bad or missing url parameter');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const fetchRes = await fetch(target, {
      headers: buildRequestHeaders(req.headers, target),
      redirect: 'follow',
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    const contentType = fetchRes.headers.get('content-type') || '';
    const resHeaders  = buildResponseHeaders(fetchRes.headers);

    // Non-HTML assets that ended up hitting /proxy (e.g. redirect chains)
    // pass them through without rewriting
    if (!contentType.includes('text/html')) {
      res.set(resHeaders);
      res.status(fetchRes.status);
      const buf = await fetchRes.arrayBuffer();
      res.send(Buffer.from(buf));
      return;
    }

    const rawHTML   = await fetchRes.text();
    const finalURL  = fetchRes.url; // after redirects
    const rewritten = rewriteHTML(rawHTML, finalURL);

    resHeaders['content-type']   = 'text/html; charset=utf-8';
    resHeaders['content-length'] = Buffer.byteLength(rewritten).toString();

    res.set(resHeaders);
    res.status(fetchRes.status).send(rewritten);

  } catch (err) {
    console.error(`[proxy] ${target} — ${err.message}`);
    res.status(502).send(`
      <html><body style="font-family:sans-serif;background:#0d0d10;color:#f0eef5;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
        flex-direction:column;gap:1rem">
        <div style="font-size:1.2rem;color:#e8427c">502 — couldn't reach site</div>
        <div style="font-size:0.8rem;color:#7a7888">${escapeHTML(err.message)}</div>
        <a href="/" style="margin-top:0.5rem;padding:0.5rem 1.2rem;background:#e8427c;
          color:#fff;border-radius:999px;text-decoration:none;font-size:0.82rem">← back</a>
      </body></html>
    `);
  }
});

// ── /raw — passthrough for assets: JS, CSS, images, fonts ────────────────────
app.get('/raw', async (req, res) => {
  const target = parseTarget(req.query.url);
  if (!target) return res.status(400).send('Bad or missing url parameter');

  try {
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 15000);
    const fetchRes = await fetch(target, {
      headers: buildRequestHeaders(req.headers, target),
      redirect: 'follow',
      signal: controller2.signal,
    }).finally(() => clearTimeout(timer2));

    const contentType = fetchRes.headers.get('content-type') || '';
    const resHeaders  = buildResponseHeaders(fetchRes.headers);

    // Rewrite CSS files so their url() references also proxy
    if (contentType.includes('text/css')) {
      const css      = await fetchRes.text();
      const rewritten = rewriteCSS(css, target);
      resHeaders['content-type']   = 'text/css; charset=utf-8';
      resHeaders['content-length'] = Buffer.byteLength(rewritten).toString();
      res.set(resHeaders).status(fetchRes.status).send(rewritten);
      return;
    }

    res.set(resHeaders);
    res.status(fetchRes.status);
    const buf2 = await fetchRes.arrayBuffer();
    res.send(Buffer.from(buf2));

  } catch (err) {
    console.error(`[raw] ${target} — ${err.message}`);
    res.status(502).end();
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`cherri proxy running → http://localhost:${PORT}`);
});
