/* ===========================================================================
   Setup — First-run project selection
   If config.project_iid is empty, fetches the list of projects from the
   Mimo Project Server and lets the operator pick one via the CLI.
   The choice is persisted back to config.json.
   =========================================================================== */

const fs       = require('node:fs');
const path     = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const config = require('../config.json');

const CONFIG_PATH   = path.join(__dirname, '..', 'config.json');
const PROJECTS_URL  = `${config.server_url}/scheduler/v1/getProjects`;

async function ensureProjectSelected() {
    if (config.project_iid) return;

    console.log('[Setup] No project configured. Fetching available projects…');

    let projects;
    try {
        const res = await fetch(PROJECTS_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        projects = await res.json();
        projects = projects.value || [];
    } catch (err) {
        console.error(`[Setup] Could not fetch projects: ${err.message}`);
        return;
    }

    if (!projects?.length) {
        console.error('[Setup] No projects available on the server.');
        return;
    }

    console.log('\nAvailable projects:');
    projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.iid})`));

    const rl = readline.createInterface({ input, output });
    let choice;

    do {
        const answer = await rl.question('\nSelect the project for this bot (number): ');
        choice = Number(answer);
    } while (!Number.isInteger(choice) || choice < 1 || choice > projects.length);

    rl.close();

    const selected = projects[choice - 1];
    console.log(`\n[Setup] You selected: ${selected.name} (${selected.iid})`);
    config.project_iid = selected.iid;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

    console.log(`[Setup] Project set to '${selected.name}' (${selected.iid}).\n`);
}

module.exports = { ensureProjectSelected };
