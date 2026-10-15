// ============================================================
// logon.js — El veredicto de SAP tras pulsar «Log On».
//
// `page.SAPLogin` (del Playwright adaptado) retorna igual si SAP rechazó el intento: espera la
// navegación dentro de un try/catch vacío. Sin esto, un rechazo sólo se notaba porque SAPUI5 no
// arrancaba en 120 s, con un error que hablaba del launchpad y no de la contraseña. Y no se puede
// reintentar a ciegas: SAP bloquea al usuario tras unos pocos fallos (login/fails_to_user_lock).
//
// La señal: la página de logon Fiori (/sap/public/bc/ui2/logon/fiori3) lleva en
// <body data-sap-login="…"> un JSON (base64 de un texto URL-encoded) con `messages: []` mientras
// pide el login; si SAP rechaza el intento, vuelve a pintarla con el motivo en `messages`. La de
// antes del envío nunca trae mensajes, así que que aparezcan es definitivo y sin carreras.
// La pantalla de cambio de contraseña se reconoce por tener 2+ campos de contraseña.
//
// Límites conocidos:
//   · El formato de cada entrada de `messages` no se ha visto en un rechazo real; se aceptan
//     cadenas y objetos ({ text } / { message } / …).
//   · La página de logon clásica de NetWeaver no lleva `data-sap-login`: ahí un rechazo se sigue
//     viendo sólo al vencer el plazo, y sale como LOGIN_REJECTED (el formulario sigue en pantalla).
//   · Distinguir USER_LOCKED depende de que SAP dé errores detallados
//     (login/show_detailed_errors); si no, un bloqueo sale como INVALID_CREDENTIALS.
// ============================================================

export const LOGON_CODES = Object.freeze({
    INVALID_CREDENTIALS     : 'INVALID_CREDENTIALS',
    USER_LOCKED             : 'USER_LOCKED',
    PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
    LOGIN_REJECTED          : 'LOGIN_REJECTED',
    LAUNCHPAD_TIMEOUT       : 'LAUNCHPAD_TIMEOUT',
});

// Los textos de SAP llegan con escapes `\x20` y, dentro, otra capa URL-encoded (`Espa%c3%b1ol`).
function unescapeSapText(s) {
    const unhexed = String(s).replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    try { return decodeURIComponent(unhexed); } catch { return unhexed; }
}

/** Decodifica el atributo data-sap-login. null si falta o no se entiende. */
export function decodeSapLoginData(attr) {
    if (!attr) return null;
    try {
        return JSON.parse(decodeURIComponent(Buffer.from(attr, 'base64').toString('latin1')));
    } catch {
        return null;
    }
}

/** Los textos de `messages`, sean cadenas u objetos ({ text } / { message } / …). */
export function logonMessageTexts(data) {
    const list = Array.isArray(data?.messages) ? data.messages : [];
    return list
        .map((m) => (typeof m === 'string' ? m : (m?.text ?? m?.message ?? m?.msg ?? m?.description ?? JSON.stringify(m))))
        .map(unescapeSapText)
        .map((t) => t.trim())
        .filter(Boolean);
}

// Orden: bloqueo antes que credenciales («Password logon no longer possible - too many failed
// attempts» también dice «password»). Inglés y español: la sesión se fuerza a EN, pero la página
// de logon puede salir en el idioma del navegador o del sistema.
const PATTERNS = [
    [LOGON_CODES.USER_LOCKED,              /locked|too many failed|no longer possible|bloquead|demasiados intentos/i],
    [LOGON_CODES.PASSWORD_CHANGE_REQUIRED, /new password|change (your |the )?password|password (has )?expired|initial password|nueva contraseña|cambi\w* (la |su )?contraseña|contraseña (ha )?caducad|contraseña inicial/i],
    [LOGON_CODES.INVALID_CREDENTIALS,      /incorrect|invalid|wrong|does not exist|not exist|unknown user|incorrect[oa]|no es correct|no existe|inválid[oa]|errón/i],
];

export function classifyLogonMessages(texts) {
    const all = texts.join(' | ');
    for (const [code, re] of PATTERNS) if (re.test(all)) return code;
    return LOGON_CODES.LOGIN_REJECTED;
}

const DESCRIPTIONS = {
    INVALID_CREDENTIALS     : 'SAP rechazó el usuario o la contraseña',
    USER_LOCKED             : 'el usuario SAP está bloqueado',
    PASSWORD_CHANGE_REQUIRED: 'SAP exige cambiar la contraseña de este usuario antes de entrar',
    LOGIN_REJECTED          : 'SAP rechazó el login',
    LAUNCHPAD_TIMEOUT       : 'el login no fue rechazado, pero el launchpad no arrancó',
};

/**
 * Decide, a partir de lo que se ve en la página, si el login terminó y cómo.
 * null = todavía no se sabe (navegando, cargando).
 */
export function judgeLogonSnapshot(snap) {
    if (snap.ready) return { ok: true };
    const messages = logonMessageTexts(decodeSapLoginData(snap.sapLogin));
    if (snap.passwordFields >= 2) return { ok: false, code: LOGON_CODES.PASSWORD_CHANGE_REQUIRED, messages };
    if (messages.length) return { ok: false, code: classifyLogonMessages(messages), messages };
    return null;
}

/** Texto para el error del job: el motivo, el usuario y lo que dijo SAP. Nunca la contraseña. */
export function describeLogonFailure(outcome, username) {
    const sap = outcome.messages?.length ? ` — SAP: «${outcome.messages.join(' / ')}»` : '';
    return `[${outcome.code}] Login fallido para '${username}': ${DESCRIPTIONS[outcome.code] ?? 'login fallido'}${sap}. `
         + 'No se reintenta (cada intento fallido acerca el bloqueo del usuario en SAP).';
}

/** Espera, tras SAPLogin, a que el login se resuelva: launchpad vivo, o rechazo visible de SAP. */
export async function waitForLogonOutcome(page, { timeout = 120000, interval = 500 } = {}) {
    const deadline = Date.now() + timeout;
    let last = { ready: false, sapLogin: null, passwordFields: 0 };
    while (Date.now() < deadline) {
        try {
            last = await page.evaluate(() => ({
                ready: !!(window.sap && sap.ui && (
                    typeof sap.ui.getCore === 'function' ? sap.ui.getCore() : (sap.ui.core && sap.ui.core.Element))),
                sapLogin: document.body ? document.body.getAttribute('data-sap-login') : null,
                passwordFields: document.querySelectorAll('input[type="password"]').length,
            }));
            const verdict = judgeLogonSnapshot(last);
            if (verdict) return verdict;
        } catch {
            // La página navega entre la consulta y la respuesta («Execution context was destroyed»): reintentar.
        }
        await page.waitForTimeout(interval);
    }
    // Al vencer: si el formulario de contraseña sigue en pantalla, SAP no dejó entrar (p. ej. la
    // página clásica de NetWeaver, que no trae data-sap-login); si no, el login pasó y lo que no
    // arrancó fue el launchpad, que no es culpa del usuario.
    return last.passwordFields > 0
        ? { ok: false, code: LOGON_CODES.LOGIN_REJECTED, messages: [] }
        : { ok: false, code: LOGON_CODES.LAUNCHPAD_TIMEOUT, messages: [] };
}
