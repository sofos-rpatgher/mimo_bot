// ============================================================
// B14 — runFiori de punta a punta: un listado en $batch que la app cancela no hace fallar el
// intent; una escritura cancelada, sí (B10 se conserva).
//
// Reproduce el job 8b209885 (FORMS-0000005): la app lanza un $batch de sólo lectura con
// `sap-cancel-on-close`, lo cancela al escribir en el buscador, y después guarda con un changeset
// que responde 201. Antes el bot fallaba con «SAP no confirmó 1 escritura(s)… net::ERR_ABORTED».
//
// Logon de mentira (como logon-e2e.test.js); el «launchpad» ejecuta, según el hash de la app, la
// secuencia de peticiones del caso. No entra en `npm test` (necesita navegador): `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const READ = '--b\r\nContent-Type: application/http\r\n\r\nGET pageSet?$top=20 HTTP/1.1\r\nsap-cancel-on-close: true\r\n\r\n--b--';
const WRITE = '--b\r\nContent-Type: multipart/mixed; boundary=cs\r\n\r\n--cs\r\nContent-Type: application/http\r\n\r\n'
            + 'POST pageSet HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"id":"Z_PAGE"}\r\n--cs--\r\n--b--';
const WRITE_OK = '--rb\r\nContent-Type: multipart/mixed; boundary=rcs\r\n\r\n--rcs\r\nContent-Type: application/http\r\n\r\n'
               + 'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n{"d":{"id":"Z_PAGE"}}\r\n--rcs--\r\n--rb--';

// Lo que hace la app en cada caso. `send(body, abortAfterMs)` lanza un $batch como lo haría UI5.
const APP = `
  const send = (body, abortAfter) => {
    const c = new AbortController();
    const p = fetch('/sap/opu/odata/UI2/FDM_PAGE_REPOSITORY_CUST_SRV/$batch', { method: 'POST', body, signal: c.signal,
      headers: { 'content-type': 'multipart/mixed; boundary=b' } }).catch(() => {});
    if (abortAfter != null) setTimeout(() => c.abort(), abortAfter);
    return p;
  };
  const mode = location.hash.slice(1).split('-')[1];
  (async () => {
    if (mode === 'buscador') { send(${JSON.stringify(READ)}, 100); await new Promise(r => setTimeout(r, 300)); await send(${JSON.stringify(WRITE)}); }
    if (mode === 'escritura') { send(${JSON.stringify(WRITE)}, 100); }
  })();`;

const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/sap/opu/')) {
        // Lenta, para que la cancelación llegue antes que la respuesta.
        return setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(202, { 'content-type': 'multipart/mixed; boundary=rb' });
            res.end(WRITE_OK);
        }, 1000);
    }
    if (req.method === 'POST') {
        req.resume();
        req.on('end', () => { res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' }); res.end(); });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(/S=ok/.test(req.headers.cookie || '')
        ? `<!doctype html><html><body><script>window.sap = { ui: { getCore() { return {}; } } };${APP}</script>launchpad</body></html>`
        : `<!doctype html><html><body data-sap-login="${sapLogin}"><form method="post" action="/sap/bc/ui2/flp">
             <label for="u">User</label><input id="u" name="sap-user"><label for="p">Password</label><input id="p" type="password" name="sap-password">
             <button type="submit">Log On</button></form></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

const run = (hash) => runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
    instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'ADD_APP_TO_SECTION-0001', intent_seq: 1, APP_LINK: `${origin}/sap/bc/ui2/flp#${hash}`, code: [] }] }] }] }] },
    { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true });

console.log('== listado cancelado por el buscador + escritura que responde 201 (job 8b209885) ==');
let r = await run('FLPPage-buscador');
ok(r.success === true && r.completedInstanceIids.join() === 'i1', 'el intent termina bien', r.failure?.message?.slice(0, 140));

console.log('\n== escritura cancelada (B10, job 0b12b73c) ==');
r = await run('FLPPage-escritura');
ok(r.success === false && /SAP no confirmó 1 escritura\(s\).*sin respuesta/.test(r.failure?.message || ''), 'el intent falla: SAP no confirmó la escritura', r.failure?.message?.slice(0, 140));

srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
