/* ===========================================================================
   Notify — Reports job status back to Mimo Project Server
   =========================================================================== */

const config = require('../config.json');

const NOTIFY_URL = `${config.server_url}/scheduler/v1/notify`;

async function notify(job_iid, status_code, logs_url = '', error_message = '', result_json = '') {
    try {
        const res = await fetch(NOTIFY_URL, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ job_iid, status_code, logs_url, error_message, result_json }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        console.log(`[Notify] Job '${job_iid}' → ${status_code}`);

    } catch (err) {
        console.log(err);
        console.error(`[Notify] Failed for job '${job_iid}': ${err.message}`);
    }
}

module.exports = notify;
