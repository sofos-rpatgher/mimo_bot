/* ===========================================================================
   Job target — el destino SAP que trae el job tiene que ser el del config.json
   (contrato MIMO fase 1, C1).

   Desde la fase 1 MIMO manda en cada job `server_origin` y `sap_client`. El
   contrato pedía usarlos en lugar de los del config y sólo avisar si difieren.
   Aquí se RECHAZA el job en ese caso, y no es un descuido: en esta fase el
   usuario y la contraseña siguen saliendo del config.json y pertenecen a su
   destino. Usar otro destino mandaría esa contraseña a otro host (el POST de
   logon lleva `sap-password` al servidor que diga el job, y el contexto del
   navegador no valida certificados). Una errata en `SAPSystems.fioriOrigin`
   bastaría. `checkJobSystem` no lo impide: compara el nombre del sistema, no
   el host. Que el job decida el destino tendrá sentido en la fase 2, cuando
   las credenciales viajen con él.

   Mientras tanto, esto verifica los datos de SAPSystems en MIMO antes de esa
   fase: un job cuyo destino no cuadra falla con `phase: 'system-check'` antes
   de abrir el navegador, y el mensaje dice qué difiere.

   Sólo aplica a jobs Fiori: SAP GUI toma su destino de la configuración del
   servicio C# (fuera de este contrato).
   =========================================================================== */
'use strict';

// Origin normalizado: protocolo + host en minúsculas + puerto, sin el puerto
// por defecto ni barra final. null si no es una URL http(s): sin protocolo,
// `host:44380` se lee como esquema `host:` y no lanza.
function normOrigin(v) {
    if (v === null || v === undefined || String(v).trim() === '') return '';
    try {
        const u = new URL(String(v).trim());
        return (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : null;
    } catch { return null; }
}

// Cliente SAP como texto de 3 dígitos: 100 (número del config) = "100" (texto del job).
const normClient = (v) => (v === null || v === undefined || String(v).trim() === '') ? '' : String(v).trim().padStart(3, '0');

/**
 * @param {object} job  el job de getNextJob ({ server_origin, sap_client, … })
 * @param {object} cfg  el config.json ({ serverOrigin, sapClient })
 * @returns {string|null} el motivo del rechazo, o null si el job puede ejecutarse.
 */
function checkJobTarget(job, cfg) {
    const jobOrigin = normOrigin(job.server_origin);
    const jobClient = normClient(job.sap_client);
    if (jobOrigin === '' && jobClient === '') return null;   // MIMO aún no tiene el destino de este sistema: se usa el config

    if (jobOrigin === null) {
        return `El job trae un server_origin que no es una URL ('${job.server_origin}'). Se rechaza el job: revisad SAPSystems.fioriOrigin en MIMO.`;
    }
    const cfgOrigin = normOrigin(cfg.serverOrigin);
    const cfgClient = normClient(cfg.sapClient);
    const diffs = [];
    if (jobOrigin && jobOrigin !== cfgOrigin) diffs.push(`servidor ${jobOrigin} ≠ ${cfg.serverOrigin}`);
    if (jobClient && jobClient !== cfgClient) diffs.push(`client ${jobClient} ≠ ${cfg.sapClient}`);
    if (!diffs.length) return null;

    return `El destino del job no coincide con el config.json de este bot (${diffs.join(', ')}). `
         + 'Se rechaza el job: las credenciales SAP del bot son las de su config y no se envían a otro destino. '
         + 'Corregid SAPSystems en MIMO o el config.json del bot.';
}

module.exports = { checkJobTarget, normOrigin, normClient };
