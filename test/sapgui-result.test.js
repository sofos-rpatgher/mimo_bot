/* ===========================================================================
   Correcciones del contrato, C2 — el resultado de un job de SAP GUI.

   runSapgui devolvía la cadena logs_url y el worker leía `.success` sobre ella: todo job de SAP GUI
   acababa FAILED con «Unknown error» y su logs_url no llegaba a MIMO. Ahora devuelve
   { success, failure?, logs_url, completedInstanceIids, resultReported }, como runFiori.

   Se simula el servicio C# sustituyendo `fetch`: no hace falta el servicio ni su puerto.
   Necesita config.json (sapgui.js lee csharp_port de él).

   Run:  node test/sapgui-result.test.js       (exit 0 = pass, 1 = fail)
   =========================================================================== */
'use strict';
const runSapgui = require('../src/rpa/sapgui');

let failures = 0;
function ok(name, cond, extra) {
	console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '   (' + extra + ')' : ''));
	if (!cond) { failures++; }
}

const answer = (status, body) => { global.fetch = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); };
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const run = () => quiet(() => runSapgui('J1', { steps: [] }, 'B1'));

(async () => {
	console.log('\n== 2xx ==');
	answer(200, { success: true, logs_url: 'http://bot/logs/J1' });
	let r = await run();
	ok('success: true → completado, con su logs_url', r.success === true && r.logs_url === 'http://bot/logs/J1' && r.resultReported === true);

	answer(200, { logs_url: 'http://bot/logs/J1' });
	r = await run();
	ok('sin indicación → completado, marcado resultReported: false', r.success === true && r.resultReported === false && r.logs_url === 'http://bot/logs/J1');

	answer(200, { success: false, error: 'Transaction SU01 not found', logs_url: 'http://bot/logs/J1' });
	r = await run();
	ok('success: false + error → fallido con el mensaje del servicio y su logs_url',
		r.success === false && r.failure.message === 'Transaction SU01 not found' && r.failure.phase === 'sapgui' && r.logs_url === 'http://bot/logs/J1', r.failure && r.failure.message);

	answer(200, { status: 'ERROR', message: 'Popup inesperado' });
	r = await run();
	ok('status ERROR → fallido', r.success === false && r.failure.message === 'Popup inesperado');

	answer(200, { error: { message: 'Objeto bloqueado' } });
	r = await run();
	ok('error como objeto → fallido con su message', r.success === false && r.failure.message === 'Objeto bloqueado');

	answer(200, { success: true, completedInstanceIids: ['a', 'b'] });
	r = await run();
	ok('completedInstanceIids del servicio se conservan', r.completedInstanceIids.join() === 'a,b');
	answer(200, { success: true });
	r = await run();
	ok('sin completedInstanceIids → vacío (MIMO: COMPLETED = todas)', Array.isArray(r.completedInstanceIids) && r.completedInstanceIids.length === 0);

	answer(200, '');
	r = await run();
	ok('2xx sin cuerpo JSON → completado sin indicación', r.success === true && r.resultReported === false && r.logs_url === '');

	console.log('\n== no 2xx ==');
	answer(500, 'NullReferenceException at Runner.Run');
	let thrown = null;
	try { await run(); } catch (e) { thrown = e; }
	ok('HTTP 500 → lanza con el mensaje del servicio (el worker lo informa FAILED)',
		thrown && /HTTP 500: NullReferenceException/.test(thrown.message), thrown && thrown.message);

	console.log(failures ? `\n✗ ${failures} fallo(s)` : '\n✓ all assertions passed');
	process.exit(failures ? 1 : 0);
})();
