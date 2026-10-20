/* ===========================================================================
   C1 y C2 (contrato MIMO fase 2) — lo que tiene que traer un job antes de abrir el navegador.

   - Job Fiori sin cualquiera de sap_system, server_origin, sap_client, sap_user, sap_password
     → rechazado (`job-check`, `rejected: true`); sap_system vacío se rechaza en cualquier job.
   - Sistema que este host no alcanza (`sap_systems`) → rechazado (`system-check`, `rejected: true`).
   - El `sap_system` de las fases 0/1 vale como lista de uno.
   - Ningún rechazo lleva la contraseña.

   Run:  node test/job-check.test.js       (exit 0 = pass, 1 = fail)
   No dependencies.
   =========================================================================== */
'use strict';
const { checkJobFields, checkJobSystem, reachableSystems, pinnedKeysFor, normOrigin } = require('../src/job-check');

let failures = 0;
function ok(name, cond, extra) {
	console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '   (' + extra + ')' : ''));
	if (!cond) { failures++; }
}

const PASS = 'Pr0ba-S3cr3ta!';
const job = (over) => ({ job_iid: 'J', rpa_type: 'fiori', sap_system: 'GRUPOMAR_DS4',
	server_origin: 'https://vhdqwws1wd01.sap.grupomar.local:44380', sap_client: '100',
	sap_user: 'RPA_BOT', sap_password: PASS, ...over });
const noPass = (f) => !JSON.stringify(f).includes(PASS);

console.log('\n== C1 · campos del job ==');
ok('job Fiori completo → pasa', checkJobFields(job()) === null);
for (const f of ['sap_system', 'server_origin', 'sap_client', 'sap_user', 'sap_password']) {
	for (const empty of ['', undefined, '   ']) {
		const r = checkJobFields(job({ [f]: empty }));
		if (!(r && r.phase === 'job-check' && r.rejected === true && r.message.includes(f) && noPass(r))) {
			ok(`sin ${f} (${JSON.stringify(empty)}) → job-check rechazado`, false, JSON.stringify(r));
		}
	}
	ok(`sin ${f} → job-check, rejected: true, nombra el campo`, true);
}
let r = checkJobFields(job({ sap_user: '', sap_password: '' }));
ok('varios campos ausentes se nombran todos', r && r.message.includes('sap_user, sap_password'), r && r.message);
r = checkJobFields(job({ server_origin: 'vhdqwws1wd01:44380' }));
ok('server_origin sin protocolo → job-check', r && r.phase === 'job-check' && r.rejected === true, r && r.message);
ok('job SAP GUI sin usuario ni contraseña → pasa', checkJobFields({ rpa_type: 'sapgui', sap_system: 'GRUPOMAR_DS4', sap_user: '', sap_password: '' }) === null);
r = checkJobFields({ rpa_type: 'sapgui', sap_system: '' });
ok('job SAP GUI sin sap_system → job-check (antes sólo avisaba)', r && r.phase === 'job-check', r && r.message);

console.log('\n== fase 2b · login-check ==');
const lc = (over) => job({ rpa_type: 'login-check', script: '', batch_iid: null, ...over });
ok('login-check completo → pasa', checkJobFields(lc()) === null);
r = checkJobFields(lc({ sap_password: '' }));
ok('login-check sin sap_password → job-check, rejected: true', r && r.phase === 'job-check' && r.rejected === true && r.message.includes('sap_password'), r && r.message);
r = checkJobFields(lc({ server_origin: '' }));
ok('login-check sin server_origin → job-check', r && r.phase === 'job-check' && r.message.includes('server_origin'), r && r.message);
r = checkJobSystem(lc({ sap_system: 'OTRO' }), { sap_systems: ['GRUPOMAR_DS4'] });
ok('login-check de un sistema que el host no alcanza → system-check', r && r.phase === 'system-check' && r.rejected === true);

console.log('\n== C2 · sistemas que alcanza el host ==');
ok('sap_systems', reachableSystems({ sap_systems: ['grupomar_ds4', ' SOFOS_DEMO '] }).join() === 'GRUPOMAR_DS4,SOFOS_DEMO');
ok('sap_system antiguo → lista de uno', reachableSystems({ sap_system: 'SOFOS_DEMO' }).join() === 'SOFOS_DEMO');
ok('sap_systems gana a sap_system', reachableSystems({ sap_systems: ['A'], sap_system: 'B' }).join() === 'A');
ok('sistema en la lista → pasa', checkJobSystem(job(), { sap_systems: ['SOFOS_DEMO', 'GRUPOMAR_DS4'] }) === null);
ok('sin distinguir mayúsculas', checkJobSystem(job({ sap_system: 'grupomar_ds4' }), { sap_systems: ['GRUPOMAR_DS4'] }) === null);
ok('config antiguo con sap_system → pasa', checkJobSystem(job(), { sap_system: 'GRUPOMAR_DS4' }) === null);
r = checkJobSystem(job(), { sap_systems: ['SOFOS_DEMO'] });
ok('sistema fuera de la lista → system-check, rejected: true', r && r.phase === 'system-check' && r.rejected === true && noPass(r), r && r.message);
r = checkJobSystem(job(), {});
ok('config sin sistemas → system-check', r && r.phase === 'system-check' && r.message.includes('sap_systems'), r && r.message);

console.log('\n== C3 · huellas TLS por sistema ==');
const pins = { tlsPinnedKeys: { SOFOS_DEMO: ['M/DmJg+LDFCAwmIGT5hiJ86CvgwOOe0miBHQF7G4SyY='], OTRO: 'xyz=' } };
ok('las del sistema del job', pinnedKeysFor(job({ sap_system: 'sofos_demo' }), pins).join() === 'M/DmJg+LDFCAwmIGT5hiJ86CvgwOOe0miBHQF7G4SyY=');
ok('una sola como texto también vale', pinnedKeysFor(job({ sap_system: 'OTRO' }), pins).join() === 'xyz=');
ok('las de otro sistema no se pasan', pinnedKeysFor(job(), pins).length === 0);
ok('sin tlsPinnedKeys → ninguna', pinnedKeysFor(job(), {}).length === 0);

console.log('\n== normalización del destino ==');
ok('barra final, mayúsculas y puerto 443 explícito', normOrigin('HTTPS://Host.Example:443/') === 'https://host.example');

console.log(failures ? `\n✗ ${failures} fallo(s)` : '\n✓ all assertions passed');
process.exit(failures ? 1 : 0);
