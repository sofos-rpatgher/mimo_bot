// ============================================================
// B16 — runFiori de punta a punta con SAP WebGUI ocupado tras una acción (job df7e6729).
//
// Reproduce el filtro del Content Manager: dos popups abiertos (wnd[1] «Filter», wnd[2] valores) con el
// fondo modal entre ellos. El paso 1 pulsa el Enter de wnd[2]; SAP enciende su indicador de carga
// (`#ur-loading`) y, al terminar, cierra los dos popups. El paso 2 marca la fila de la lista de abajo
// (wnd[0]).
//   - lenta: SAP tarda 8 s. Antes: la pantalla se daba por quieta, B11 esperaba 5 s y fallaba con
//     «Ventana de SAP abierta encima». Ahora espera al indicador y el clic llega a la fila.
//   - colgada: el indicador no se apaga (techo de 6 s en el test). El paso falla diciendo que SAP no
//     terminó de procesar, y no hace clic.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~1,5 min. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const ROW = 'wnd[0]/usr/cntlGO_CONTAINER_TTM_SEL/shellcont/shell/rowcol/row[1]/cell[7]';
const ENTER = 'wnd[2]/tbar[0]/btn[0]';
const sid = (s) => `lsdata='{"27":{"SID":"${s}"}}'`;

// La app WEBGUI. `busy` (ms, -1 = nunca termina) llega en la query del iframe.
const WEBGUI = `<!doctype html><html><head><style>
  .lsPWNew { position: fixed; width: 300px; height: 160px; background: #fff; border: 1px solid #888; }
  #urPopupWindowBlockLayer { position: fixed; inset: 0; background: rgba(0,0,0,.2); }
</style></head><body>
  <div ct="B" ${sid(ROW)} style="width:200px;height:24px">fila 1</div>
  <div id="urPopupWindowBlockLayer" class="lsBlockLayer" style="display:block;z-index:10100"></div>
  <div class="lsPWNew" ${sid('wnd[1]')} style="top:10px;left:10px;z-index:10000">Filter 1st Step: Define the Filter Criteria</div>
  <div class="lsPWNew" ${sid('wnd[2]')} style="top:40px;left:60px;z-index:10200">Determine Values
    <div ct="B" ${sid(ENTER)} style="width:60px;height:24px">OK</div></div>
  <div id="ur-loading" class="lsLoadARoot" style="position:absolute;display:none;visibility:hidden;z-index:20000"><div style="width:40px;height:40px">…</div></div>
<script>
  const busy = +new URLSearchParams(location.search).get('busy');
  const hit = (what) => fetch('/hit?' + what);
  document.querySelector('[lsdata*="${ENTER}"]').addEventListener('click', () => {
    hit('enter');
    const l = document.getElementById('ur-loading');
    l.style.display = 'block'; l.style.visibility = 'visible';
    if (busy >= 0) setTimeout(() => {
      l.style.display = 'none'; l.style.visibility = 'hidden';
      document.querySelectorAll('.lsPWNew, #urPopupWindowBlockLayer').forEach((e) => e.remove());
    }, busy);
  });
  document.querySelector('[lsdata*="row[1]"]').addEventListener('click', () => hit('row'));
  // Un clic que cae en el fondo modal es un clic que SAP ignora.
  document.getElementById('urPopupWindowBlockLayer').addEventListener('click', () => hit('under-modal'));
</script></body></html>`;

const LAUNCHPAD = `<!doctype html><html><body><script>
  window.sap = { ui: { getCore() { return { byId() { return null; } }; } } };
  const h = location.hash.slice(1);
  if (h) document.write('<iframe id="application-' + h + '-iframe" title="Application" width="800" height="400" '
                      + 'src="/sap/bc/gui/sap/its/webgui;~sysid=DS4?busy=' + h.replace(/^.*busy/, '') + '"></iframe>');
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
    if (req.url.startsWith('/sap/bc/gui/sap/its/webgui')) return res.end(WEBGUI);
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

const STEPS = [{ technology: 'WEBGUI', action: 'click', sid: ENTER }, { technology: 'WEBGUI', action: 'click', sid: ROW }];
const run = async (busy, extra = {}) => {
    captured = ''; hits.length = 0;
    capture(true);
    try {
        return await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'ADD_TILES', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp#CatalogTiles-busy${busy}`, code: STEPS }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true, ...extra });
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== lenta: SAP tarda 8 s en procesar el Enter (job df7e6729) ==');
let r = await run(8000);
ok(r.success === true, 'el intent termina bien (antes: «Ventana de SAP abierta encima»)', r.failure?.message?.slice(0, 160));
ok(hits.join() === 'enter,row', 'el clic llega a la fila, después de que SAP cierre el filtro', hits.join());

console.log('\n== colgada: el indicador no se apaga (techo 6 s) ==');
r = await run(-1, { webguiBusyCeilingMs: 6000 });
ok(r.success === false && /SAP WebGUI no terminó de procesar la acción anterior en 6 s \(sigue con su indicador de carga\)/.test(r.failure?.message || ''),
   'falla diciendo que SAP sigue procesando', r.failure?.message?.slice(0, 160));
ok(!/Ventana de SAP abierta encima/.test(r.failure?.message || ''), 'no lo confunde con una ventana abierta');
ok(hits.join() === 'enter', 'y no hace clic sobre la pantalla vieja', hits.join());

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
