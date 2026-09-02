/* ===========================================================================
   Mimo Bot — Entry point
   Starts the Express server and subscribes to the Mimo Project Server.
   =========================================================================== */

const express  = require('express');
const config   = require('./config.json');
const startup  = require('./src/startup');
const { checkForWork } = require('./src/worker');

const app = express();
app.use(express.json());

// ----- Routes ---------------------------------------------------------------

// Wake signal: the server pings this after a Run Batch so the bot pulls its
// next job. Acknowledge immediately and look for work in the background.
app.post('/poll', (req, res) => {
    const auth  = req.headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (token !== config.token) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    res.status(202).json({ accepted: true });
    checkForWork();
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', name: config.name }));

// ----- Start ----------------------------------------------------------------
app.listen(config.port, async () => {
    console.log(`[MimoBot] '${config.name}' listening on port ${config.port}`);
    await startup();
});
