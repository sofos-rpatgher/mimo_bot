/* ===========================================================================
   C1 (contrato MIMO fase 1) — el destino que trae el job tiene que ser el del config.json.

   Si difiere, el job se rechaza (no sólo se avisa): las credenciales del bot salen del config y
   no deben mandarse a otro host. Ver src/job-target.js.

   Run:  node test/job-target.test.js       (exit 0 = pass, 1 = fail)
   No dependencies.
   =========================================================================== */
'use strict';
const { checkJobTarget, normOrigin, normClient } = require('../src/job-target');

let failures = 0;
function ok(name, cond, extra) {
	console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '   (' + extra + ')' : ''));
	if (!cond) { failures++; }
}

// Valores reales de MIMO (tabla de C1 del contrato).
const DS4 = { serverOrigin: 'https://vhdqwws1wd01.sap.grupomar.local:44380', sapClient: 100 };
const job = (over) => ({ job_iid: 'J', sap_system: 'GRUPOMAR_DS4',
	server_origin: 'https://vhdqwws1wd01.sap.grupomar.local:44380', sap_client: '100', ...over });

console.log('\n== normalización ==');
ok('barra final, mayúsculas y puerto 443 explícito no son diferencias',
	normOrigin('HTTPS://Host.Example:443/') === normOrigin('https://host.example'));
ok('el puerto sí es diferencia', normOrigin('https://h:44380') !== normOrigin('https://h:44302'));
ok('sin protocolo («host:44380») → null', normOrigin('vhdqwws1wd01:44380') === null);
ok('texto suelto → null', normOrigin('no es una url') === null);
ok('cliente 100 (número) = "100" (texto)', normClient(100) === normClient('100'));

console.log('\n== se ejecuta ==');
ok('destino del job = config', checkJobTarget(job(), DS4) === null);
ok('mismo destino escrito distinto (barra final, mayúsculas)',
	checkJobTarget(job({ server_origin: 'https://VHDQWWS1WD01.sap.grupomar.local:44380/' }), DS4) === null);
ok('MIMO aún no tiene el destino (campos vacíos) → se usa el config', checkJobTarget(job({ server_origin: '', sap_client: '' }), DS4) === null);
ok('bot antiguo de MIMO sin los campos → se usa el config', checkJobTarget({ job_iid: 'J' }, DS4) === null);
ok('sólo el cliente informado y coincide', checkJobTarget(job({ server_origin: '' }), DS4) === null);

console.log('\n== se rechaza ==');
let r = checkJobTarget(job({ server_origin: 'https://web01.sofos.proatech.mx:44302' }), DS4);
ok('otro servidor', r && r.includes('servidor') && r.includes('web01.sofos.proatech.mx'), r);
r = checkJobTarget(job({ sap_client: '300' }), DS4);
ok('otro cliente', r && r.includes('client 300'), r);
r = checkJobTarget(job({ server_origin: 'https://vhdqwws1wd01.sap.grupomar.local:44302' }), DS4);
ok('mismo host, otro puerto', !!r, r);
r = checkJobTarget(job({ server_origin: 'http://vhdqwws1wd01.sap.grupomar.local:44380' }), DS4);
ok('mismo host, http en vez de https', !!r, r);
r = checkJobTarget(job({ server_origin: 'no es una url' }), DS4);
ok('server_origin que no es URL', r && r.includes('no es una URL'), r);
ok('el mensaje nunca lleva la contraseña del config',
	!String(checkJobTarget(job({ sap_client: '300' }), { ...DS4, password: 'S3cr3t!' })).includes('S3cr3t!'));

console.log(failures ? `\n✗ ${failures} fallo(s)` : '\n✓ all assertions passed');
process.exit(failures ? 1 : 0);
