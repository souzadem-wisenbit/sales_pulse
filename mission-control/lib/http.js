'use strict';
// Cliente HTTPS mínimo baseado no módulo nativo. Usa rejectUnauthorized:false
// porque o AVG desta máquina intercepta TLS de forma intermitente (mesmo motivo
// do --ssl-no-revoke no curl do playbook de deploy).
const https = require('https');
const http = require('http');
const { URL } = require('url');

function request(urlStr, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeout = 30000 } = options;
  const url = new URL(urlStr);
  const mod = url.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers,
        rejectUnauthorized: false,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout após ${timeout}ms: ${method} ${urlStr}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(urlStr, options = {}) {
  const res = await request(urlStr, options);
  const text = res.buffer.toString('utf8');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    // resposta não-JSON: devolve texto cru para diagnóstico
  }
  return { status: res.status, json, text };
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

module.exports = { request, requestJson, basicAuth };
