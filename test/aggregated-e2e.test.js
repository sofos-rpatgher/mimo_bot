// ============================================================
// Correcciones del contrato, C1 — runFiori de punta a punta con un grupo de aggregated_intents.
//
// aggregated-group.test.js prueba la regla; esto prueba que runFiori la aplica: lo que llega a
// result.completedInstanceIids, result.failure.group_stage / group_key y los eventos de la consola
// (MILESTONE por item sólo tras guardar; WARN por item si el grupo no se guardó).
//
// Un logon de SAP de mentira (como logon-e2e.test.js) y un grupo con 2 items sin pasos. El finalize
// que falla es un paso UI5 sobre un control que no existe: tarda los 30 s de la espera de render.
//
// No entra en `npm test` (necesita navegador): se corre con `npm run test:rpa`.
// ============================================================
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.method === 'POST') {
        req.resume();
        req.on('end', () => { res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' }); res.end(); });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(/S=ok/.test(req.headers.cookie || '')
        ? '<!doctype html><html><body><script>window.sap = { ui: { getCore() { return { byId() { return null; } }; } } };</script>launchpad</body></html>'
        : `<!doctype html><html><body data-sap-login="${sapLogin}"><form method="post" action="/sap/bc/ui2/flp">
             <label for="u">User</label><input id="u" name="sap-user"><label for="p">Password</label><input id="p" type="password" name="sap-password">
             <button type="submit">Log On</button></form></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-agg-'));
process.chdir(tmp);

const MISSING = { technology: 'UI5', action: 'click', wdi5_selector: { controlType: 'sap.m.Button', id: 'noExiste', properties: { text: 'Save' } } };
const script = (finalize) => ({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{
    instruction_id: 'I', instruction_seq: 1, instances: [],
    aggregated_intents: [{ intent_id: 'ADD_TILE', intent_seq: 1, group_key: 'CAT_X', APP_LINK: `${origin}/sap/bc/ui2/flp`,
        setup: [], items: [{ instance_iid: 'i1', code: [] }, { instance_iid: 'i2', code: [] }], finalize }],
}] }] });
const run = async (finalize) => {
    const events = [];
    const r = await runFiori(script(finalize), { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true,
                                                 onProgress: (e) => events.push(e) });
    return { r, events };
};

console.log('== el grupo se guarda ==');
let { r, events } = await run([]);
ok(r.success === true && r.completedInstanceIids.join() === 'i1,i2', 'los 2 items completos', r.completedInstanceIids.join());
ok(r.intentsCompleted === 2, 'intentsCompleted = 2', r.intentsCompleted);
ok(events.filter((e) => e.level === 'MILESTONE' && e.percent === 100).length === 2, 'un hito del 100 % por item');

console.log('\n== falla el finalize ==');
({ r, events } = await run([MISSING]));
ok(r.success === false && r.completedInstanceIids.length === 0, 'ningún item completo (antes: los 2)', r.completedInstanceIids.join() || '—');
ok(r.intentsCompleted === 0, 'intentsCompleted = 0', r.intentsCompleted);
ok(r.failure?.group_stage === 'FINALIZE' && r.failure?.group_key === 'CAT_X', 'failure: group_stage FINALIZE y group_key', `${r.failure?.group_stage} ${r.failure?.group_key}`);
ok(events.filter((e) => e.level === 'MILESTONE' && e.percent === 100).length === 0, 'ningún item al 100 % en la consola');
const warns = events.filter((e) => e.level === 'WARN' && /NOT saved/.test(e.message));
ok(warns.length === 2 && warns.every((e) => e.instance === 1 || e.instance === 2), 'un WARN por item no guardado, en su línea', warns.map((e) => e.instance).join());
ok(events.some((e) => e.level === 'ERROR'), 'y el ERROR del fallo');

srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
