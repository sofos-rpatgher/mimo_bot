// ============================================================
// C3 y C4 (contrato MIMO fase 2) — runFiori contra un logon de SAP de mentira servido por HTTPS
// con un certificado de OTRO nombre, como el de SofOS (sdesk.sofoscorp.com en web01.sofos.proatech.mx).
//
//   - C3: sin huella fijada, el job falla al conectar, con un mensaje de certificado, y SIN que
//     llegue el POST de logon. Con la huella SPKI del certificado en tlsPinnedKeys, entra.
//     Con la huella de otro certificado (p. ej. tras una renovación), vuelve a fallar.
//   - C4: la contraseña no aparece en la salida por consola, el resultado, los eventos de
//     progreso ni el trace.
//
// Necesita navegador y el binario `openssl` (genera el certificado). Va en `npm run test:rpa`.
// ============================================================
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const USER = 'RPA_BOT';
const PASS = 'Tls-Pr0ba-S3cr3ta-789';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-tls-'));
const keyFile = path.join(tmp, 'key.pem');
const certFile = path.join(tmp, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '2', '-subj', '/CN=otro-host.example', '-addext', 'subjectAltName=DNS:otro-host.example'], { stdio: 'ignore' });
const cert = fs.readFileSync(certFile);
const spki = crypto.createHash('sha256')
    .update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

const sapLogin = (messages) => Buffer.from(encodeURIComponent(JSON.stringify({
    login_params: {}, languages: {}, texts: {}, properties: { lang: 'EN' }, messages,
})), 'latin1').toString('base64');
const logonPage = `<!doctype html><html><body data-sap-login="${sapLogin([])}">
    <form method="post" action="/sap/bc/ui2/flp">
      <label for="u">User</label><input id="u" name="sap-user">
      <label for="p">Password</label><input id="p" type="password" name="sap-password">
      <button type="submit">Log On</button>
    </form></body></html>`;

const log = { logonPosts: 0, logoffs: 0 };
const srv = https.createServer({ key: fs.readFileSync(keyFile), cert }, (req, res) => {
    if (req.url.startsWith('/sap/public/bc/icf/logoff')) { log.logoffs++; return res.end('bye'); }
    if (req.method === 'POST') {
        req.resume();
        req.on('end', () => {
            log.logonPosts++;
            res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' });
            res.end();
        });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(/S=ok/.test(req.headers.cookie || '')
        ? '<!doctype html><html><body><script>window.sap = { ui: { getCore() { return {}; } } };</script>launchpad</body></html>'
        : logonPage);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `https://127.0.0.1:${srv.address().port}`;

// Toda la salida por consola de runFiori, para buscar la contraseña (C4).
let captured = '';
const orig = { log: console.log, warn: console.warn, error: console.error };
for (const k of Object.keys(orig)) console[k] = (...a) => { captured += a.join(' ') + '\n'; orig[k](...a); };

process.chdir(tmp);
const script = { blocks: [{ block_id: 'B', block_seq: 1, instructions: [] }] };
const run = (jobIid, tlsPinnedKeys, events, extra = {}) => runFiori(script, {
    serverOrigin: origin, sapClient: '100', username: USER, password: PASS, sap_system: 'PRUEBA_TLS',
    tlsPinnedKeys, debug: true, headless: true, jobIid, onProgress: (e) => events.push(e), ...extra,
});
const allEvents = [];
const results = [];

console.log('== C3 · sin huella ==');
let r = await run('nopin', [], allEvents); results.push(r);
ok(r.success === false && /Certificado TLS no válido/.test(r.failure?.message), 'falla por certificado, con un mensaje que lo dice', r.failure?.message?.slice(0, 120));
ok(/tlsPinnedKeys\['PRUEBA_TLS'\]/.test(r.failure?.message || ''), 'el mensaje dice dónde fijar la huella');
ok(/^conexión TLS/.test(r.failure?.phase || ''), 'fase: conexión TLS', r.failure?.phase);
ok(log.logonPosts === 0, 'el POST de logon no llega a salir', log.logonPosts);

console.log('\n== C3 · huella de otro certificado (renovación) ==');
r = await run('wrongpin', ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='], allEvents); results.push(r);
ok(r.success === false && /ninguna coincide: ¿se renovó el certificado\?/.test(r.failure?.message || ''), 'falla y apunta a una renovación', r.failure?.message?.slice(-90));
ok(log.logonPosts === 0, 'el POST de logon no llega a salir', log.logonPosts);

console.log('\n== C3 · huella correcta ==');
r = await run('pin', [spki], allEvents); results.push(r);
ok(r.success === true, 'entra con la huella del certificado', r.failure?.message);
ok(log.logonPosts === 1, 'un POST de logon', log.logonPosts);
ok(log.logoffs === 1, 'el logoff también pasa por el navegador con la huella', log.logoffs);

console.log('\n== fase 2c · el modo viene del job (MIMO) ==');
log.logonPosts = 0;
r = await run('job-verify', [], allEvents, { tlsMode: 'VERIFY', tlsSource: 'job' }); results.push(r);
ok(r.success === false && /Configurad TLS Certificate Validation de PRUEBA_TLS en MIMO \(SAP Systems\)/.test(r.failure?.message || ''),
   'VERIFY: falla y el mensaje apunta a MIMO, no al config.json', r.failure?.message?.slice(0, 160));
ok(!/tlsPinnedKeys/.test(r.failure?.message || '') && log.logonPosts === 0, 'sin mencionar tlsPinnedKeys y sin enviar la contraseña');
r = await run('job-wrongpin', ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='], allEvents, { tlsMode: 'PINNED', tlsSource: 'job' }); results.push(r);
ok(r.success === false && /en MIMO/.test(r.failure?.message || '') && /ninguna coincide: ¿se renovó el certificado\?/.test(r.failure?.message || ''),
   'PINNED con otra huella: apunta a MIMO y a una renovación');
r = await run('job-pin', [spki], allEvents, { tlsMode: 'PINNED', tlsSource: 'job' }); results.push(r);
ok(r.success === true && r.target?.tls_mode === 'PINNED', 'PINNED con su huella: entra; target.tls_mode = PINNED');
const insecureEvents = [];
r = await run('job-insecure', [], insecureEvents, { tlsMode: 'INSECURE', tlsSource: 'job' }); results.push(r); allEvents.push(...insecureEvents);
ok(r.success === true && r.target?.tls_mode === 'INSECURE', 'INSECURE: entra sin validar; target.tls_mode = INSECURE');
ok(insecureEvents.some((e) => e.level === 'WARN' && /Certificado no validado: SAP Systems → PRUEBA_TLS está en INSECURE/.test(e.message)), 'con el evento WARN');
ok(/Certificado no validado: SAP Systems → PRUEBA_TLS está en INSECURE/.test(captured), 'y el aviso en el log');

for (const k of Object.keys(orig)) console[k] = orig[k];

console.log('\n== C4 · la contraseña no se escribe en ningún sitio ==');
ok(captured.includes(USER) && !captured.includes(PASS), 'ni en la salida por consola (que sí lleva el usuario)');
ok(!JSON.stringify(results).includes(PASS), 'ni en los resultados');
ok(!JSON.stringify(allEvents).includes(PASS), 'ni en los eventos de progreso');
const traces = fs.readdirSync(tmp).filter((f) => f.endsWith('.zip'));
const inTraces = traces.filter((f) => execFileSync('unzip', ['-p', f], { maxBuffer: 1 << 28 }).toString('latin1').includes(PASS));
ok(traces.length > 0 && inTraces.length === 0, 'ni en los traces', `${traces.length} trace(s), ${inTraces.length} con la contraseña`);

srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
