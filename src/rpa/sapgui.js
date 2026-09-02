/* ===========================================================================
   SAPGUI RPA Engine — HTTP proxy to the local C# service
   The C# runner is expected on localhost:csharp_port (default 5000).
   =========================================================================== */

const config = require('../../config.json');

const BASE_URL = `http://localhost:${config.csharp_port}`;

/**
 * Forwards the parsed script to the C# SAPGUI runner and waits for completion.
 *
 * The C# service must expose:
 *   POST /run  →  { job_iid, batch_iid, script }
 *             ←  { logs_url?: string }
 *
 * @param {string} job_iid    Job identifier
 * @param {object} script     Parsed script JSON
 * @param {string} batch_iid  Batch identifier (forwarded for context)
 * @returns {Promise<string>} logs_url returned by the C# service, or ''
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

    const data = await res.json();
    return data.logs_url ?? '';
}

module.exports = runSapgui;
