/* ===========================================================================
   Harness for the bot's progress-event normalization (src/progress.js).

   `normalizeEvent` turns a raw fiori.js onProgress event into exactly the shape
   MIMO's reportProgress action accepts. OData V4 is strict, so the critical
   invariants are: the polymorphic context fields (`block`, `instance`, …) go out
   as STRINGS, the counters as INTEGERS, `percent` is forwarded, and no stray
   fields ride along — otherwise a single event 400s the whole batch.

   Run:  node test/progress-normalize.test.js       (exit 0 = pass, 1 = fail)
   No dependencies.
   =========================================================================== */
'use strict';
const { normalizeEvent } = require('../src/progress');

let failures = 0;
function ok(name, cond, extra) {
	console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '   (' + extra + ')' : ''));
	if (!cond) { failures++; }
}
const isStr = (v) => typeof v === 'string';
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

const EXPECTED_KEYS = ['seq', 'at', 'level', 'done', 'total', 'percent', 'block',
	'instruction', 'instance', 'intent', 'step_no', 'action', 'message'];

// --- a typical STEP event -----------------------------------------------------
console.log('\n== Typical STEP event ==');
const step = normalizeEvent({
	level: 'STEP', done: 4, total: 13, percent: 33,
	block: 'BUSINESS_CATALOG',            // string id — would 400 if kept numeric-typed
	instruction: 'assign', intent: 'AssignRoleToUser',
	instance: 2,                          // number in → must go out as string
	step_no: 1, action: 'click',
	message: '[Step 1/3] WEBGUI CLICK · sid',
	stray: 'DROP ME'                      // stray field must NOT survive
}, 7, '2026-09-01T12:00:07Z');

ok('block is a String (not the numeric type OData would reject)', isStr(step.block), JSON.stringify(step.block));
ok('instance number → String', isStr(step.instance) && step.instance === '2', JSON.stringify(step.instance));
ok('intent / instruction are Strings', isStr(step.intent) && isStr(step.instruction));
ok('done / total / step_no are Integers', isInt(step.done) && isInt(step.total) && isInt(step.step_no));
ok('percent forwarded as Integer', step.percent === 33);
ok('seq / at passed through', step.seq === 7 && step.at === '2026-09-01T12:00:07Z');
ok('no stray fields', Object.keys(step).every((k) => EXPECTED_KEYS.includes(k)) && !('stray' in step));

// --- polymorphic instance (UUID) ---------------------------------------------
console.log('== Polymorphic instance (UUID) ==');
const uuidEv = normalizeEvent({ level: 'MILESTONE', instance: 'f9e664a2-6da4-4ed7-8fbd-4268c5e76eea', message: 'x' }, 1, 'T');
ok('UUID instance stays a String', isStr(uuidEv.instance) && uuidEv.instance.length === 36);

// --- off-instance event (no instance / percent) ------------------------------
console.log('== Off-instance event ==');
const off = normalizeEvent({ level: 'INFO', done: 0, total: 13, message: 'Starting…' }, 1, 'T');
ok('missing instance → undefined (omitted on the wire)', off.instance === undefined);
ok('missing percent → undefined (omitted on the wire)', off.percent === undefined);
ok('JSON round-trip drops undefined fields', (() => {
	const wire = JSON.parse(JSON.stringify(off));
	return !('instance' in wire) && !('percent' in wire);
})());

// --- defaults & bounds --------------------------------------------------------
console.log('== Defaults & bounds ==');
ok('missing level defaults to INFO', normalizeEvent({}, 1, 'T').level === 'INFO');
ok('message truncated to 1000 chars', normalizeEvent({ message: 'x'.repeat(5000) }, 1, 'T').message.length === 1000);
ok('block truncated to 100 chars', normalizeEvent({ block: 'y'.repeat(500) }, 1, 'T').block.length === 100);
ok('empty raw event never throws', (() => { try { normalizeEvent(null, 1, 'T'); return true; } catch (e) { return false; } })());

console.log('\n' + (failures ? '✗ ' + failures + ' assertion(s) FAILED' : '✓ all assertions passed'));
process.exit(failures ? 1 : 0);
