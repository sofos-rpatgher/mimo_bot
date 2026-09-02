/* ===========================================================================
   Progress — streams live execution events back to the Mimo Project Server.
   The RPA engine calls onProgress(event) as it advances; events are buffered
   and flushed in batches (every ~1s or every N events) to scheduler/reportProgress.
   Best-effort by design: a dropped flush never affects the job — the terminal
   notify() call remains the source of truth for the outcome.
   =========================================================================== */

const config = require('../config.json');

const REPORT_URL = `${config.server_url}/scheduler/v1/reportProgress`;
const FLUSH_MS    = 200;    // time-based flush — small window so the console tracks in near-real-time,
                            // while still coalescing micro-bursts (e.g. a milestone + its first step)
const FLUSH_COUNT = 20;     // size-based flush

// Coerce a value to a trimmed string (or undefined). The RPA sends some context
// fields polymorphically (e.g. `instance` is a row number in one event and an
// item UUID in another); MIMO types them as strings, and OData V4 is strict, so
// we normalize here — a wrong type would 400 the whole batch.
const str = (v) => (v === null || v === undefined) ? undefined : String(v).slice(0, 100);
const int = (v) => (v === null || v === undefined || v === '') ? undefined
                   : (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : undefined);

/**
 * Normalizes one raw RPA event into exactly the MIMO ProgressEvent shape:
 * right types, no stray fields. Pure — unit-tested in test/progress-normalize.test.js.
 * @param {object} evt  the raw event from fiori.js onProgress
 * @param {number} seq  monotonic sequence assigned by the worker
 * @param {string} at   ISO timestamp assigned by the worker
 */
function normalizeEvent(evt, seq, at) {
    evt = evt || {};
    return {
        seq,
        at,
        level       : str(evt.level) || 'INFO',
        done        : int(evt.done),
        total       : int(evt.total),
        percent     : int(evt.percent),   // 0–100 completeness of THIS instance; null off-instance
        block       : str(evt.block),
        instruction : str(evt.instruction),
        instance    : str(evt.instance),
        intent      : str(evt.intent),
        step_no     : int(evt.step_no),
        action      : str(evt.action),
        message     : evt.message == null ? undefined : String(evt.message).slice(0, 1000),
    };
}

/**
 * Builds a per-job progress reporter.
 * @param {string} job_iid
 * @returns {{ onProgress: (evt: object) => void, close: () => Promise<void> }}
 */
function createProgressReporter(job_iid) {
    let buffer = [];
    let seq    = 0;
    let timer  = null;

    async function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (buffer.length === 0) return;

        const events = buffer;
        buffer = [];

        try {
            const res = await fetch(REPORT_URL, {
                method  : 'POST',
                headers : { 'Content-Type': 'application/json' },
                body    : JSON.stringify({ job_iid, events }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            // Best-effort: drop the batch, never requeue (avoids unbounded growth
            // and never blocks the run). The trace may skip a window; the outcome
            // is still reported by notify().
            console.error(`[Progress] flush failed (${events.length} event(s)): ${err.message}`);
        }
    }

    /**
     * Called by the RPA engine on each step / milestone.
     * @param {object} evt { level, done, total, percent, block, instruction,
     *                        instance, intent, step_no, action, message }
     */
    function onProgress(evt) {
        buffer.push(normalizeEvent(evt, seq++, new Date().toISOString()));

        if (buffer.length >= FLUSH_COUNT) {
            flush();
        } else if (!timer) {
            timer = setTimeout(flush, FLUSH_MS);
        }
    }

    /** Flushes any buffered events. Call before the terminal notify(). */
    async function close() {
        await flush();
    }

    return { onProgress, close };
}

module.exports = { createProgressReporter, normalizeEvent };
