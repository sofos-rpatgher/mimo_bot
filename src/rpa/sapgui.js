/* ===========================================================================
   SAPGUI RPA Engine — HTTP proxy to the local C# service
   The C# runner is expected on localhost:csharp_port (default 5000).
   =========================================================================== */

const config = require('../../config.json');

const BASE_URL = `http://localhost:${config.csharp_port}`;

/**
 * Turns the C# service's 2xx answer into a result shaped like runFiori's:
 * { success, failure?, logs_url, completedInstanceIids, resultReported }.
 *
 * Before, runSapgui returned the bare logs_url string and the worker read `result.success` on it:
 * always undefined, so EVERY SAP GUI job was notified FAILED ("Unknown error") and its logs_url never
 * reached MIMO (contract corrections, C2).
 *
 * How the C# service reports a failed run inside a 2xx is NOT defined yet (its code is not in this
 * repo). Until it is: an explicit `success: false`, an `error`/`failure`, or a `status` starting with
 * FAIL/ERROR is a failure; `success: true` is a success; anything else is taken as a success (the
 * service is expected to answer once the run finished), flagged `resultReported: false` and logged,
 * so it can be told apart once the service says what it does.
 */
function toResult(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const logs_url = typeof d.logs_url === 'string' ? d.logs_url : '';
    const completedInstanceIids = Array.isArray(d.completedInstanceIids) ? d.completedInstanceIids : [];
    const err = d.failure ?? d.error;
    const failed = d.success === false || (err !== undefined && err !== null && err !== '')
                || /^(fail|error)/i.test(String(d.status ?? ''));
    if (failed) {
        const message = (err && typeof err === 'object' ? (err.message ?? JSON.stringify(err)) : err)
                     || d.message || 'El servicio C# de SAP GUI informó de un fallo sin mensaje.';
        return { success: false, failure: { phase: 'sapgui', message: String(message) }, logs_url, completedInstanceIids, resultReported: true };
    }
    return { success: true, logs_url, completedInstanceIids, resultReported: d.success === true };
}

/**
 * Forwards the parsed script to the C# SAPGUI runner and waits for completion.
 *
 * The C# service must expose:
 *   POST /run  →  { job_iid, batch_iid, script }
 *             ←  { logs_url?, success?, error?, status?, completedInstanceIids? }   (see toResult)
 *
 * A non-2xx answer throws (the worker reports it FAILED with the service's message).
 *
 * @param {string} job_iid    Job identifier
 * @param {object} script     Parsed script JSON
 * @param {string} batch_iid  Batch identifier (forwarded for context)
 * @returns {Promise<object>} { success, failure?, logs_url, completedInstanceIids, resultReported }
 */
async function runSapgui(job_iid, script, batch_iid = '') {
    console.log(`[SapGui] Forwarding job '${job_iid}' to C# service at ${BASE_URL}/run.`);

    const res = await fetch(`${BASE_URL}/run`, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ job_iid, batch_iid, script }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`C# service returned HTTP ${res.status}: ${body}`);
    }

    const result = toResult(await res.json().catch(() => null));
    if (result.success && !result.resultReported) {
        console.warn(`[SapGui] Job '${job_iid}': the C# service answered ${res.status} without saying whether the run succeeded; taken as completed.`);
    }
    return result;
}

module.exports = runSapgui;
module.exports.toResult = toResult;
