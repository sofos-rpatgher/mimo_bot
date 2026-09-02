/* ===========================================================================
   Startup — Subscribe to Mimo Project Server
   Called once after the Express server is listening.
   =========================================================================== */

const config       = require('../config.json');
const { getPublicUrl }          = require('./ngrok');
const { ensureProjectSelected } = require('./setup');
const { checkForWork }          = require('./worker');

const SUBSCRIBE_URL = `${config.server_url}/scheduler/v1/subscribe`;

async function subscribe() {
    await ensureProjectSelected();

    // The URL the Mimo server uses to reach this bot back (the /poll wake).
    // In a container/remote host set BOT_PUBLIC_URL (or config.ip_address) to an
    // address the server can reach; falls back to localhost for local testing.
    // const ip_address = await getPublicUrl();
    const ip_address = process.env.BOT_PUBLIC_URL || config.ip_address || 'http://localhost:3001';

    if (!ip_address) {
        console.error('[Startup] Aborting subscription: no public URL available.');
        return;
    }

    try {
        const res = await fetch(SUBSCRIBE_URL, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({
                token       : config.token,
                name        : config.name,
                ip_address,
                project_iid : config.project_iid,
            }),
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`HTTP ${res.status}: ${body}`);
        }

        const body        = await res.json();
        const pendingJobs = body.value ?? [];
        console.log(`[Startup] Subscribed successfully. Pending jobs: ${pendingJobs.length}`);

        // Trigger #1: pull any work waiting for us right after subscribing.
        await checkForWork();

    } catch (err) {
        console.error(`[Startup] Subscription failed: ${err.message}`);
    }
}

module.exports = subscribe;
