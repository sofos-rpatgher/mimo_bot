// ============================================================
// Cubre los tres fallos que han llegado desde producción sobre `src/rpa/fiori.js`:
//
//   - resolución del marco de la app por URL (el id `application-*` no existe en FLP 1.136.0)
//   - B6: esperar a que la pantalla WEBGUI se asiente antes de actuar
//   - B4: tolerar el `&` ausente en los códigos de función de este sistema SAP
//
// Levanta un servidor local que imita la forma medida del launchpad de Grupo Mar y conduce un
// Chromium real: estos ayudantes sólo tienen sentido contra un navegador de verdad.
//
// No entra en `npm test` (necesita navegador): se corre con `npm run test:rpa`.
// ============================================================
import http from 'http';
import { chromium } from '@playwright/test';
import { __internals as H } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

// SID real de la corrida 24f5c7cb, con el `&` que este sistema no usa.
const TBAR = 'wnd[0]/usr/tabsMAIN_TAB/tabpMAIN_TAB_CAT/ssubMAIN_TAB_SCA:/UI2/FLP_CONT_MGR:2100'
           + '/cntlCONTAINER_CAT_TAB/shellcont/shell/shellcont[1]/shell/shellcont[0]/shell/tbar/';

console.log('== B4 · variantes de SID ==');
ok(H.sidWithoutAmp(TBAR + 'dbtn&ADD_TTMS') === TBAR + 'dbtnADD_TTMS', 'dbtn&ADD_TTMS → dbtnADD_TTMS');
ok(H.sidWithoutAmp(TBAR + 'btn&ADD_TILES') === TBAR + 'btnADD_TILES', 'btn&ADD_TILES → btnADD_TILES');
ok(H.sidWithoutAmp(TBAR + 'dbtnADD_TTMS') === null, 'SID sin & → null (no se duplica candidata)');
ok(H.sidWithoutAmp('wnd[0]/usr/txtGV_CATALOG_TITLE') === null, 'campo de texto → null');
ok(H.sidWithoutAmp('wnd[0]/usr/ctxtSOMETHING&X') === null, 'un & fuera de btn/dbtn NO se toca');
const vs = H.sidVariants(TBAR + 'dbtn&ADD_TTMS');
ok(vs.length === 2 && vs[0].tolerant === false && vs[1].tolerant === true, 'la exacta va primera; la tolerante va marcada');
ok(H.sidVariants('wnd[0]/usr/txtX').length === 1, 'sin & → una sola candidata');

// ── Launchpad de mentira con la forma medida en Grupo Mar ───────────────────
// El iframe lleva el id generado por UI5 y el nombre semántico en data-help-id, como FLP 1.136.0.
const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/sap/bc/gui/sap/its/webgui')) {
        res.end(`<html><head><style>.lsBlockLayer{position:fixed;inset:0;background:rgba(0,0,0,.2)}</style></head><body>
            <div ct="B" lsdata='{"27":{"SID":"${TBAR}dbtnADD_TTMS","Type":"GuiDropDownButton"}}'>Add TTMs</div>
            <div class="lsBlockLayer" style="display:none"></div>
            <script>
              // Imita la ida y vuelta al servidor de un campo "14":"SERVER": el overlay aparece
              // delay ms DESPUÉS de que el paso siguiente ya empezó, y dura dur.
              window.roundTrip = (delay, dur) => setTimeout(() => {
                  const l = document.querySelector('.lsBlockLayer');
                  l.style.display = 'block';
                  setTimeout(() => { l.style.display = 'none'; }, dur);
              }, delay);
            </script></body></html>`);
    } else {
        res.end(`<html><body><iframe id="__container1-iframe" name="__container1-iframe" title="Application"
            data-help-id="application-FLPBusinessCatalog-manageClientSpecific-iframe"
            src="/sap/bc/gui/sap/its/webgui;~sysid=DS4;~service=3200" width="700" height="400"></iframe></body></html>`);
    }
});
await new Promise(r => srv.listen(0, r));

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${srv.address().port}`);
await page.waitForTimeout(400);

console.log('== Marco de la aplicación ==');
ok(await page.locator('iframe[id^="application-"]').count() === 0, 'el selector viejo no casa con este launchpad');
const frame = await H.appFrame(page);
ok(!!frame && /\/sap\/bc\/gui\/sap\/its\/webgui/.test(frame.url()), 'appFrame lo resuelve por la URL del documento');
try {
    frame.locator('#a').or(page.locator('#b'));
    ok(false, '.or() entre marco y página debería lanzar');
} catch (e) {
    ok(/same frame/.test(e.message), '.or() no cruza marcos → por eso existe firstVisible');
}

console.log('== B6 · estabilización ==');
ok(await H.settleWebgui(frame, page) === true, 'pantalla ya quieta → true');

// El caso exacto de la corrida 982b1bac: el viaje al servidor del paso ANTERIOR aterriza cuando el
// paso siguiente ya está mirando. Una sola lectura del overlay habría pasado en verde aquí.
await frame.evaluate(() => window.roundTrip(500, 1500));
const t0 = Date.now();
const settled = await H.settleWebgui(frame, page);
const waited = Date.now() - t0;
ok(settled === true, 'overlay que llega tarde → se espera y devuelve true');
ok(waited > 1900, `esperó a que se fuera (${waited} ms): la histéresis cierra la carrera`);

await frame.evaluate(() => { document.querySelector('.lsBlockLayer').style.display = 'block'; });
ok(await H.settleWebgui(frame, page) === false, 'overlay que no se va → false, sin lanzar (best-effort)');
await frame.evaluate(() => { document.querySelector('.lsBlockLayer').style.display = 'none'; });

console.log('== B4 · carrera de candidatas ==');
const candidatas = (sid) => {
    const out = [];
    for (const scope of [frame, page]) {
        for (const v of H.sidVariants(sid)) {
            out.push({ label: `${scope === page ? 'página' : 'marco'} · ${v.label}`,
                       tolerant: v.tolerant, locator: H.sidLocator(scope, page, v.sid).first() });
        }
    }
    return out;
};
const cands = candidatas(TBAR + 'dbtn&ADD_TTMS');
ok(cands.length === 4, '2 ámbitos × 2 variantes = 4 candidatas');
const won = await H.firstVisible(cands, 5000);
ok(won.tolerant === true, 'gana la variante sin & — es la que existe en DS4');
ok((await won.locator.innerText()).trim() === 'Add TTMs', 'la ganadora apunta al control real');

const exacta = await H.firstVisible(candidatas(TBAR + 'dbtnADD_TTMS'), 5000);
ok(exacta.tolerant === false, 'cuando el SID coincide gana la exacta, sin ruido en el log');

try {
    await H.firstVisible(candidatas(TBAR + 'btn&NO_EXISTE'), 800);
    ok(false, 'sin coincidencias debería lanzar');
} catch (e) {
    ok(/Timeout 800ms exceeded/.test(e.message), 'se propaga el timeout original con su selector');
}

await browser.close();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
