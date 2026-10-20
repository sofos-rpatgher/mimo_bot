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
const { checkJobFields, checkJobSystem, resolveTls, normOrigin } = require('./job-check');

const GETNEXTJOB_URL = `${config.server_url}/scheduler/v1/getNextJob`;

// One-job-at-a-time guard, shared across every trigger.
let isRunning = false;

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
    // Fase 2b: `login-check` sólo hace login y logout con el usuario del job, para verificar su
    // contraseña. No trae batch ni script, y nunca va al servicio de SAP GUI.
    const loginCheck = rpa_type === 'login-check';

    let parsed = {};
    if (!loginCheck) {
        try {
            parsed = JSON.parse(script);
        } catch {
            console.error(`[Worker] Job '${job_iid}' has invalid script JSON.`);
            await notify(job_iid, 'FAILED', '', 'Invalid script JSON.');
            return;
        }
    }

    // Destino y credenciales antes que nada: un job incompleto o de un sistema que este host no
    // alcanza no llega a abrir el navegador. `rejected: true`: MIMO no lo cuenta como ejecución.
    // Ver job-check.js. Nunca se registra el job entero: lleva sap_password.
    const logsIn = rpa_type === 'fiori' || loginCheck;
    // Validación TLS del job (fase 2c): la decide MIMO por sistema; ver resolveTls.
    const tlsDecision = logsIn ? resolveTls(job, config) : { tls: null };
    const rejection = checkJobFields(job) || checkJobSystem(job, config) || tlsDecision.rejection;
    if (rejection) {
        console.error(`[Worker] Job '${job_iid}' rechazado (${rejection.phase}): ${rejection.message}`);
        await notify(job_iid, 'FAILED', '', rejection.message, JSON.stringify({ success: false, failure: rejection }));
        return;
    }

    const tls = tlsDecision.tls;
    for (const w of tls?.warnings || []) console.warn(`[Worker] Job '${job_iid}': ${w}`);
    const target = logsIn
        ? ` → ${normOrigin(job.server_origin)} client ${job.sap_client} user ${job.sap_user}`
        : '';
    console.log(`[Worker] Starting job '${job_iid}' (${rpa_type}) [${job.sap_system}]${target}…`);

    // Live execution trace: the RPA engine calls progress.onProgress as it runs. Un login-check no
    // tiene pasos ni batch: no emite eventos.
    const progress = loginCheck ? null : createProgressReporter(job_iid);

    let result;
    try {
        if (logsIn) {
            // Destino y credenciales, del job (fase 2); el resto de opciones (idioma, headless, debug…),
            // del config. Lo que quede de destino o credenciales en un config antiguo no se usa.
            // jobIid: para que el trace.zip de esta corrida no pise el de la anterior.
            const { serverOrigin, sapClient, username, password, sap_system, sap_systems, tlsPinnedKeys, allowInsecureTls, ...runOptions } = config;
            result = await runFiori(parsed, {
                ...runOptions,
                serverOrigin : normOrigin(job.server_origin),
                sapClient    : String(job.sap_client).trim(),
                username     : job.sap_user,
                password     : job.sap_password,
                sap_system   : job.sap_system,
                tlsMode      : tls.mode,
                tlsPinnedKeys: tls.pins,
                tlsSource    : tls.source,
                jobIid       : job_iid,
                loginOnly    : loginCheck,
                onProgress   : progress?.onProgress,
            });
        } else {
            result = await runSapgui(job_iid, parsed, batch_iid);
        }
    } catch (err) {
        // The RPA engine threw unexpectedly (crash) — no structured result.
        await progress?.close();   // flush whatever ran before the crash
        console.error(`[Worker] Job '${job_iid}' crashed: ${err.message}`);
        const crash = JSON.stringify({ success: false, failure: { message: err.message } });
        await notify(job_iid, 'FAILED', '', err.message, crash);
        return;
    }

    await progress?.close();   // flush the final events before the terminal notify

    const result_json = JSON.stringify(result);

    if (result.success) {
        console.log(`[Worker] Job '${job_iid}' completed (target: ${JSON.stringify(result.target ?? null)}).`);
        await notify(job_iid, 'COMPLETED', result.logs_url || '', '', result_json);
    } else {
        const msg = (result.failure && result.failure.message) || 'Unknown error';
        console.error(`[Worker] Job '${job_iid}' failed: ${msg}`);
        await notify(job_iid, 'FAILED', result.logs_url || '', msg, result_json);
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

module.exports = { checkForWork, runJob };   // runJob: para los tests
