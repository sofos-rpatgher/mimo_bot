// ============================================================
// C3 (contrato MIMO fase 0) — el veredicto del login, sin navegador.
//
// Cubre la lógica pura de src/rpa/logon.js: decodificar `data-sap-login`, clasificar los mensajes
// de SAP y decidir a partir de lo que se ve en la página. La forma del `data-sap-login` es la medida
// en las trazas reales (DS4 y SofOS): base64 de un JSON URL-encoded, con `messages: []` mientras la
// página pide el login. El formato de un mensaje de rechazo real NO se ha visto todavía: se prueban
// cadenas y objetos. Cuando haya un rechazo real, su HTML va aquí como fixture.
//
// Run:  node test/logon.test.js       (exit 0 = pass, 1 = fail)
// ============================================================
import {
    LOGON_CODES as C, decodeSapLoginData, logonMessageTexts, classifyLogonMessages,
    judgeLogonSnapshot, describeLogonFailure, waitForLogonOutcome,
} from '../src/rpa/logon.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

// Codifica como lo hace el ICF: JSON → URL-encoded → base64.
const encode = (obj) => Buffer.from(encodeURIComponent(JSON.stringify(obj)), 'latin1').toString('base64');
const page = (messages) => encode({
    login_params: { 'sap-client': '100' }, languages: { EN: 'English', ES: 'Espa%c3%b1ol' },
    texts: { USER: 'User', PASSWORD: 'Password' }, properties: { lang: 'EN' }, messages,
});
const snap = (over) => ({ ready: false, sapLogin: page([]), passwordFields: 1, ...over });

console.log('== decodificar data-sap-login ==');
const d = decodeSapLoginData(page([]));
ok(d && Array.isArray(d.messages) && d.messages.length === 0, 'la forma real decodifica, con messages vacío');
ok(decodeSapLoginData(null) === null && decodeSapLoginData('%%%no-base64') === null, 'ausente o basura → null, sin lanzar');
ok(logonMessageTexts(decodeSapLoginData(page(['Name\\x20or\\x20password\\x20is\\x20incorrect']))) [0] === 'Name or password is incorrect',
   'los escapes \\x20 de SAP se deshacen');
ok(logonMessageTexts({ messages: [{ text: 'User is locked' }, { message: 'otro' }, '  ', null] }).join('|') === 'User is locked|otro|null',
   'acepta cadenas y objetos; descarta los vacíos');

console.log('\n== clasificar ==');
const cls = (t) => classifyLogonMessages([t]);
ok(cls('Name or password is incorrect (repeat logon)') === C.INVALID_CREDENTIALS, '«Name or password is incorrect» → INVALID_CREDENTIALS');
ok(cls('User FOO does not exist') === C.INVALID_CREDENTIALS, 'usuario inexistente → INVALID_CREDENTIALS');
ok(cls('El nombre o la clave de acceso no es correcto (repetir el logon)') === C.INVALID_CREDENTIALS, 'en español → INVALID_CREDENTIALS');
ok(cls('User is locked. Please notify the person responsible') === C.USER_LOCKED, '«User is locked» → USER_LOCKED');
ok(cls('Password logon no longer possible - too many failed attempts') === C.USER_LOCKED,
   '«too many failed attempts» → USER_LOCKED (aunque diga «password»)');
ok(cls('Usuario bloqueado') === C.USER_LOCKED, 'en español → USER_LOCKED');
ok(cls('Your password has expired. Choose a new password') === C.PASSWORD_CHANGE_REQUIRED, 'contraseña caducada → PASSWORD_CHANGE_REQUIRED');
ok(cls('Client 999 is not available in this system') === C.LOGIN_REJECTED, 'motivo que no encaja → LOGIN_REJECTED');

console.log('\n== decidir a partir de la página ==');
ok(judgeLogonSnapshot(snap({})) === null, 'la página real de antes del envío (messages: []) → sin veredicto, se sigue esperando');
ok(judgeLogonSnapshot(snap({ sapLogin: null, passwordFields: 0 })) === null, 'navegando (sin body) → sin veredicto');
ok(judgeLogonSnapshot(snap({ ready: true }))?.ok === true, 'SAPUI5 listo → ok');
const bad = judgeLogonSnapshot(snap({ sapLogin: page(['Name or password is incorrect (repeat logon)']) }));
ok(bad?.ok === false && bad.code === C.INVALID_CREDENTIALS && bad.messages.length === 1, 'messages con rechazo → INVALID_CREDENTIALS con el texto de SAP');
ok(judgeLogonSnapshot(snap({ passwordFields: 3 }))?.code === C.PASSWORD_CHANGE_REQUIRED, 'dos o más campos de contraseña → PASSWORD_CHANGE_REQUIRED');

console.log('\n== el mensaje del job ==');
const PASS = 'S3cr3t-Pa55w0rd!';
const msg = describeLogonFailure(bad, 'BOT_USER');
ok(!msg.includes(PASS) && msg.includes('BOT_USER') && msg.includes('[INVALID_CREDENTIALS]') && msg.includes('Name or password is incorrect'),
   'lleva código, usuario y texto de SAP; nunca la contraseña', msg);

console.log('\n== esperar el veredicto (página simulada) ==');
// Una página que va mostrando una secuencia de estados; el primero lanza como una navegación.
const fakePage = (states) => {
    let i = 0;
    return {
        evaluate: async () => { const s = states[Math.min(i++, states.length - 1)]; if (s instanceof Error) throw s; return s; },
        waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
};
const nav = new Error('Execution context was destroyed');
let t = Date.now();
let r = await waitForLogonOutcome(fakePage([nav, snap({}), snap({}), snap({ sapLogin: page(['User is locked']) })]), { timeout: 5000, interval: 10 });
ok(r.code === C.USER_LOCKED && Date.now() - t < 1000, 'un rechazo se resuelve en cuanto aparece, sin esperar el plazo', `${Date.now() - t} ms`);
r = await waitForLogonOutcome(fakePage([nav, snap({}), snap({ ready: true })]), { timeout: 5000, interval: 10 });
ok(r.ok === true, 'launchpad vivo → ok');
r = await waitForLogonOutcome(fakePage([snap({ sapLogin: null, passwordFields: 1 })]), { timeout: 100, interval: 10 });
ok(r.code === C.LOGIN_REJECTED, 'plazo vencido con el formulario en pantalla (logon NetWeaver) → LOGIN_REJECTED');
r = await waitForLogonOutcome(fakePage([snap({ sapLogin: null, passwordFields: 0 })]), { timeout: 100, interval: 10 });
ok(r.code === C.LAUNCHPAD_TIMEOUT, 'plazo vencido sin formulario → LAUNCHPAD_TIMEOUT (no es culpa del usuario)');

console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
