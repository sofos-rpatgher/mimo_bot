// ============================================================
// B15 — runFiori de punta a punta con una app que tarda en llegar (job cbe25b0b).
//
// Logon de mentira (como logon-e2e.test.js). El «launchpad», según el hash de la app, baja su código
// con retraso desde /res/…; el contenedor `application-<hash>` lo pinta el fichero lento al llegar.
//   - lento: ShellBar/Component-preload.js tarda 45 s (llega tras el evento load, como las cargas
//     perezosas de UI5). El bot espera a la app (antes seguía a los 35 s: sonda WebGUI + 10 s) sin
//     recargar.
//   - sapui5: re-entrada a la misma app → recarga limpia, y esta vez sap-ui-core.js tarda 65 s y
//     retiene el evento load. Antes: «page.goto: Timeout 30000ms» (el goto de playwright-sap espera
//     también a load); ahora entra.
//   - atascado: Component-preload.js no llega nunca (techo de 15 s en el test). Recarga limpia UNA
//     vez y, si sigue igual, el paso falla con el estado de carga en el mensaje.
//
// Tarda ~4 min. No entra en `npm test` (necesita navegador): `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const SAP = 'window.sap = { ui: { getCore() { return { byId() { return null; } }; }, core: { Element: { registry: { forEach() {} } } } } };';
const APP = "document.body.insertAdjacentHTML('beforeend', '<div id=\"application-' + location.hash.slice(1) + '-component\" style=\"width:80px;height:80px\">app</div>');";
// Como un FLP real: la app (su Component-preload) se carga al entrar por hash, tanto tras el arranque
// como en un cambio de hash sin recarga. sap-ui-core sólo se baja en un arranque completo.
const LAUNCHPAD = `<!doctype html><html><head><script>
  const load = (src) => { const s = document.createElement('script'); s.src = src; document.head.appendChild(s); };
  const mode = () => location.hash.slice(1).split('-')[1];
  if (mode() === 'sapui5') load('/res/sap/ui/core/sap-ui-core.js'); else { ${SAP} }
  const enter = () => {
    if (mode() === 'lento') load('/res/ShellBar/Component-preload.js?ms=45000');
    if (mode() === 'atascado') load('/res/ShellBar/Component-preload.js?ms=-1');
    if (mode() === 'sapui5' && window.sap) { ${APP} }
  };
  addEventListener('load', () => setTimeout(enter, 0)); addEventListener('hashchange', enter);
</script></head><body>launchpad</body></html>`;

const seen = { preloads: 0, cores: 0 };
const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/res/')) {
        let ms = +new URL(req.url, 'http://x').searchParams.get('ms');
        if (/Component-preload/.test(req.url)) seen.preloads++;
        if (/sap-ui-core/.test(req.url) && seen.cores++) ms = 65000;   // lento a partir del segundo arranque
        if (ms < 0) return;   // no llega nunca
        return setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(200, { 'content-type': 'application/javascript' });
            res.end(/sap-ui-core/.test(req.url) ? SAP + APP : APP);
        }, ms);
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

const MISSING = { technology: 'UI5', action: 'click', wdi5_selector: { controlType: 'sap.m.Button', id: 'noExiste', properties: { text: 'Save' } } };
const intent = (mode, seq, code) => ({ intent_id: 'CREATE_PAGE_SECTIONS-0001', intent_seq: seq, APP_LINK: `${origin}/sap/bc/ui2/flp#FLPPage-${mode}`, code });
const run = async (mode, code = [], extra = {}, twice = false) => {
    captured = ''; seen.preloads = 0; seen.cores = 0;
    const t = Date.now();
    capture(true);
    try {
        const r = await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: twice ? [intent(mode, 1, code), intent(mode, 2, code)] : [intent(mode, 1, code)] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true, ...extra });
        return { r, secs: (Date.now() - t) / 1000 };
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== lento: Component-preload tarda 45 s ==');
let { r, secs } = await run('lento');
ok(r.success === true, 'el intent termina bien', r.failure?.message?.slice(0, 160));
ok(/La app aún no aparece, pero sigue llegando \(carga: .*Component-preload\.js/.test(captured), 'el log dice que la app sigue llegando y qué falta');
ok(seen.preloads === 1 && !/no arrancó/.test(captured), 'sin recargar', seen.preloads);
ok(secs >= 45, 'espera a la app', `${secs.toFixed(1)} s`);

console.log('\n== sapui5: re-entrada a la misma app (recarga limpia) y sap-ui-core.js tarda 65 s ==');
({ r, secs } = await run('sapui5', [], {}, true));
ok(seen.cores === 2 && /re-entrada a la misma app/.test(captured), 'la segunda entrada recarga y vuelve a bajar sap-ui-core', seen.cores);
ok(r.success === true && r.intentsCompleted === 2, 'los dos intents terminan bien (antes: page.goto: Timeout 30000ms)', r.failure?.message?.slice(0, 160));
ok(/La página no terminó de cargar en 30 s, pero sigue llegando/.test(captured) && /SAPUI5 aún no arranca, pero sigue llegando/.test(captured),
   'el log dice que sigue llegando (navegación y SAPUI5)', `${secs.toFixed(1)} s`);

console.log('\n== atascado: Component-preload no llega nunca (techo 15 s) ==');
({ r, secs } = await run('atascado', [MISSING], { bootCeilingMs: 15000 }));
ok(/💥 La app no arrancó \(la app no terminó de llegar en 15 s \(carga: .*Component-preload\.js/.test(captured), 'al techo: «no arrancó», con el estado de carga');
ok(seen.preloads === 2, 'una única recarga limpia', seen.preloads);
ok(/La app tampoco arrancó tras recargar/.test(captured), 'y avisa si tras recargar sigue igual');
ok(r.success === false && /Timeout.* · carga: readyState=complete, 1 fichero\(s\) de arranque pendiente\(s\), el más antiguo ShellBar\/Component-preload\.js \(\d+ s\)/.test(r.failure?.message || ''),
   'el paso falla con el estado de carga en el mensaje', r.failure?.message?.slice(-140));
ok(/DIAG timeout: .* · carga: readyState=/.test(captured), 'y en el DIAG');

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
