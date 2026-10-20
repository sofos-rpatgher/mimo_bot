// ============================================================
// Fase 2b — un job `login-check` de punta a punta por el worker (runJob): sólo login y logout para
// verificar la contraseña de un usuario SAP.
//
// Contra un logon de SAP de mentira (como logon-e2e.test.js). `fetch` se sustituye para capturar los
// notify a MIMO y comprobar que nada va al servicio de SAP GUI. Casos de la tabla de verificación
// del contrato:
//   - contraseña buena → COMPLETED en segundos, con logoff y sin abrir ninguna app;
//   - contraseña mala → FAILED con INVALID_CREDENTIALS, un único POST de logon;
//   - sin sap_password → FAILED con rejected: true, sin tocar el servidor;
//   - la contraseña no aparece en la consola, los notify ni ficheros; no se graba trace.
//
// Necesita navegador y config.json (el worker lo lee: el sistema del job sale de sus sap_systems).
// Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runJob } = require('../src/worker');
const config = require('../config.json');
const { reachableSystems } = require('../src/job-check');

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const USER = 'JPEREZ';
const GOOD = 'Verify-B0na-123';
const BAD  = 'Verify-Mala-456';

const sapLogin = (messages) => Buffer.from(encodeURIComponent(JSON.stringify({
    login_params: {}, languages: {}, texts: {}, properties: { lang: 'EN' }, messages,
})), 'latin1').toString('base64');
const logonPage = (messages) => `<!doctype html><html><body data-sap-login="${sapLogin(messages)}">
    <form method="post" action="/sap/bc/ui2/flp">
      <label for="u">User</label><input id="u" name="sap-user">
      <label for="p">Password</label><input id="p" type="password" name="sap-password">
      <button type="submit">Log On</button>
    </form></body></html>`;

const seen = { paths: [], logonPosts: 0, logoffs: 0 };
const srv = http.createServer((req, res) => {
    seen.paths.push(req.url.split('?')[0]);
    if (req.url.startsWith('/sap/public/bc/icf/logoff')) { seen.logoffs++; return res.end('bye'); }
    if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.logonPosts++;
            if (new URLSearchParams(body).get('sap-password') === GOOD) {
                res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(logonPage(['Name or password is incorrect (repeat logon)']));
        });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(/S=ok/.test(req.headers.cookie || '')
        ? '<!doctype html><html><body><script>window.sap = { ui: { getCore() { return {}; } } };</script>launchpad</body></html>'
        : logonPage([]));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

// notify y cualquier otra llamada de red del worker, capturadas.
const calls = [];
globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
let captured = '';
const orig = { log: console.log, warn: console.warn, error: console.error };
for (const k of Object.keys(orig)) console[k] = (...a) => { captured += a.map(String).join(' ') + '\n'; orig[k](...a); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-lc-'));
process.chdir(tmp);

const system = reachableSystems(config)[0];
const job = (iid, password) => ({ job_iid: iid, batch_iid: null, batch_id: '', rpa_type: 'login-check', script: '',
    sap_system: system, server_origin: origin, sap_client: '100', sap_user: USER, sap_password: password });
const notified = (iid) => calls.filter((c) => c.body?.job_iid === iid && /\/notify$/.test(c.url)).map((c) => ({ ...c.body, result: c.body.result_json ? JSON.parse(c.body.result_json) : null }));

console.log(`== contraseña buena (sistema ${system}) ==`);
let t = Date.now();
await runJob(job('LC-OK', GOOD));
const secs = (Date.now() - t) / 1000;
let n = notified('LC-OK');
ok(n.length === 1 && n[0].status_code === 'COMPLETED' && n[0].result?.success === true, 'COMPLETED', n[0]?.status_code);
ok(secs < 20, 'en segundos', `${secs.toFixed(1)} s`);
ok(n[0]?.result?.target?.username === USER, 'el resultado lleva el target con el usuario');
ok(seen.logoffs === 1, 'cierra la sesión SAP', seen.logoffs);
const apps = seen.paths.filter((p) => !['/sap/bc/ui2/flp', '/sap/public/bc/icf/logoff', '/favicon.ico'].includes(p));
ok(apps.length === 0, 'no abre ninguna app', apps.join() || '—');

console.log('\n== contraseña mala ==');
seen.logonPosts = 0;
await runJob(job('LC-BAD', BAD));
n = notified('LC-BAD');
ok(n[0]?.status_code === 'FAILED' && n[0].result?.failure?.code === 'INVALID_CREDENTIALS', 'FAILED con INVALID_CREDENTIALS', n[0]?.result?.failure?.code);
ok(seen.logonPosts === 1, 'un único POST de logon: sin reintentos', seen.logonPosts);

console.log('\n== sin sap_password ==');
const before = seen.paths.length;
await runJob(job('LC-EMPTY', ''));
n = notified('LC-EMPTY');
ok(n[0]?.status_code === 'FAILED' && n[0].result?.failure?.rejected === true && n[0].result.failure.phase === 'job-check', 'FAILED con rejected: true (job-check)');
ok(seen.paths.length === before, 'sin tocar el servidor SAP');

console.log('\n== fase 2c · INSECURE sin permiso local ==');
const before2 = seen.paths.length;
const allowed = (config.allowInsecureTls || []).map((x) => String(x).toUpperCase());
if (allowed.includes(String(system).toUpperCase())) {
    console.log(`  · omitido: el config.json de esta máquina permite INSECURE para ${system}`);
} else {
    await runJob({ ...job('LC-INSECURE', GOOD), tls_mode: 'INSECURE', tls_pins: [] });
    n = notified('LC-INSECURE');
    ok(n[0]?.status_code === 'FAILED' && n[0].result?.failure?.rejected === true && /allowInsecureTls/.test(n[0].result.failure.message),
       'FAILED con rejected: true, nombrando allowInsecureTls', n[0]?.result?.failure?.phase);
    ok(seen.paths.length === before2, 'sin tocar el servidor SAP');
}

for (const k of Object.keys(orig)) console[k] = orig[k];

console.log('\n== el resto ==');
ok(!calls.some((c) => /localhost:\d+\/run$/.test(c.url)), 'nada va al servicio de SAP GUI');
ok(!calls.some((c) => /reportProgress/i.test(c.url)), 'ningún evento de progreso');
ok(captured.includes(USER) && !captured.includes(GOOD) && !captured.includes(BAD), 'la contraseña no sale por consola (el usuario sí)');
ok(!JSON.stringify(calls).includes(GOOD) && !JSON.stringify(calls).includes(BAD), 'ni en los notify a MIMO');
ok(fs.readdirSync(tmp).length === 0, 'no escribe ficheros (ni trace)', fs.readdirSync(tmp).join() || '—');

srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
