// ============================================================
// B22 — runFiori de punta a punta: un valor que no cabe en el campo WEBGUI no se escribe (job ad52a241).
//
// Diálogo «Create Catalog» de mentira con el campo del ID en maxlength="35", como en SAP. El paso 1
// escribe el ID; el paso 2 pulsa Continue (y la app «crea» el catálogo con lo que haya en el campo).
//   - no cabe: «Z_BR_AA_SAP_BR_AA_ACCOUNTANT_CATALOG» (36). Antes: el navegador lo recortaba a
//     «…_CATALO» y el catálogo se creaba con ese nombre sin aviso. Ahora el paso falla antes de escribir
//     y no se crea nada.
//   - cabe justo: «Z_BR_AA_SAP_SFIN_PG_AA_UPA_DOC_PROC» (35) se escribe y se crea tal cual.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~30 s. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const ID = 'wnd[0]/usr/txtGV_CATALOG_ID';
const CONT = 'wnd[0]/tbar[0]/btn[0]';
const sid = (s) => `lsdata='{"27":{"SID":"${s}"}}'`;

const WEBGUI = `<!doctype html><html><body>
  Create Catalog <input ct="I" ${sid(ID)} maxlength="35" style="width:300px">
  <div ct="B" ${sid(CONT)} style="width:80px;height:24px">Continue</div>
<script>
  document.querySelector('[lsdata*="${CONT}"]').addEventListener('click', () =>
    fetch('/hit?create:' + encodeURIComponent(document.querySelector('[lsdata*="${ID}"]').value)));
</script></body></html>`;

const LAUNCHPAD = `<!doctype html><html><body><script>
  window.sap = { ui: { getCore() { return { byId() { return null; } }; } } };
  if (location.hash) document.write('<iframe id="application-CatalogTiles-iframe" title="Application" width="800" height="300" '
                      + 'src="/sap/bc/gui/sap/its/webgui;~sysid=DS4"></iframe>');
</script>launchpad</body></html>`;

const hits = [];
const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/hit?')) { hits.push(decodeURIComponent(req.url.slice(5))); return res.end(); }
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

const run = async (value) => {
    captured = ''; hits.length = 0;
    capture(true);
    try {
        return await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'CREATE_CATALOG_TILES', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp#CatalogTiles-manage`,
                code: [{ technology: 'WEBGUI', action: 'fill', sid: ID, value }, { technology: 'WEBGUI', action: 'click', sid: CONT }] }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true });
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== no cabe: 36 caracteres en un campo de 35 (job ad52a241) ==');
let r = await run('Z_BR_AA_SAP_BR_AA_ACCOUNTANT_CATALOG');
const m = r.failure?.message || '';
ok(r.success === false && /El campo wnd\[0\]\/usr\/txtGV_CATALOG_ID admite 35 caracteres y el valor «Z_BR_AA_SAP_BR_AA_ACCOUNTANT_CATALOG» tiene 36: se quedaría como «Z_BR_AA_SAP_BR_AA_ACCOUNTANT_CATALO»/.test(m),
   'falla diciendo que no cabe y cómo quedaría', m.slice(0, 200));
ok(hits.length === 0, 'no crea nada (antes: create:…_CATALO)', hits.join());

console.log('\n== cabe justo: 35 caracteres ==');
r = await run('Z_BR_AA_SAP_SFIN_PG_AA_UPA_DOC_PROC');
ok(r.success === true, 'el intent termina bien', r.failure?.message?.slice(0, 160));
ok(hits.join() === 'create:Z_BR_AA_SAP_SFIN_PG_AA_UPA_DOC_PROC', 'crea con el valor completo', hits.join());

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
