// ============================================================
// B21 — runFiori de punta a punta: SAP rechaza una escritura y el paso siguiente no puede ocurrir
// (job 6ee54fd1).
//
// «Manage Launchpad Pages» de mentira: el paso 1 pulsa «Create» y la app envía POST pageSet; SAP
// responde HTTP 400 «Page …: Exists already.» y la app se queda donde estaba. El paso 2 espera «Edit»,
// que sólo aparecería si la página se hubiera creado.
//   - rápido: el 400 llega antes del paso 2. Antes: 30 s esperando «Edit» y error de timeout, sin el
//     400. Ahora el intent falla al empezar el paso 2 con el mensaje de SAP.
//   - lento: el 400 llega durante la espera del paso 2. Antes: el mismo timeout. Ahora el error lleva
//     delante el 400 como causa.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~1 min. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const VW = 'application-FLPPage-manage-component---view';
const LAUNCHPAD = `<!doctype html><html><body>
<div id="application-FLPPage-manage-component" style="width:600px;min-height:200px">
  <button id="${VW}--createButton">Create</button>
  <button id="${VW}--buttonEdit" style="display:none">Edit</button>
</div>
<script>
  const delay = new URLSearchParams(location.search).get('delay');
  const reg = new Map();
  class Ctl {
    constructor(id, type, props = {}, parent = null) { Object.assign(this, { id, type, props, parent }); reg.set(id, this);
      for (const k of Object.keys(props)) this['get' + k[0].toUpperCase() + k.slice(1)] = () => this.props[k]; }
    getId() { return this.id; } getMetadata() { return { getName: () => this.type }; }
    getDomRef() { return document.getElementById(this.id); } getFocusDomRef() { return this.getDomRef(); }
    getParent() { return this.parent; } getBusy() { return false; } getEnabled() { return true; }
  }
  const view = new Ctl('${VW}', 'sap.ui.core.mvc.XMLView');
  new Ctl('${VW}--createButton', 'sap.m.Button', { text: 'Create' }, view);
  new Ctl('${VW}--buttonEdit', 'sap.m.Button', { text: 'Edit', type: 'Emphasized' }, view);
  document.getElementById('${VW}--createButton').addEventListener('click', () => {
    fetch('/sap/opu/odata/UI2/FDM_PAGE_REPOSITORY_CUST_SRV/pageSet?sap-client=100&delay=' + delay,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"Z_BR_MMSAP_PRC_PG_PO_PROCESSING"}' })
      .then((r) => { if (r.ok) document.getElementById('${VW}--buttonEdit').style.display = 'inline-block'; });
  });
  window.sap = { ui: { getCore() { return { byId: (id) => reg.get(id) || null, applyChanges() {} }; },
                       core: { Element: { registry: { forEach: (f) => [...reg.values()].forEach(f) } } } } };
</script></body></html>`;

const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/sap/opu/')) {
        req.resume();
        const delay = +new URL(req.url, 'http://x').searchParams.get('delay');
        return setTimeout(() => {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: '/UI2/PAGE/003', message: { lang: 'en', value: 'Page Z_BR_MMSAP_PRC_PG_PO_PROCESSING: Exists already.' },
                innererror: { errordetails: [{ code: '/UI2/CX_FDM_DUPLICATE' }] } } }));
        }, delay);
    }
    if (req.method === 'POST') {
        req.resume();
        req.on('end', () => { res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' }); res.end(); });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(/S=ok/.test(req.headers.cookie || '')
        ? LAUNCHPAD
        : `<!doctype html><html><body data-sap-login="${sapLogin}"><form method="post" action="/sap/bc/ui2/flp">
             <label for="u">User</label><input id="u" name="sap-user"><label for="p">Password</label><input id="p" type="password" name="sap-password">
             <button type="submit">Log On</button></form></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let captured = '';
const orig = { log: console.log, warn: console.warn };
const capture = (on) => { for (const k of Object.keys(orig)) console[k] = on ? (...a) => { captured += a.map(String).join(' ') + '\n'; } : orig[k]; };

// Selectores como los grabó MIMO (job 6ee54fd1).
const STEPS = [
    { technology: 'UI5', action: 'click', wdi5_selector: { properties: { text: 'Create' }, controlType: 'sap.m.Button', id: `${VW}--createButton` } },
    { technology: 'UI5', action: 'click', wdi5_selector: { properties: { type: 'Emphasized', title: null, text: 'Edit' }, controlType: 'sap.m.Button', id: `${VW}--buttonEdit` } },
];
const run = async (delay) => {
    captured = '';
    capture(true);
    const t = Date.now();
    try {
        const r = await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'CREATE_PAGE_SECTIONS', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp?delay=${delay}#FLPPage-manage`, code: STEPS }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true });
        return { ...r, ms: Date.now() - t };
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

const REJ = /POST UI2\/FDM_PAGE_REPOSITORY_CUST_SRV\/pageSet → HTTP 400 Page Z_BR_MMSAP_PRC_PG_PO_PROCESSING: Exists already\./;

console.log('== rápido: el 400 llega antes del paso siguiente (job 6ee54fd1) ==');
const a = await run(0);
const am = a.failure?.message || '';
ok(a.success === false && /^SAP rechazó 1 escritura\(s\) de un paso anterior: /.test(am) && REJ.test(am),
   'falla con el mensaje de SAP (antes: timeout esperando «Edit»)', am.slice(0, 200));
ok(/El paso 2 no se ejecuta/.test(am), 'y no ejecuta el paso 2');
ok(a.ms < 25000, 'sin esperar 30 s a «Edit»', `${(a.ms / 1000).toFixed(1)} s`);

console.log('\n== lento: el 400 llega mientras el paso siguiente espera ==');
const b = await run(2500);
const bm = b.failure?.message || '';
ok(b.success === false && /^SAP rechazó 1 escritura\(s\): /.test(bm) && REJ.test(bm) && /por eso, probablemente, el paso 2 falló: .*Timeout/.test(bm),
   'el error lleva delante el 400 y después el timeout (antes: sólo el timeout)', bm.slice(0, 240));

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
