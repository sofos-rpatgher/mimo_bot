// ============================================================
// B23 — runFiori de punta a punta: SAP tarda más de 30 s en devolver la página de la app (job b47044fb).
//
// Launchpad de mentira cuyo servidor retiene la respuesta de la app (`?slow=ms`). El paso pulsa un botón
// UI5 de esa página.
//   - tarde: la página llega a los 45 s. Antes: `page.goto: Timeout 30000ms` y el job moría (la
//     tolerancia de B15 sólo valía si el documento ya había llegado). Ahora se espera, hasta el techo
//     de arranque, y el paso se ejecuta.
//   - nunca: no llega dentro del techo (40 s en el test). Falla diciendo que SAP no devolvió la página,
//     no con el timeout de Playwright.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~2 min. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const VW = 'application-FLPPage-manage-component---view';
const LAUNCHPAD = `<!doctype html><html><body>
<div id="application-FLPPage-manage-component" style="width:600px;min-height:100px"><button id="${VW}--createButton">Create</button></div>
<script>
  const reg = new Map();
  class Ctl {
    constructor(id, type, props = {}) { Object.assign(this, { id, type, props }); reg.set(id, this);
      for (const k of Object.keys(props)) this['get' + k[0].toUpperCase() + k.slice(1)] = () => this.props[k]; }
    getId() { return this.id; } getMetadata() { return { getName: () => this.type }; }
    getDomRef() { return document.getElementById(this.id); } getFocusDomRef() { return this.getDomRef(); }
    getParent() { return null; } getBusy() { return false; } getEnabled() { return true; }
  }
  new Ctl('${VW}--createButton', 'sap.m.Button', { text: 'Create' });
  document.getElementById('${VW}--createButton').addEventListener('click', () => fetch('/hit?create'));
  window.sap = { ui: { getCore() { return { byId: (id) => reg.get(id) || null, applyChanges() {} }; },
                       core: { Element: { registry: { forEach: (f) => [...reg.values()].forEach(f) } } } } };
</script></body></html>`;

const hits = [];
const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/hit?')) { hits.push(req.url.slice(5)); return res.end(); }
    if (req.method === 'POST') {
        req.resume();
        req.on('end', () => { res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' }); res.end(); });
        return;
    }
    const slow = +(new URL(req.url, 'http://x').searchParams.get('slow') || 0);
    setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(/S=ok/.test(req.headers.cookie || '')
            ? LAUNCHPAD
            : `<!doctype html><html><body data-sap-login="${sapLogin}"><form method="post" action="/sap/bc/ui2/flp">
                 <label for="u">User</label><input id="u" name="sap-user"><label for="p">Password</label><input id="p" type="password" name="sap-password">
                 <button type="submit">Log On</button></form></body></html>`);
    }, slow);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let captured = '';
const orig = { log: console.log, warn: console.warn };
const capture = (on) => { for (const k of Object.keys(orig)) console[k] = on ? (...a) => { captured += a.map(String).join(' ') + '\n'; } : orig[k]; };

const STEPS = [{ technology: 'UI5', action: 'click', wdi5_selector: { properties: { text: 'Create' }, controlType: 'sap.m.Button', id: `${VW}--createButton` } }];
const run = async (slow, extra = {}) => {
    captured = ''; hits.length = 0;
    capture(true);
    try {
        return await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'CREATE_PAGE_SECTIONS', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp?slow=${slow}#FLPPage-manage`, code: STEPS }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true, ...extra });
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== tarde: la página llega a los 45 s (job b47044fb) ==');
let r = await run(45000);
ok(r.success === true, 'el intent termina bien (antes: page.goto: Timeout 30000ms)', r.failure?.message?.slice(0, 160));
ok(hits.join() === 'create', 'y el paso se ejecuta', hits.join());
ok(/SAP no ha devuelto la página en 30 s; se le espera hasta 120 s/.test(captured) && /La página llegó a los 4\d s/.test(captured), 'el log dice que espera y cuándo llegó');

console.log('\n== nunca: no llega dentro del techo (40 s) ==');
r = await run(70000, { bootCeilingMs: 40000 });
const m = r.failure?.message || '';
ok(r.success === false && /SAP no devolvió la página .*\?slow=70000.*#FLPPage-manage en 40 s: la navegación sigue sin respuesta del servidor/.test(m),
   'falla diciendo que SAP no devolvió la página', m.slice(0, 200));
ok(hits.length === 0, 'sin ejecutar el paso', hits.join());

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
