// ============================================================
// B20 — runFiori de punta a punta con dos ventanas de SAP apiladas sobre la pantalla (job 41beb341).
//
// Como en el job: al crear un catálogo que ya existía, SAP dejó abierta wnd[1] «Create Catalog» y,
// encima, wnd[2] «Information · Catalog '…' already exists». El paso siguiente actúa sobre wnd[0].
//   - ya existe: antes, el bot esperaba y el error citaba wnd[1] (la primera en el DOM), que no
//     explica nada. Ahora falla al momento citando el «already exists» y qué hacer.
//   - otra ventana: el error cita la de más arriba (wnd[2]) y luego las de debajo.
// En los dos casos el clic no se hace.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~40 s. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const BTN = 'wnd[0]/usr/btnGO_BUTTON';
const sid = (s) => `lsdata='{"27":{"SID":"${s}"}}'`;
const TOP = {
    exists: "Information Catalog 'Z_BR_MMSAP_BR_PURCHASER_CATALOG' already exists in configuration or customizing scope Continue Help",
    other: 'Log Display 2 errors Continue',
};

// La app WEBGUI. `mode` llega en la query del iframe.
const WEBGUI = (mode) => `<!doctype html><html><head><style>
  .lsPWNew { position: fixed; width: 300px; height: 120px; background: #fff; border: 1px solid #888; }
  #urPopupWindowBlockLayer { position: fixed; inset: 0; background: rgba(0,0,0,.2); }
</style></head><body>
  <div ct="B" ${sid(BTN)} style="width:200px;height:24px">botón</div>
  <div class="lsPWNew" ${sid('wnd[1]')} style="top:10px;left:10px;z-index:10000">Create Catalog New ID New Title Continue Cancel</div>
  <div id="urPopupWindowBlockLayer" class="lsBlockLayer" style="display:block;z-index:10100"></div>
  <div class="lsPWNew" ${sid('wnd[2]')} style="top:60px;left:60px;z-index:10200">${TOP[mode]}</div>
<script>
  document.querySelector('[lsdata*="${BTN}"]').addEventListener('click', () => fetch('/hit?click'));
</script></body></html>`;

const LAUNCHPAD = `<!doctype html><html><body><script>
  window.sap = { ui: { getCore() { return { byId() { return null; } }; } } };
  const h = location.hash.slice(1);
  if (h) document.write('<iframe id="application-' + h + '-iframe" title="Application" width="800" height="400" '
                      + 'src="/sap/bc/gui/sap/its/webgui;~sysid=DS4?mode=' + h.replace(/^.*-/, '') + '"></iframe>');
</script>launchpad</body></html>`;

const hits = [];
const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/hit?')) { hits.push(req.url.slice(5)); return res.end(); }
    if (req.method === 'POST') {
        req.resume();
        req.on('end', () => { res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' }); res.end(); });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url.startsWith('/sap/bc/gui/sap/its/webgui')) return res.end(WEBGUI(new URL(req.url, 'http://x').searchParams.get('mode')));
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

const run = async (mode) => {
    captured = ''; hits.length = 0;
    capture(true);
    const t = Date.now();
    try {
        const r = await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'CREATE_CATALOG_TILES', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp#CatalogTiles-${mode}`, code: [{ technology: 'WEBGUI', action: 'click', sid: BTN }] }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true });
        return { ...r, ms: Date.now() - t };
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== ya existe: «Information · already exists» sobre «Create Catalog» (job 41beb341) ==');
const a = await run('exists');
const am = a.failure?.message || '';
ok(a.success === false && /SAP dice que el objeto ya existe \(wnd\[2\]\): "Information Catalog 'Z_BR_MMSAP_BR_PURCHASER_CATALOG' already exists/.test(am),
   'falla citando el «already exists» (antes: citaba wnd[1] «Create Catalog»)', am.slice(0, 200));
ok(/hay que borrarlo en SAP \(o quitarlo de la tanda\) antes de relanzar/.test(am), 'y dice qué hacer');
ok(/Debajo: wnd\[1\] "Create Catalog/.test(am), 'y menciona la ventana de debajo', am.slice(-120));
ok(hits.length === 0, 'no hace el clic', hits.join());

console.log('\n== otra ventana encima: se cita la de más arriba ==');
const b = await run('other');
const bm = b.failure?.message || '';
ok(b.success === false && /Ventana de SAP abierta encima \(wnd\[2\]\).*Contenido: "Log Display 2 errors Continue" Debajo: wnd\[1\] "Create Catalog/.test(bm),
   'cita wnd[2] y luego wnd[1] (antes: sólo wnd[1])', bm.slice(0, 220));
ok(hits.length === 0, 'no hace el clic', hits.join());
ok(b.ms - a.ms > 3000, 'el «already exists» no espera a que la ventana se cierre', `${(a.ms / 1000).toFixed(1)} s vs ${(b.ms / 1000).toFixed(1)} s`);

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
