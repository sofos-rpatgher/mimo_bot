/* ===========================================================================
   Ngrok URL resolver
   Tries the local Ngrok API first; falls back to config.ngrok_url.
   =========================================================================== */

const config = require('../config.json');

const NGROK_API = 'http://localhost:4040/api/tunnels';

async function getPublicUrl() {
    try {
        const res  = await fetch(NGROK_API);
        const data = await res.json();
        const tunnel = data.tunnels?.find(t => t.proto === 'https');

        if (tunnel?.public_url) {
            console.log(`[Ngrok] Public URL detected: ${tunnel.public_url}`);
            return tunnel.public_url;
        }
    } catch {
        console.warn('[Ngrok] Local API not reachable. Using fallback.');
    }

    if (config.ngrok_url) {
        console.log(`[Ngrok] Using fallback URL: ${config.ngrok_url}`);
        return config.ngrok_url;
    }

    console.error('[Ngrok] No public URL available. Check Ngrok is running or set ngrok_url in config.json.');
    return null;
}

module.exports = { getPublicUrl };
