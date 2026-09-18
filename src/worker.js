/* ===========================================================================
   Worker — Bot-pull job loop
   Pulls the next PENDING job from the Mimo Project Server, runs it through the
   right RPA engine, reports the result, then loops until no work is left.
   The three triggers (after subscribe / after finishing / on a /poll wake)
   all funnel into checkForWork().
   =========================================================================== */

const config    = require('../config.json');
const notify    = require('./notify');
const { createProgressReporter } = require('./progress');
const { runFiori }  = require('./rpa/fiori');
const runSapgui = require('./rpa/sapgui');

const GETNEXTJOB_URL = `${config.server_url}/scheduler/v1/getNextJob`;

// One-job-at-a-time guard, shared across every trigger.
let isRunning = false;

// Etiqueta normalizada de un sistema SAP, para comparar sin depender de mayúsculas ni espacios.
const normSystem = (v) => (v === null || v === undefined) ? '' : String(v).trim().toUpperCase();

/**
 * Comprueba que el sistema SAP que declara el lote sea el que este bot tiene configurado.
 *
 * Hasta ahora el sistema del lote era decorativo: todas las opciones de conexión salen del
 * config.json local, y el job no transportaba el sistema — el lote FORMS-0000001 declaraba
 * 'SOFOS_DEMO' y la corrida fue contra Grupo Mar sin que nada lo advirtiera. El modo de fallo,
 * dicho claro: una acción real ejecutada en el SAP de otra empresa.
 *
 * En cuanto MIMO mande el sistema en el job, un job que no sea para este bot se rechaza ANTES de
 * abrir el navegador. Mientras no lo mande, se avisa y se sigue (comportamiento de hoy).
 *
 * @returns {string|null} el motivo del rechazo, o null si el job puede ejecutarse.
 */
function checkJobSystem(job) {
    const jobSystem = normSystem(job.sap_system ?? job.system_id ?? job.system);
    const botSystem = normSystem(config.sap_system ?? config.system_id);

    if (!jobSystem) {
        console.warn(`[Worker] Job '${job.job_iid}' no declara sistema SAP — se ejecuta contra el destino del config.json (${config.serverOrigin}, client ${config.sapClient}).`);
        return null;
    }
    if (!botSystem) {
        return `El job declara el sistema SAP '${jobSystem}' pero este bot no tiene 'sap_system' en su config.json: no se puede verificar el destino. Define 'sap_system' con el sistema al que apunta ${config.serverOrigin}.`;
    }
    if (jobSystem !== botSystem) {
        return `El job declara el sistema SAP '${jobSystem}' y este bot está configurado para '${botSystem}' (${config.serverOrigin}, client ${config.sapClient}). Se rechaza el job: ejecutarlo escribiría en el SAP equivocado.`;
    }
    return null;
}

/**
 * Asks the server for the next job to run.
 * @returns {Promise<object|null>} the job ({ job_iid, batch_iid, batch_id, rpa_type, script })
 *                                 or null when there is no pending work.
 */
async function getNextJob() {
    const res = await fetch(GETNEXTJOB_URL, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ token: config.token }),
    });

    if (!res.ok) throw new Error(`getNextJob HTTP ${res.status}`);

    // OData wraps an action's complex return; "no work" comes back empty/null.
    const body = await res.json().catch(() => null);
    if (!body || !body.job_iid) return null;

    return body;
}

/**
 * Runs a single job through the matching RPA engine and reports the result.
 */
async function runJob(job) {
    const { job_iid, batch_iid, rpa_type, script } = job;

    let parsed;
    try {
        parsed = JSON.parse(script);
    } catch {
        console.error(`[Worker] Job '${job_iid}' has invalid script JSON.`);
        await notify(job_iid, 'FAILED', '', 'Invalid script JSON.');
        return;
    }

    // Destino antes que nada: un job para otro sistema no llega a abrir el navegador.
    const systemMismatch = checkJobSystem(job);
    if (systemMismatch) {
        console.error(`[Worker] Job '${job_iid}' rechazado: ${systemMismatch}`);
        await notify(job_iid, 'FAILED', '', systemMismatch,
                     JSON.stringify({ success: false, failure: { phase: 'system-check', message: systemMismatch } }));
        return;
    }

    console.log(`[Worker] Starting job '${job_iid}' (${rpa_type}) → ${config.serverOrigin} client ${config.sapClient}${config.sap_system ? ` [${config.sap_system}]` : ''}…`);

    // Live execution trace: the RPA engine calls progress.onProgress as it runs.
    const progress = createProgressReporter(job_iid);

    let result;
    try {
        if (rpa_type === 'fiori') {
            // jobIid: para que el trace.zip de esta corrida no pise el de la anterior.
            result = await runFiori(parsed, { ...config, jobIid: job_iid, onProgress: progress.onProgress });
        } else {
            result = await runSapgui(job_iid, parsed, batch_iid);
        }
    } catch (err) {
        // The RPA engine threw unexpectedly (crash) — no structured result.
        await progress.close();   // flush whatever ran before the crash
        console.error(`[Worker] Job '${job_iid}' crashed: ${err.message}`);
        const crash = JSON.stringify({ success: false, failure: { message: err.message } });
        await notify(job_iid, 'FAILED', '', err.message, crash);
        return;
    }

    await progress.close();   // flush the final events before the terminal notify

    const result_json = JSON.stringify(result);

    if (result.success) {
        console.log(`[Worker] Job '${job_iid}' completed (target: ${JSON.stringify(result.target ?? null)}).`);
        await notify(job_iid, 'COMPLETED', '', '', result_json);
    } else {
        const msg = (result.failure && result.failure.message) || 'Unknown error';
        console.error(`[Worker] Job '${job_iid}' failed: ${msg}`);
        await notify(job_iid, 'FAILED', '', msg, result_json);
    }
}

/**
 * Pulls and runs jobs until the queue is empty.
 * Re-entrant calls (e.g. a /poll while busy) return immediately; the running
 * loop drains any newly-queued work via its tail call.
 */
async function checkForWork() {
    if (isRunning) return;

    isRunning = true;
    try {
        let job = await getNextJob();
        while (job) {
            await runJob(job);
            job = await getNextJob();
        }
        console.log('[Worker] No pending work.');
    } catch (err) {
        console.error(`[Worker] checkForWork error: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

module.exports = { checkForWork };
