// ============================================================
// Correcciones del contrato, C1 — un item de un grupo de aggregated_intents sólo cuenta como
// completo si el grupo SE GUARDÓ (finalize y settleWrites del grupo terminan bien).
//
// Prueba runAggregatedGroup (src/rpa/fiori.js) con pasos simulados: el orden (setup → items →
// SIEMPRE finalize salvo si falla el setup), qué items vuelven como completos, el error que se
// propaga y la fase del grupo (group_stage) en la que estaba al fallar.
//
// Run:  node test/aggregated-group.test.js       (exit 0 = pass, 1 = fail)
// ============================================================
import { __internals as H } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const ITEMS = [{ instance_iid: 'i1' }, { instance_iid: 'i2' }, { instance_iid: 'i3' }];

// Un grupo simulado: `fail` dice qué falla ('setup', el iid de un item, 'finalize').
async function group(fail) {
    const calls = [];
    let stage = null;
    let thrown = null, out = null;
    try {
        out = await H.runAggregatedGroup(ITEMS, {
            stage: (s) => { stage = s; },
            setup: async () => { calls.push('setup'); if (fail === 'setup') throw new Error('setup'); },
            item: async (item) => { calls.push(item.instance_iid); if (fail === item.instance_iid) throw new Error(item.instance_iid); },
            finalize: async () => { calls.push('finalize'); if (fail === 'finalize' || fail === 'both') throw new Error('finalize'); },
        });
    } catch (e) { thrown = e; }
    // Lo que se informaría como completo: los items terminados, sólo si el grupo se guardó.
    const completed = out && out.saved ? out.done.map((d) => d.item.instance_iid) : [];
    return { calls, stage, thrown, out, completed };
}

console.log('== grupo que termina bien ==');
let g = await group(null);
ok(g.completed.join() === 'i1,i2,i3', 'los 3 completos, igual que antes', g.completed.join());
ok(g.calls.join() === 'setup,i1,i2,i3,finalize', 'orden setup → items → finalize', g.calls.join());
ok(g.out.error === null, 'sin error');

console.log('\n== falla el finalize ==');
g = await group('finalize');
ok(g.completed.length === 0, 'ninguno de los 3 completo (antes: los 3)', g.completed.join() || '—');
ok(g.out.done.length === 3, 'los 3 terminaron sus pasos (para el WARN de la consola)');
ok(g.out.error?.message === 'finalize' && g.stage === 'FINALIZE', 'propaga el error del finalize, group_stage = FINALIZE', g.stage);

console.log('\n== falla el item 2 y el finalize termina bien ==');
g = await group('i2');
ok(g.completed.join() === 'i1', 'sólo el item 1 completo', g.completed.join());
ok(g.calls.join() === 'setup,i1,i2,finalize', 'el bucle para en el 2 y el finalize corre igual', g.calls.join());
ok(g.out.error?.message === 'i2' && g.stage === 'ITEM', 'propaga el error del item, group_stage = ITEM', g.stage);

console.log('\n== falla el item 2 y también el finalize ==');
let calls = [], stage = null;
const out = await H.runAggregatedGroup(ITEMS, {
    stage: (s) => { stage = s; },
    setup: async () => {},
    item: async (item) => { calls.push(item.instance_iid); if (item.instance_iid === 'i2') throw new Error('i2'); },
    finalize: async () => { throw new Error('finalize'); },
});
ok(!out.saved && out.done.length === 1, 'ninguno completo (el 1 terminó, pero no se guardó)');
ok(out.error?.message === 'i2' && stage === 'ITEM', 'el error que se informa sigue siendo el del item', stage);

console.log('\n== falla el setup ==');
g = await group('setup');
ok(g.thrown?.message === 'setup' && g.stage === 'SETUP', 'lanza, group_stage = SETUP', g.stage);
ok(g.calls.join() === 'setup', 'ni items ni finalize', g.calls.join());

console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
