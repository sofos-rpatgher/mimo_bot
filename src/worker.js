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

    console.log(`[Worker] Starting job '${job_iid}' (${rpa_type})…`);

    // Live execution trace: the RPA engine calls progress.onProgress as it runs.
    const progress = createProgressReporter(job_iid);

    let result;
    try {
        if (rpa_type === 'fiori') {
            result = await runFiori(parsed, { ...config, onProgress: progress.onProgress });
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
        console.log(`[Worker] Job '${job_iid}' completed.`);
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
