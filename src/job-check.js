/* ===========================================================================
   Job check — lo que tiene que traer un job antes de abrir el navegador
   (contrato MIMO fase 2, C1 y C2).

   Desde la fase 2 el job describe por completo a qué SAP conectarse y con
   quién: sap_system, server_origin, sap_client, sap_user y sap_password. El
   config.json ya no tiene destino ni credenciales. Así que:

   · checkJobFields — un job Fiori o `login-check` (fase 2b) al que le falte
     cualquiera de los cinco campos se rechaza (`phase: 'job-check'`); y
     `sap_system` vacío, en cualquier job. Antes, sin sistema se avisaba y se seguía contra el config;
     ahora no hay config contra el que seguir.
   · checkJobSystem — el sistema del job tiene que estar en `sap_systems`, la
     lista de los que este host alcanza (`phase: 'system-check'`). MIMO ya sólo
     manda jobs de los sistemas asignados al bot; la lista es la última defensa
     por si MIMO se equivoca: una acción real en el SAP de otra empresa.
     Se acepta el `sap_system` de las fases 0 y 1 como lista de uno, para que un
     config sin actualizar no rechace todos los jobs al desplegar.

   Los dos devuelven el `failure` listo para notify, con `rejected: true`: MIMO
   no cuenta el job como ejecución y el batch se puede volver a lanzar. Nunca
   llevan la contraseña.

   Sustituye a job-target.js (fase 1), que exigía que el destino del job fuera
   el del config: tenía sentido mientras las credenciales salían del config.
   =========================================================================== */
'use strict';

// Etiqueta normalizada de un sistema SAP, para comparar sin depender de mayúsculas ni espacios.
const normSystem = (v) => (v === null || v === undefined) ? '' : String(v).trim().toUpperCase();

// Origin normalizado: protocolo + host en minúsculas + puerto, sin el puerto por defecto ni barra
// final. null si no es una URL http(s): sin protocolo, `host:44380` se lee como esquema `host:` y no
// lanza.
function normOrigin(v) {
    if (v === null || v === undefined || String(v).trim() === '') return '';
    try {
        const u = new URL(String(v).trim());
        return (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : null;
    } catch { return null; }
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

const rejection = (phase, message) => ({ phase, rejected: true, message });

// Tipos de job que hacen login en el launchpad con el usuario del job: necesitan destino y credenciales.
const LOGS_IN = new Set(['fiori', 'login-check']);

/**
 * @returns {object|null} el failure del rechazo, o null si el job trae lo que necesita.
 */
function checkJobFields(job) {
    const missing = [];
    if (isBlank(job.sap_system)) missing.push('sap_system');
    if (LOGS_IN.has(job.rpa_type)) {
        for (const f of ['server_origin', 'sap_client', 'sap_user', 'sap_password']) if (isBlank(job[f])) missing.push(f);
    }
    if (missing.length) {
        return rejection('job-check', `Job sin ${missing.join(', ')}: no se sabe a qué SAP conectarse o con quién. `
            + 'Se rechaza sin abrir el navegador; revisad el sistema y su usuario por defecto en MIMO.');
    }
    if (LOGS_IN.has(job.rpa_type) && normOrigin(job.server_origin) === null) {
        return rejection('job-check', `El job trae un server_origin que no es una URL http(s) ('${job.server_origin}'). `
            + 'Se rechaza sin abrir el navegador; revisad SAPSystems.fioriOrigin en MIMO.');
    }
    return null;
}

/** Los sistemas que este host alcanza: `sap_systems`, o el `sap_system` de antes como lista de uno. */
function reachableSystems(cfg) {
    const list = Array.isArray(cfg.sap_systems) ? cfg.sap_systems
               : !isBlank(cfg.sap_system) ? [cfg.sap_system] : [];
    return list.map(normSystem).filter(Boolean);
}

/**
 * @returns {object|null} el failure del rechazo, o null si este host alcanza el sistema del job.
 */
function checkJobSystem(job, cfg) {
    const jobSystem = normSystem(job.sap_system);
    const reachable = reachableSystems(cfg);
    if (!reachable.length) {
        return rejection('system-check', `El job es del sistema SAP '${jobSystem}' pero este bot no tiene 'sap_systems' en su config.json. `
            + 'Definid la lista de sistemas que este host alcanza.');
    }
    if (!reachable.includes(jobSystem)) {
        return rejection('system-check', `El job es del sistema SAP '${jobSystem}' y este bot sólo alcanza ${reachable.join(', ')}. `
            + 'Se rechaza el job: ejecutarlo escribiría en el SAP equivocado. Revisad los bots asignados al sistema en MIMO.');
    }
    return null;
}

/** Las huellas TLS fijadas para el sistema del job en el config (ver resolveTls). */
function pinnedKeysFor(job, cfg) {
    const pins = cfg.tlsPinnedKeys || {};
    const key = Object.keys(pins).find((k) => normSystem(k) === normSystem(job.sap_system));
    return key ? [].concat(pins[key]).filter((p) => !isBlank(p)) : [];
}

// Una huella SPKI válida: SHA-256 (32 bytes) en base64 canónico. Cualquier otra cosa no llega a
// Chromium: la lista va en un argumento de lanzamiento.
function isValidPin(p) {
    if (typeof p !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(p)) return false;
    return Buffer.from(p, 'base64').length === 32;
}

const TLS_MODES = new Set(['VERIFY', 'PINNED', 'INSECURE']);

/**
 * Qué validación TLS aplicar a un job (contrato MIMO fase 2c).
 *
 * Desde la fase 2c la decide MIMO, por sistema, y viaja en el job: `tls_mode` (VERIFY | PINNED |
 * INSECURE) y `tls_pins`. Lo que diga el job manda sobre `tlsPinnedKeys` del config, que sólo se usa
 * si el job no trae `tls_mode` (un MIMO anterior a la fase 2c).
 *
 *   · Modo desconocido → VERIFY, con aviso. Nunca algo más permisivo.
 *   · PINNED: las huellas que no son SHA-256 en base64 se descartan con aviso; si no queda ninguna,
 *     el job se rechaza (`job-check`): es un error de configuración en MIMO y así no gasta un login.
 *   · INSECURE: no validar el certificado devuelve el riesgo que quitó la fase 2 (quien esté en la
 *     red entre el bot y SAP se queda con la contraseña), y bastaría un clic en MIMO para aplicarlo
 *     a todos los bots. Así que sólo se acepta si el config de ESTE bot lo permite para ese sistema
 *     (`allowInsecureTls: ["SOFOS_DEMO"]`), la misma última defensa local que `sap_systems`; si no,
 *     el job se rechaza (`job-check`) sin enviar la contraseña.
 *
 * @returns {{ tls: { mode, pins, source, warnings } } | { rejection: object }}
 */
function resolveTls(job, cfg) {
    const system = normSystem(job.sap_system);
    const warnings = [];
    if (isBlank(job.tls_mode)) {
        const pins = pinnedKeysFor(job, cfg);
        return { tls: { mode: pins.length ? 'PINNED' : 'VERIFY', pins, source: 'config', warnings } };
    }
    let mode = String(job.tls_mode).trim().toUpperCase();
    if (!TLS_MODES.has(mode)) {
        warnings.push(`tls_mode desconocido ('${job.tls_mode}') para ${system}: se valida el certificado normalmente (VERIFY).`);
        mode = 'VERIFY';
    }
    if (mode === 'PINNED') {
        const given = Array.isArray(job.tls_pins) ? job.tls_pins : [];
        const pins = given.filter(isValidPin);
        if (pins.length < given.length) warnings.push(`${given.length - pins.length} huella(s) de ${system} descartada(s): no son SHA-256 en base64.`);
        if (!pins.length) {
            return { rejection: rejection('job-check', `El sistema SAP '${system}' está en PINNED en MIMO pero el job no trae ninguna huella válida (SHA-256 en base64). `
                + 'Se rechaza sin abrir el navegador; revisad TLS Certificate Validation del sistema en MIMO (SAP Systems).') };
        }
        return { tls: { mode, pins, source: 'job', warnings } };
    }
    if (mode === 'INSECURE') {
        const allowed = (Array.isArray(cfg.allowInsecureTls) ? cfg.allowInsecureTls : []).map(normSystem);
        if (!allowed.includes(system)) {
            return { rejection: rejection('job-check', `El sistema SAP '${system}' está en INSECURE en MIMO (no validar el certificado), pero este bot no lo permite: `
                + `falta '${system}' en allowInsecureTls de su config.json. Se rechaza sin enviar la contraseña. `
                + 'Mejor que permitirlo: PINNED con la huella del certificado, o un certificado válido en SAP.') };
        }
        return { tls: { mode, pins: [], source: 'job', warnings } };
    }
    return { tls: { mode: 'VERIFY', pins: [], source: 'job', warnings } };
}

module.exports = { checkJobFields, checkJobSystem, reachableSystems, pinnedKeysFor, resolveTls, isValidPin, normOrigin, normSystem };
