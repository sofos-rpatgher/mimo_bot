// ============================================================
// C3 y C4 (contrato MIMO fase 0) — runFiori de punta a punta contra un logon de SAP de mentira.
//
//   - C3: un login rechazado falla en segundos, con failure.code, y sin reintentar el POST.
//   - C4: el trace de la ejecución no contiene la contraseña: ni en el `fill` del campo Password
//     ni en el cuerpo del POST de logon (`sap-password`).
//   - La sesión SAP se cierra al terminar (logoff del ICF).
//
// El servidor imita la forma medida en DS4: la página de logon Fiori con `data-sap-login`
// (messages vacío al pedir el login), POST a /sap/bc/ui2/flp que responde 302 si es correcto.
//
// No entra en `npm test` (necesita navegador): se corre con `npm run test:rpa`.
// ============================================================
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const USER = 'BOT_USER';
const GOOD = 'Good-Pa55w0rd-123';
const BAD  = 'Wrong-Pa55w0rd-456';

const sapLogin = (messages) => Buffer.from(encodeURIComponent(JSON.stringify({
    login_params: {}, languages: {}, texts: {}, properties: { lang: 'EN' }, messages,
})), 'latin1').toString('base64');
const logonPage = (messages) => `<!doctype html><html><body data-sap-login="${sapLogin(messages)}">
    <form method="post" action="/sap/bc/ui2/flp">
      <label for="u">User</label><input id="u" name="sap-user">
      <label for="p">Password</label><input id="p" type="password" name="sap-password">
      <button type="submit">Log On</button>
    </form></body></html>`;

const log = { logonPosts: 0, logoffs: 0 };
const srv = http.createServer((req, res) => {
    const loggedIn = /SAP_SESSIONID_X_100=ok/.test(req.headers.cookie || '');
    if (req.url.startsWith('/sap/public/bc/icf/logoff')) {
        log.logoffs++;
        res.writeHead(200, { 'set-cookie': 'SAP_SESSIONID_X_100=; Max-Age=0; Path=/' });
        return res.end('logged off');
    }
    if (req.method === 'POST' && req.url.startsWith('/sap/bc/ui2/flp')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            log.logonPosts++;
            const pass = new URLSearchParams(body).get('sap-password');
            if (pass === GOOD) {
                res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'SAP_SESSIONID_X_100=ok; Path=/' });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(logonPage(['Name or password is incorrect (repeat logon)']));
        });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(loggedIn
        ? '<!doctype html><html><body><script>window.sap = { ui: { getCore() { return {}; } } };</script>launchpad</body></html>'
        : logonPage([]));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

// El trace se guarda en el directorio de trabajo: uno temporal para no ensuciar el repo.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-logon-'));
process.chdir(tmp);
// Todo el zip, para buscar la contraseña; y sólo acciones + red, para buscar el POST de logon (el
// zip incluye el código fuente de fiori.js, que contiene el texto `sap-password=`).
const unzip = (iid, ...members) => execFileSync('unzip', ['-p', `trace-${iid}.zip`, ...members], { maxBuffer: 1 << 28 }).toString('latin1');
const traceText = (iid) => unzip(iid);
const traceCalls = (iid) => unzip(iid, 'trace.trace', 'trace.network');

const script = { blocks: [{ block_id: 'B', block_seq: 1, instructions: [] }] };
const run = async (password, jobIid, events) => runFiori(script, {
    serverOrigin: origin, sapClient: 100, username: USER, password, debug: true, headless: true, jobIid,
    onProgress: (e) => events.push(e),
});

console.log('== C3 · login rechazado ==');
let events = [];
let t = Date.now();
let r = await run(BAD, 'rejected', events);
const secs = (Date.now() - t) / 1000;
ok(r.success === false && r.failure?.code === 'INVALID_CREDENTIALS', 'failure.code = INVALID_CREDENTIALS', r.failure?.code);
ok(secs < 10, 'falla en segundos, no a los 120 s', `${secs.toFixed(1)} s`);
ok(/Name or password is incorrect/.test(r.failure?.message) && r.failure.message.includes(USER), 'el mensaje lleva el texto de SAP y el usuario');
ok(/^login SAP/.test(r.failure?.phase || ''), 'la fase dice login, no arranque del launchpad', r.failure?.phase);
ok(log.logonPosts === 1, 'un único POST de logon: no se reintenta', log.logonPosts);
ok(!JSON.stringify(r).includes(BAD) && !JSON.stringify(events).includes(BAD), 'la contraseña no está en el resultado ni en los eventos de progreso');
const tr1 = fs.existsSync('trace-rejected.zip') ? traceText('rejected') : '';
ok(tr1 && !tr1.includes(BAD), 'el trace del rechazo no contiene la contraseña');
ok(log.logoffs === 0, 'sin sesión no hay logoff');

console.log('\n== C4 · login correcto ==');
log.logonPosts = 0;
events = [];
r = await run(GOOD, 'accepted', events);
ok(r.success === true && !r.failure, 'el login correcto sigue funcionando', r.failure?.message);
ok(r.durationMs < 10000, 'sin los ~24 s de la espera de navegación de SAPLogin', `${(r.durationMs / 1000).toFixed(1)} s`);
const tr2 = fs.existsSync('trace-accepted.zip') ? traceText('accepted') : '';
ok(tr2.length > 0, 'hay trace');
ok(tr2 && !tr2.includes(GOOD), 'el trace no contiene la contraseña (ni el fill ni el cuerpo del POST)');
ok(tr2 && !traceCalls('accepted').includes('sap-password'), 'el trace no contiene el POST de logon ni el fill del campo Password');
ok(tr2.includes('launchpad'), 'el trace sí recoge lo de después del login');
ok(log.logoffs === 1, 'la sesión SAP se cierra al terminar (logoff del ICF)', log.logoffs);

srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
