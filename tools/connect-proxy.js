'use strict';

/**
 * An HTTP CONNECT proxy that forwards through an SSH SOCKS5 tunnel.
 *
 * This exists for exactly one problem, documented in
 * `documentation/16-research-engine.md`: `catalyst deploy` PUTs the container image to
 * `cr-<env>-<project>.zohostratus.in:443`, and TCP 443 to that host is filtered on this
 * ISP path while the Catalyst API itself is reachable. So the deploy hangs on the upload
 * and retries forever, with no error that names the cause.
 *
 * The workaround is an SSH tunnel. It needs a bridge because the two halves do not
 * speak the same protocol: `ssh -D` gives a SOCKS5 proxy, and the Catalyst CLI is built
 * on `request` v2, which honours HTTPS_PROXY but speaks HTTP CONNECT. Fifty lines of
 * SOCKS5 client is cheaper than either patching the CLI or running a general-purpose
 * proxy daemon, and it keeps the whole workaround in the repo rather than in somebody's
 * shell history.
 *
 *   ssh -N -D 127.0.0.1:1080 reticule &
 *   node tools/connect-proxy.js &
 *   HTTPS_PROXY=http://127.0.0.1:3128 catalyst deploy --only appsail:research
 *
 * ponytail: no auth and bound to loopback only. It is a build-host utility with a
 * lifetime of one deploy, not a service.
 */

const net = require('node:net');
const http = require('node:http');

const LISTEN = Number(process.env.BRIDGE_PORT || 3128);
const SOCKS_HOST = process.env.SOCKS_HOST || '127.0.0.1';
const SOCKS_PORT = Number(process.env.SOCKS_PORT || 1080);

/** Open a tunnelled TCP connection to host:port through the SOCKS5 proxy. */
function socksConnect(host, port, done) {
  const sock = net.connect(SOCKS_PORT, SOCKS_HOST);
  let stage = 'greet';

  sock.once('error', (e) => done(e));
  sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));

  sock.on('data', function onData(buf) {
    if (stage === 'greet') {
      if (buf[0] !== 0x05 || buf[1] !== 0x00) {
        sock.destroy();
        return done(new Error('SOCKS5 handshake refused (no no-auth method)'));
      }
      stage = 'request';
      const name = Buffer.from(host, 'utf8');
      const req = Buffer.alloc(7 + name.length);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00;
      // Address type 3 = domain name, so the remote end resolves it. Resolving locally
      // would defeat the point: the filtering is on the path, not on DNS.
      req[3] = 0x03; req[4] = name.length;
      name.copy(req, 5);
      req.writeUInt16BE(port, 5 + name.length);
      return sock.write(req);
    }
    // Reply: VER REP RSV ATYP BND.ADDR BND.PORT. Only REP matters here.
    sock.off('data', onData);
    if (buf[1] !== 0x00) {
      sock.destroy();
      return done(new Error('SOCKS5 refused the connection, code ' + buf[1]));
    }
    return done(null, sock);
  });
}

const server = http.createServer((req, res) => {
  // Only CONNECT is proxied. A plain GET here means something is misconfigured, and
  // answering it as though the bridge were a web server hides that.
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('this bridge only handles CONNECT\n');
});

server.on('connect', (req, client, head) => {
  const [host, rawPort] = String(req.url || '').split(':');
  const port = Number(rawPort || 443);
  if (!host || !Number.isInteger(port)) {
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  socksConnect(host, port, (err, upstream) => {
    if (err) {
      console.error(`connect ${host}:${port} failed — ${err.message}`);
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    console.log(`connect ${host}:${port}`);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    const shut = () => { upstream.destroy(); client.destroy(); };
    client.on('error', shut);
    upstream.on('error', shut);
  });
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`CONNECT bridge on 127.0.0.1:${LISTEN} → socks5://${SOCKS_HOST}:${SOCKS_PORT}`);
  console.log(`HTTPS_PROXY=http://127.0.0.1:${LISTEN} catalyst deploy --only appsail:research`);
});
