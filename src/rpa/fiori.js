// ============================================================
// fiori.js — Módulo reutilizable del ejecutor RPA de SAP Fiori.
// Exporta runFiori(script, options): recibe el script como OBJETO JSON (no ruta de archivo),
// devuelve un resultado estructurado y serializa las ejecuciones (una a la vez).
// La versión CLI (recorder_play.js) es un wrapper delgado que lee un archivo y llama a esto.
// ============================================================
import { chromium } from '@playwright/test';

// Reconstruye una URL completa forzando el origin + sap-client del entorno destino.
// Acepta URL relativa (formato plataforma) o absoluta (grabación raw): descarta cualquier
// host grabado y conserva path + hash + demás parámetros de query.
function buildResolveUrl(serverOrigin, sapClient, baseLink) {
    return function resolveUrl(stored) {
        if (!stored) return baseLink;
        let u;
        try { u = new URL(stored, serverOrigin); } catch (e) { return baseLink; }
        const target = new URL(serverOrigin);
        target.pathname = u.pathname;
        target.search = u.search;
        target.hash = u.hash;
        if (sapClient) target.searchParams.set('sap-client', sapClient);
        return target.toString();
    };
}

// Serialización: encadena ejecuciones para que solo corra una sesión de navegador a la vez.
let _fioriChain = Promise.resolve();

// ============================================================
// Estrategias de localización para SAP WebDynpro ABAP
// Cada estrategia recibe un 'scope' (page o frameLocator) y devuelve
// un Locator. Las funciones tienen .name para log de diagnóstico.
// Se prueban en orden hasta que alguna haga match visible.
// ============================================================
function buildWDStrategies(sel, step) {
    const strategies = [];
    const ct = sel.ct;

    // --- Table-aware strategies (highest priority when step.is_table) ---
    // Anchor on header signature + lsmatrixcolindex. Both stable across renders.
    // Row by row_key text content (populated) or position among empty rows (new).
    if (step && step.is_table && step.table_name && (step.column_index !== null && step.column_index !== undefined)) {
        const headers = step.table_name.split('|').filter(Boolean).slice(0, 3);
        const rowParts = (step.row_key || '').split('|').filter(Boolean).slice(0, 2);
        const colIdx = step.column_index;
        const isInputCt = ct === 'I' || ct === 'CBS' || ct === 'CB';

        const buildGrid = (scope) => {
            let g = scope.locator('[role="grid"]');
            for (const h of headers) {
                g = g.filter({ has: scope.locator(`th[role="columnheader"]:has-text("${h.replace(/"/g, '\\"')}")`) });
            }
            return g.first();
        };

        if (step.row_status === 'populated' && rowParts.length > 0) {
            strategies.push(function tableHeaderRowKeyCell(scope) {
                let row = buildGrid(scope).locator('tr[role="row"]');
                for (const p of rowParts) {
                    row = row.filter({ hasText: p });
                }
                const cell = row.first().locator(`[lsmatrixcolindex="${colIdx}"]`).first();
                return isInputCt ? cell.locator('input, textarea').first() : cell;
            });
        } else if (step.row_status === 'new') {
            const pos = typeof step.row_position_in_empty === 'number' ? step.row_position_in_empty : 0;
            strategies.push(function tableHeaderEmptyRowCell(scope) {
                const grid = buildGrid(scope);
                const row = grid.locator('tr[role="row"]').nth(pos);
                const cell = row.locator(`[lsmatrixcolindex="${colIdx}"]`).first();
                return isInputCt ? cell.locator('input, textarea').first() : cell;
            });
        }

        // Fallback inside same grid: column-only (when row resolution fails but only one row matters)
        if (step.column_name) {
            strategies.push(function tableHeaderColumnFirstCell(scope) {
                const cell = buildGrid(scope).locator(`[lsmatrixcolindex="${colIdx}"]`).first();
                return isInputCt ? cell.locator('input, textarea').first() : cell;
            });
        }
    }

    // --- Botón ---
    if (ct === 'B' && sel.text) {
        strategies.push(function ctFilterText(scope) {
            return scope.locator('[ct="B"]').filter({ hasText: sel.text }).first();
        });
        strategies.push(function roleButtonName(scope) {
            return scope.getByRole('button', { name: sel.text, exact: true }).first();
        });
        // Botones de icono (p.ej. "+" Add, "Settings"): innerText vacío, identidad en
        // title / aria-label. El recorder suele guardar ese tooltip en `text`.
        const btnLabel = (sel.text || '').replace(/"/g, '\\"');
        strategies.push(function ctButtonByTitle(scope) {
            return scope.locator(`[ct="B"][title="${btnLabel}"]`).first();
        });
        strategies.push(function ctButtonByAriaLabel(scope) {
            return scope.locator(`[ct="B"][aria-label="${btnLabel}"]`).first();
        });
        strategies.push(function ctButtonByTitleContains(scope) {
            return scope.locator(`[ct="B"][title*="${btnLabel}"]`).first();
        });
        if (sel.anchorText) {
            strategies.push(function scopedToolbar(scope) {
                return scope.locator('[ct="T"]').filter({ hasText: sel.anchorText })
                            .locator('[ct="B"]').filter({ hasText: sel.text }).first();
            });
        }
        if (sel.dialogTitle) {
            strategies.push(function scopedDialog(scope) {
                return scope.locator(`[role="dialog"][aria-label="${sel.dialogTitle}"]`)
                            .locator('[ct="B"]').filter({ hasText: sel.text }).first();
            });
        }
    }

    // --- Link ---
    if (ct === 'LN') {
        if (sel.text) {
            strategies.push(function ctLinkFilterText(scope) {
                return scope.locator('[ct="LN"]').filter({ hasText: sel.text }).first();
            });
            strategies.push(function roleLinkName(scope) {
                return scope.getByRole('link', { name: sel.text, exact: true }).first();
            });
        }
    }

    // --- Input texto (ComboBox, Input genérico) ---
    if (ct === 'CBS' || ct === 'I') {
        if (sel.name) {
            strategies.push(function inputByName(scope) {
                return scope.locator(`input[name="${sel.name}"]`).first();
            });
        }
        if (sel.labelText) {
            strategies.push(function inputByLabel(scope) {
                return scope.getByLabel(sel.labelText, { exact: true }).first();
            });
        }
        if (sel.placeholder) {
            strategies.push(function inputByPlaceholder(scope) {
                return scope.getByPlaceholder(sel.placeholder).first();
            });
        }
    }

    // --- Checkbox (role=checkbox o input type=checkbox) ---
    if (sel.role === 'checkbox') {
        if (sel.labelText) {
            strategies.push(function checkboxByLabel(scope) {
                return scope.getByLabel(sel.labelText, { exact: true }).first();
            });
        }
        if (sel.name) {
            strategies.push(function checkboxByName(scope) {
                return scope.locator(`input[type="checkbox"][name="${sel.name}"]`).first();
            });
        }
    }

    // --- Tab (STC / TSITM_standards contiene role=tab) ---
    // OJO: el recorder a veces guarda el volatileId (p.ej. "WD01B4") en `text`, no el
    // label visible. Por eso preferimos labelText y le quitamos el sufijo de conteo
    // " (N)" — ese número cambia entre sesiones (p.ej. "Tiles (1)" → "Tiles (0)").
    if (ct === 'STC' || ct === 'TSITM_standards' || sel.role === 'tab') {
        const rawLabel = sel.labelText || sel.text || '';
        const tabLabel = rawLabel.replace(/\s*\(\d+\)\s*$/, '').trim(); // "Tiles (1)" → "Tiles"
        if (tabLabel) {
            // 1. ct real + texto (prefijo, tolerante al sufijo de conteo)
            strategies.push(function ctTabFilterText(scope) {
                return scope.locator(`[ct="${ct}"]`).filter({ hasText: tabLabel }).first();
            });
            // 2. role=tab por nombre (si SAP lo expone)
            strategies.push(function roleTabName(scope) {
                return scope.getByRole('tab', { name: tabLabel }).first();
            });
        }
        // 3. último recurso posicional dentro del ct real
        strategies.push(function nthTab(scope) {
            return scope.locator(`[ct="${ct}"]`).nth(sel.nthOfCt);
        });
    }

    // --- Fila de tabla / matriz ---
    if (ct === 'ML' || ct === 'MLC' || ct === 'GLC') {
        if (sel.text) {
            strategies.push(function rowByText(scope) {
                return scope.locator('[ct="ML"] [role="row"]').filter({ hasText: sel.text }).first();
            });
        }
    }

    // --- Label clickable ---
    if (ct === 'L' && sel.text) {
        strategies.push(function labelByText(scope) {
            return scope.locator('[ct="L"]').filter({ hasText: sel.text }).first();
        });
    }

    // --- Opción de dropdown (role=option) ---
    if (sel.role === 'option' && sel.text) {
        strategies.push(function roleOptionName(scope) {
            return scope.getByRole('option', { name: sel.text, exact: true }).first();
        });
    }

    // --- Menu item (POMNI / role=menuitem) ---
    // SAP popup menus (p.ej. "Add Tile" → "App Launcher – Static") se renderizan como
    // <div class="urMnuRow…"> SIN atributo role="menuitem" — getByRole no los encuentra.
    // El recorder INFIERE el role. Por eso matcheamos por las clases reales del menú y texto.
    if (ct === 'POMNI' || sel.role === 'menuitem') {
        const menuText = sel.text || sel.ariaLabel || sel.labelText;
        if (menuText) {
            // 1. Filas de menú SAP por clase (urMnuRow / lsMnuItem) + texto
            strategies.push(function sapMenuRowByClass(scope) {
                return scope.locator('[class*="urMnuRow"], [class*="lsMnuItem"]')
                            .filter({ hasText: menuText }).first();
            });
            // 2. Texto plano exacto (el nodo de texto del item, sin importar el contenedor)
            strategies.push(function menuItemByTextExact(scope) {
                return scope.getByText(menuText, { exact: true }).first();
            });
            // 3. ct + texto
            strategies.push(function ctMenuItemFilterText(scope) {
                return scope.locator(`[ct="${ct}"]`).filter({ hasText: menuText }).first();
            });
            // 4. role real (por si alguna versión sí expone role=menuitem)
            strategies.push(function roleMenuItemName(scope) {
                return scope.getByRole('menuitem', { name: menuText }).first();
            });
        }
    }

    // --- Fallback: ct + aria-label ---
    if (sel.ariaLabel) {
        strategies.push(function byCtAriaLabel(scope) {
            return scope.locator(`[ct="${ct}"][aria-label="${sel.ariaLabel}"]`).first();
        });
    }

    // --- Fallback: ct + text genérico (si no hay ninguna específica aún) ---
    if (sel.text && strategies.length === 0) {
        strategies.push(function ctGenericText(scope) {
            return scope.locator(`[ct="${ct}"]`).filter({ hasText: sel.text }).first();
        });
    }

    // --- Último recurso: ct + nth ---
    strategies.push(function nthCtFallback(scope) {
        return scope.locator(`[ct="${ct}"]`).nth(sel.nthOfCt);
    });

    return strategies;
}

// ============================================================
// Maneja el diálogo "Select Transport Request" que SAP muestra al añadir/editar
// en catálogos gestionados por transporte. La grabación no lo contempla porque se
// hizo en un entorno con transporte autoasignado. Clic en "Local Object" ($TMP).
// Se llama al inicio de cada paso: si el diálogo está abierto, lo despacha primero.
// ============================================================
async function handleTransportDialog(page) {
    const scopes = [page.frameLocator('iframe[id^="application-"]').first(), page];
    for (const scope of scopes) {
        try {
            const localObjBtn = scope.locator('[ct="B"]').filter({ hasText: 'Local Object' }).first();
            await localObjBtn.waitFor({ state: 'visible', timeout: 1500 });
            console.log('   🚚 Diálogo "Select Transport Request" detectado → clic en "Local Object".');
            await localObjBtn.click({ force: true });
            await page.waitForTimeout(1500);
            return true;
        } catch { /* no hay diálogo en este scope */ }
    }
    return false;
}

// Comparador por número de secuencia (block_seq, instruction_seq, instance_seq, intent_seq).
// La jerarquía multi-intent se recorre anidada (block → instruction → instance → intent),
// con logs por nivel para trazabilidad y futuro manejo de errores por paso.
// tOrder_id (nivel block) y rollback (nivel intent) están disponibles pero AÚN NO se usan — ver TODOs.
const bySeq = (k) => (a, b) => ((a[k] || 0) - (b[k] || 0));

// Prefijos de árbol para los logs de pasos (los pasos son hijos del nivel INTENT).
const T_STEP = "  ┃  ┃  ┃  ┣━ ";   // encabezado de cada paso (acción RPA)
const T_SUB  = "  ┃  ┃  ┃  ┃   ";   // detalle dentro de un paso
const T_ENV  = "  ┃  ┃  ┃  ";       // líneas de preparación del entorno (bajo el INTENT)

// API pública: serializa la ejecución (una a la vez) y delega en _execute.
// script: objeto JSON (multi-intent { blocks } o raw { APP_LINK, raw_steps }).
// options: { serverOrigin, sapClient, username, password, headless, slowMo, allowSave, raw, debug }
export async function runFiori(script, options = {}) {
    const run = _fioriChain.then(() => _execute(script, options), () => _execute(script, options));
    _fioriChain = run.catch(() => {}); // mantener viva la cadena aunque una ejecución falle
    return run;
}

async function _execute(script, options) {
    // --- Configuración desde options (el servidor las toma de su config.json) ---
    const serverOrigin = options.serverOrigin || process.env.SAP_SERVER || 'https://web01.sofos.proatech.mx:44302';
    const sapClient    = options.sapClient   || process.env.SAP_CLIENT  || '300';
    const username     = options.username    || process.env.SAP_USER;
    const password     = options.password    || process.env.SAP_PASS;
    const headless     = options.headless  !== undefined ? options.headless  : true;
    const slowMo       = options.slowMo    !== undefined ? options.slowMo    : 0;
    const allowSave    = options.allowSave !== undefined ? options.allowSave : true;
    const raw          = !!options.raw;
    const debug        = !!options.debug;
    // Pasos marcados `optional:true` (p.ej. confirmar un prompt de transporte que SAP sólo muestra
    // condicionalmente) usan este timeout corto y, si el elemento no aparece, se OMITEN sin fallar
    // el intent. Un paso normal ausente sigue fallando con el timeout largo (60 s).
    const optionalTimeoutMs = options.optionalTimeoutMs || 8000;
    // Idioma del navegador (Accept-Language). SAP sirve la página de login y la sesión en este
    // idioma. DEBE ser inglés: SAPLogin detecta campos "User"/"Password" y los selectores por
    // texto (p.ej. "Local Object", "Save") están grabados en inglés. En headless Chromium no
    // hereda el locale del SO (se iría a español por defecto del sistema SofOS) → login falla.
    const locale       = options.locale || 'en-US';

    const BASE_LINK = `${serverOrigin}/sap/bc/ui2/flp?sap-client=${sapClient}`;
    const resolveUrl = buildResolveUrl(serverOrigin, sapClient, BASE_LINK);

    const result = { success: false, intentsTotal: 0, intentsCompleted: 0, completedInstanceIids: [], failure: null, durationMs: 0 };
    const startedAt = Date.now();
    let current = null; // contexto del paso en curso (para localizar el fallo)

    // --- Telemetría de progreso para la consola en vivo de MIMO (contrato onProgress) ---
    // El worker pasa options.onProgress y recoge los eventos (él asigna seq/at, buffea y hace flush).
    // Aquí SÓLO emitimos: fire-and-forget, best-effort, nunca lanza, nunca cambia el control de flujo.
    // Si no viene callback, el comportamiento es idéntico al de hoy. NO batchear/throttlear/POST aquí.
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const emit = (e) => { try { onProgress && onProgress(e); } catch { /* telemetría: ignorar */ } };
    // Contexto estructurado del paso en curso — reusa exactamente los mismos valores que result.failure,
    // para que una línea de error en la consola cuadre con el resumen del fallo.
    const ctx = () => (current ? {
        block: current.block,
        instruction: current.instruction,
        instance: current.instance ?? current.instance_iid,
        intent: current.intent,
    } : {});

    if (!username || !password) {
        result.failure = { message: 'Faltan credenciales (username/password) en options o env (SAP_USER/SAP_PASS).' };
        result.durationMs = Date.now() - startedAt;
        return result;
    }
    
    const jsonData = script;   // el script llega como objeto (no ruta de archivo)

    // Determinar los bloques a ejecutar. En --raw se normaliza la grabación cruda a la misma
    // jerarquía (1 block → 1 instruction → 1 instance → 1 intent) para usar UN solo camino de
    // ejecución: el recorrido anidado block → instruction → instance → intent.
    let blocks;
    if (raw) {
        const code = jsonData.raw_steps || [];
        if (code.length === 0) {
            result.failure = { message: 'El script raw no contiene pasos (raw_steps vacío).' };
            result.durationMs = Date.now() - startedAt;
            return result;
        }
        blocks = [{
            block_id: 'raw', block_seq: 1, tOrder_id: null,
            instructions: [{
                instruction_id: 'raw', instruction_seq: 1,
                instances: [{
                    instance_seq: 1,
                    intents: [{ intent_id: 'raw', intent_seq: 1, APP_LINK: jsonData.APP_LINK || BASE_LINK, code, rollback: [] }]
                }]
            }]
        }];
        console.log(`▶️  Modo --raw: 1 intent (${code.length} pasos).`);
    } else {
        blocks = jsonData.blocks || [];
        if (blocks.length === 0) {
            result.failure = { message: "El script multi-intent no contiene 'blocks' ejecutables." };
            result.durationMs = Date.now() - startedAt;
            return result;
        }
    }
    result.intentsTotal = blocks.reduce((n, b) => n + (b.instructions || []).reduce(
        (m, ins) => m + (ins.instances || []).reduce(
            (k, q) => k + (q.intents || []).length, 0)
            // aggregated_intents: cada item cuenta como una unidad ejecutable
            + (ins.aggregated_intents || []).reduce((a, e) => a + (e.items || []).length, 0), 0), 0);
    console.log(`📦 ${blocks.length} block(s), ${result.intentsTotal} intent(s). headless=${headless} allowSave=${allowSave}`);

    // Progreso basado en ACCIONES (pasos), no en instancias: total = suma de todos los pasos a ejecutar
    // (code de cada intent + setup/items.code/finalize de cada grupo aggregated). stepsDone se incrementa
    // por cada paso procesado en runStepList (incluidos los optional omitidos). Esto alimenta done/total.
    let totalSteps = 0;
    for (const b of blocks) for (const ins of (b.instructions || [])) {
        for (const q of (ins.instances || [])) for (const it of (q.intents || [])) totalSteps += (it.code || []).length;
        for (const e of (ins.aggregated_intents || [])) {
            totalSteps += (e.setup || []).length + (e.finalize || []).length;
            for (const item of (e.items || [])) totalSteps += (item.code || []).length;
        }
    }
    let stepsDone = 0;

    // Línea de progreso POR INSTANCIA que se actualiza en el sitio. NO añadimos un campo `id`: mimo
    // agrupa por la terna (block, instruction, instance) que YA viaja en cada evento y que es única por
    // instancia dentro del job y compartida por todos sus eventos (started → STEP → completed/error).
    // Mientras una instancia corre, instCtx = { label, total, done } y cada evento lleva `percent`
    // (done/total de ESTA instancia). Fuera de una instancia (setup/finalize) instCtx = null → los pasos
    // se emiten como líneas normales (sin instance → mimo no las agrupa en ninguna línea de instancia).
    let instCtx = null;

    emit({ level: 'INFO', done: 0, total: totalSteps, message: `Starting execution: ${blocks.length} block(s), ${result.intentsTotal} intent(s), ${totalSteps} step(s).` });

    const browser = await chromium.launch({ headless, slowMo });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale });
    if (debug) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();

    try {
        // Login SIEMPRE en el FLP home (BASE_LINK, construido con el origin + client destino).
        // Toda la navegación a apps la realiza el bucle de intents (cada intent con su propio path).
        console.log("🔐 0. Ejecutando SAP Login →", BASE_LINK);
        emit({ level: 'INFO', done: 0, total: totalSteps, message: `Logging in to SAP (${username})…` });
        await page.SAPLogin(username, password, BASE_LINK);

        console.log("⏳ Esperando a que la página se estabilice después del login...");
        await page.waitForLoadState('networkidle');

        // 🔁 Recorrer la jerarquía con logs por nivel: block → instruction → instance → intent.
        // ── Helpers reutilizables (intents normales Y aggregated_intents) ──────────────
        // arriveAtApp: navega a la app (con la lógica WEBGUI/same-app), detecta el entorno
        // y engancha el force-same-tab. runStepList: ejecuta una lista de pasos SIN navegar.
        async function arriveAtApp(appLink, steps) {
                console.log("  ┃  ┃  ┃  🚀 Navegando →", appLink);
                emit({ level: 'INFO', done: stepsDone, total: totalSteps, ...ctx(), message: `Navigating → ${appLink}` });
                // Si la app ACTUAL es WEBGUI (corre en un iframe), un page.goto que sólo cambia el
                // hash NO la desmonta: la iframe/sesión WEBGUI bloquea la transición y el shell sigue
                // en la app anterior (p.ej. del Content Manager al Manage Spaces). En ese caso hay que
                // forzar una recarga completa (about:blank + goto) que destruye la iframe y carga la
                // app destino limpia.
                // Las apps WEBGUI corren en un iframe y un page.goto (cambio de hash) no las monta ni
                // desmonta de forma fiable: al SALIR de una WEBGUI el hash no cambia; al ENTRAR a una
                // WEBGUI el iframe no llega a crearse ("modo UI5 directo" falso). En ambos casos hay
                // que forzar una recarga completa (about:blank + goto). UI5→UI5 sigue con hash-nav.
                const _fromWebgui = await page.evaluate(() => !!document.querySelector('iframe[id^="application-"]')).catch(() => false);
                const _toWebgui = steps.some(s => s && s.technology === 'WEBGUI');
                if (_fromWebgui || _toWebgui) {
                    if (_fromWebgui) {
                        // Antes de DESTRUIR la iframe WEBGUI de origen, esperar a que termine su último
                        // round-trip (p.ej. el commit de "Add Tile Reference"): si no, se aborta y el
                        // cambio NO se guarda. Señales: sin overlay .lsBlockLayer + red inactiva.
                        await page.waitForTimeout(1500);
                        await page.waitForFunction(() => { const f = document.querySelector('iframe[id^="application-"]'); try { return !f || !f.contentDocument || !f.contentDocument.querySelector('.lsBlockLayer'); } catch (e) { return true; } }, { timeout: 10000 }).catch(() => {});
                        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
                    }
                    console.log(`  ┃  ┃  ┃  🔁 transición con app WEBGUI (${_fromWebgui ? 'origen' : ''}${_fromWebgui && _toWebgui ? '+' : ''}${_toWebgui ? 'destino' : ''}) → recarga completa`);
                    await page.goto('about:blank').catch(() => {});
                    await page.goto(appLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } else {
                    // UI5→UI5. Un page.goto que sólo cambia el hash es navegación same-document y NO
                    // recarga; falla de dos formas:
                    //  (a) MISMA app (mismo objeto semántico): los controles del intent anterior
                    //      (diálogos/vistas reutilizados: selector de tiles, ComboBox de transporte…)
                    //      quedan OBSOLETOS y contaminan este intent.
                    //  (b) saliendo de una SUB-RUTA profunda (un editor/detalle, hash "app&/view/…"):
                    //      el goto de sólo-hash a OTRA app NO cambia de app — el hash se queda igual
                    //      (p.ej. del editor de Pages al app de Spaces). El router del editor lo ignora.
                    // En ambos casos forzamos recarga limpia (about:blank + goto). Solo base→otra-base
                    // (sin sub-ruta) usa el hash-nav rápido.
                    const _base = (h) => (h || '').replace(/^#/, '').split(/[&\/?]/)[0];
                    const _curHash = await page.evaluate(() => location.hash || '').catch(() => '');
                    const _tgtHash = appLink.includes('#') ? appLink.slice(appLink.indexOf('#') + 1) : '';
                    const _curBase = _base(_curHash);
                    const _sameApp = _tgtHash && _curBase && _curBase === _base(_tgtHash);
                    const _curDeep = _curHash.replace(/^#/, '').length > _curBase.length; // hay sub-ruta (editor/detalle)
                    if (_sameApp || _curDeep) {
                        console.log(`  ┃  ┃  ┃  🔁 ${_sameApp ? 're-entrada a la misma app' : 'saliendo de una sub-ruta (editor/detalle)'} → recarga limpia (about:blank + goto)`);
                        await page.goto('about:blank').catch(() => {});
                        await page.goto(appLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    } else {
                        await page.goto(appLink, { waitUntil: 'networkidle', timeout: 30000 });
                    }
                }

        // Esperamos a que la base de SAPUI5 esté cargada en memoria
        await page.waitForFunction(() => {
            if (!window.sap || !sap.ui) return false;
            if (typeof sap.ui.getCore === 'function') return !!sap.ui.getCore();
            return !!(sap.ui.core && sap.ui.core.Element);
        }, { timeout: 30000 });
        console.log(T_ENV + "✅ Entorno Base SAPUI5 detectado. Iniciando ejecución híbrida...");

        // 2. ⏳ Esperamos a que Fiori inyecte el iFrame de la aplicación (opcional — apps UI5 puras no lo usan)
        console.log(T_ENV + "⏳ Esperando a que el contenedor de la aplicación WebGUI cargue...");
        try {
            await page.waitForSelector('iframe[id^="application-"]', { state: 'attached', timeout: 25000 });
            console.log(T_ENV + "✅ iframe de aplicación detectado.");
        } catch {
            console.log(T_ENV + "⚠️ No se detectó iframe — la app renderiza directamente (modo UI5 directo).");
        }

        // 🌟 FORZAR MISMA PESTAÑA — inyectado DESPUÉS de que Fiori cargó su iframe,
        // igual que el recorder (bookmarklet post-carga). Así form.submit de Fiori ya
        // se ejecutó y no se interfiere con el embedding del iframe.
        await page.evaluate(() => {
            const isRealUrl = (u) => u && u !== 'about:blank' && u !== '';
            const isNewTabTarget = (t) => t && !['_self', '_top', '_parent', ''].includes(t);

            const forceOpenInSameTab = (win, doc) => {
                if (!win || win._recOpenIntercepted) return;
                win._recOpenIntercepted = true;

                try {
                    const Form = win.HTMLFormElement;
                    if (Form && !Form.prototype._recSubmitPatched) {
                        const origSubmit = Form.prototype.submit;
                        Form.prototype.submit = function() {
                            if (isNewTabTarget(this.target)) {
                                this.target = '_self';
                            }
                            return origSubmit.apply(this, arguments);
                        };
                        Form.prototype._recSubmitPatched = true;
                    }
                } catch(e) {}

                try {
                    const Anchor = win.HTMLAnchorElement;
                    if (Anchor && !Anchor.prototype._recClickPatched) {
                        const origClick = Anchor.prototype.click;
                        Anchor.prototype.click = function() {
                            if (isNewTabTarget(this.target)) this.target = '_self';
                            return origClick.apply(this, arguments);
                        };
                        Anchor.prototype._recClickPatched = true;
                    }
                } catch(e) {}

                try {
                    const fixTarget = (el) => {
                        if (!el || el.nodeType !== 1) return;
                        if ((el.tagName === 'A' || el.tagName === 'FORM' || el.tagName === 'BASE') && isNewTabTarget(el.target)) {
                            el.target = '_self';
                        }
                        if (el.querySelectorAll) {
                            el.querySelectorAll('a[target], form[target], base[target]').forEach(child => {
                                if (isNewTabTarget(child.target)) child.target = '_self';
                            });
                        }
                    };
                    doc.querySelectorAll('a[target], form[target], base[target]').forEach(el => {
                        if (isNewTabTarget(el.target)) el.target = '_self';
                    });
                    const mo = new win.MutationObserver(mutations => {
                        mutations.forEach(m => {
                            m.addedNodes.forEach(fixTarget);
                            if (m.type === 'attributes' && m.attributeName === 'target') fixTarget(m.target);
                        });
                    });
                    mo.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['target'] });
                } catch(e) {}

                const buildProxyWindow = () => {
                    let pendingHref = '';
                    const navigate = (v) => {
                        if (isRealUrl(v)) {
                            console.log(`%c[REC] proxy navigate → misma pestaña: ${v}`, 'color:#9b59b6;font-weight:bold;');
                            window.top.location.href = v;
                        }
                    };
                    const proxyLoc = {
                        get href() { return pendingHref; },
                        set href(v) { pendingHref = v; navigate(v); },
                        assign: (v) => { pendingHref = v; navigate(v); },
                        replace: (v) => { pendingHref = v; navigate(v); },
                        reload: () => {},
                        toString: () => pendingHref
                    };
                    const noop = () => {};
                    return {
                        get location() { return proxyLoc; },
                        set location(v) { proxyLoc.href = v; },
                        document: { write: noop, writeln: noop, close: noop, open: noop, body: null, head: null },
                        focus: noop, blur: noop, close: noop, print: noop,
                        postMessage: noop, addEventListener: noop, removeEventListener: noop,
                        opener: win, closed: false, name: ''
                    };
                };

                const origOpen = win.open;
                win.open = function(url, target, features) {
                    const isNewTab = !target || (target !== '_self' && target !== '_top' && target !== '_parent');
                    if (!isNewTab) return origOpen ? origOpen.apply(this, arguments) : null;
                    if (isRealUrl(url)) {
                        console.log(`%c[REC] window.open(${url}) interceptado → misma pestaña`, 'color:#9b59b6;font-weight:bold;');
                        window.top.location.href = url;
                        return buildProxyWindow();
                    }
                    console.log(`%c[REC] window.open('') vacío interceptado → proxy esperando navegación`, 'color:#9b59b6;font-weight:bold;');
                    return buildProxyWindow();
                };

                doc.addEventListener('click', function(e) {
                    const anchor = e.target.closest('a[target]');
                    if (anchor && anchor.href && anchor.target !== '_self' && anchor.target !== '_top' && anchor.target !== '_parent' && anchor.target !== '') {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log(`%c[REC] Link (target=${anchor.target}) interceptado → misma pestaña: ${anchor.href}`, 'color:#9b59b6;font-weight:bold;');
                        window.top.location.href = anchor.href;
                    }
                }, true);
            };

            // Aplicar a window principal + todos los iframes actuales
            forceOpenInSameTab(window, document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const iDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const iWin = iframe.contentWindow;
                    if (iDoc && iWin) forceOpenInSameTab(iWin, iDoc);
                } catch(e) { /* cross-origin */ }
            });

            // Re-aplicar a iframes futuros (SAP puede cargar iframes dinámicos)
            const scanInterval = setInterval(() => {
                document.querySelectorAll('iframe').forEach(iframe => {
                    try {
                        const iDoc = iframe.contentDocument || iframe.contentWindow.document;
                        const iWin = iframe.contentWindow;
                        if (iDoc && iWin && !iWin._recOpenIntercepted) forceOpenInSameTab(iWin, iDoc);
                    } catch(e) {}
                });
            }, 2000);

            console.log('🔒 forceOpenInSameTab inyectado post-carga Fiori.');
        });

        console.log(T_ENV + "✅ Entorno detectado. Iniciando ejecución híbrida...");

        // 2. Iterar sobre los pasos grabados
        }
        async function runStepList(steps) {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            stepsDone++; // progreso por acción: cada paso procesado (incluidos los optional omitidos) cuenta
            if (current) { current.stepIndex = i + 1; current.action = step.action; current.sid = step.sid || (step.selector && step.selector.ct) || null; }
            console.log(`\n${T_STEP}⏳ [Paso ${i+1}/${steps.length}] Tecnología: ${step.technology} | Acción: ${step.action.toUpperCase()}`);
            // STEP: traza línea-a-línea para la consola en vivo. Si estamos dentro de una instancia,
            // el evento lleva el `id` de su línea + `percent` (progreso de ESTA instancia por pasos), y
            // el mensaje antepone "Instance N — P% · …"; mimo actualiza esa misma línea en vez de apilar.
            const _sid = step.sid || (step.selector && step.selector.ct) || null;
            let _pct = null;
            if (instCtx) { instCtx.done++; _pct = Math.min(100, Math.round(instCtx.done / instCtx.total * 100)); }
            const _trace = `[Step ${i+1}/${steps.length}] ${step.technology} ${String(step.action).toUpperCase()}`
                + (_sid ? ` · ${_sid}` : '') + (step.value != null ? ` = ${JSON.stringify(step.value)}` : '');
            // El STEP es SIEMPRE su propia línea de traza (mimo la apila, se guarda y se muestra en la
            // pantalla principal). Lleva `percent` + la terna (block/instruction/intent/instance) como
            // CAMPOS para que mimo actualice, aparte, la línea de progreso de la instancia — pero el
            // `message` es la traza cruda del paso, no el "Instance N — P%".
            emit({
                level: 'STEP', percent: _pct, done: stepsDone, total: totalSteps, ...ctx(),
                step_no: i + 1, action: step.action,
                message: _trace,
            });

            // Despachar diálogo de transporte si quedó abierto por una acción previa.
            await handleTransportDialog(page);

            // Los pasos `optional` (diálogos condicionales) se omiten si su elemento no aparece,
            // en lugar de abortar el intent. Ver `optionalTimeoutMs`.
            try {
if (step.technology === 'WEBGUI') {
                console.log(`${T_SUB}📍 SID/Selector: ${step.sid} | Valor: ${step.value || '(N/A)'}`);
                
                let locator;

                if (step.sid.startsWith('#') || step.sid.startsWith('.')) {
                    // Selectores CSS directos (# o .)
                    const iframeCss = page.frameLocator('iframe[id^="application-"]').first().locator(step.sid);
                    const directCss = page.locator(step.sid);
                    locator = iframeCss.or(directCss).first();
                    
                } else if (step.sid.startsWith('text=')) {
                    // Búsqueda de texto en tablas/listas
                    const searchText = step.sid.replace('text=', '');
                    const iframeText = page.frameLocator('iframe[id^="application-"]').first().getByText(searchText, { exact: true });
                    const directText = page.getByText(searchText, { exact: true });
                    locator = iframeText.or(directText).first();

                } else if (step.sid.startsWith('split_arrow=')) {
                    // 🌟 NUEVA REGLA: Clic en la flecha de un Dropdown (Split Button)
                    const cleanSid = step.sid.replace('split_arrow=', '');
                    const exactMatchString = `"SID":"${cleanSid}"`;
                    
                    // 1. Buscamos la mitad izquierda (el botón principal)
                    const iframeShell = page.frameLocator('iframe[id^="application-"]').first().locator(`[lsdata*='${exactMatchString}']`);
                    const directShell = page.locateSID(cleanSid);
                    const mainBtnLocator = iframeShell.or(directShell).first();

                    // 2. Apuntamos al "hermano" HTML de ese botón, que siempre es la flecha de la derecha
                    locator = mainBtnLocator.locator('xpath=following-sibling::div[contains(@class, "lsButton--section")]').first();

                }  else if (step.sid.startsWith('hover_menu=') || step.sid.startsWith('click_menu=')) {
                    // 🌟 REGLA NUEVA: Menús de SAP
                    const searchText = step.sid.replace(/^(hover_menu=|click_menu=)/, '');
                    // SAP genera el texto y necesitamos exact match para que no de clic en otra cosa
                    const iframeText = page.frameLocator('iframe[id^="application-"]').first().getByText(searchText, { exact: true });
                    const directText = page.getByText(searchText, { exact: true });
                    locator = iframeText.or(directText).first();
                }  else {
                    // Lógica normal para SIDs exactos de SAP
                    const exactMatchString = `"SID":"${step.sid}"`;
                    const iframeLocator = page.frameLocator('iframe[id^="application-"]').first()
                                              .locator(`[lsdata*='${exactMatchString}']`);
                    const directLocator = page.locateSID(step.sid);
                    locator = iframeLocator.or(directLocator).first();
                }

                // Esperamos dinámicamente a que el elemento esté visible
                await locator.waitFor({ state: 'visible', timeout: step.optional ? optionalTimeoutMs : 60000 });

                // Paso OPTIONAL sobre un control DESHABILITADO (aria-disabled) → omitir en vez de forzar
                // el clic. Permite que mimo ponga los 3 botones de referencia (Add Tile/TM, Add Tile,
                // Add TM) como optional: según el tipo de fila (Tile only / TM only / Both) SAP habilita
                // solo el/los válido(s); los demás salen deshabilitados y se saltan limpiamente.
                if (step.optional) {
                    const _ariaDis = await locator.getAttribute('aria-disabled').catch(() => null);
                    if (_ariaDis === 'true') {
                        console.log(`${T_STEP}⏭️  Paso ${i+1} opcional omitido (control deshabilitado).`);
                        continue;
                    }
                }

                // Ejecutamos la acción correspondiente...
                if (step.action === 'click') {
                    await locator.click({ force: true });
                } else if (step.action === 'hover') {
                    await locator.hover({ force: true });
                    await page.waitForTimeout(500); 
                } else if (step.action === 'fill') {
                    // En tablas WEBGUI la celda y su <input> comparten el mismo SID, y el locator genérico
                    // resuelve primero al <td> contenedor (no rellenable). Si el elemento apuntado no es
                    // rellenable, bajamos a su <input>/<textarea>/[contenteditable] interno. Genérico:
                    // aplica a cualquier fill sobre celda de tabla, sin conocimiento de la app.
                    const _fillable = await locator.evaluate(
                        el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
                    ).catch(() => true);
                    let fillLoc = _fillable ? locator : locator.locator('input, textarea, [contenteditable]').first();

                    // Tabla WEBGUI, "añadir una entrada": la celda [col,row] exacta que grabó mimo puede
                    // estar OCUPADA (la fila ya tiene datos) → su <input> no es editable/está vacío. En una
                    // tabla de entrada (p.ej. asignar usuarios a un rol) el índice de la primera fila libre
                    // depende de cuántas filas ya existan, algo que mimo no puede saber al generar el script.
                    // Genérico: si la celda exacta no es un <input> vacío y editable, caemos a la PRIMERA
                    // celda vacía y editable de la MISMA columna. No depende de la app ni del nº de filas.
                    if (step.is_table && step.sid && /\[\d+,\d+\]$/.test(step.sid)) {
                        // El <input> vive dentro del <td>, que es quien lleva el lsdata/SID. Buscamos, en el
                        // frame WEBGUI, la celda EXACTA; si su input no está vacío+editable (fila ocupada),
                        // devolvemos el SID de la primera celda de la misma columna cuyo input SÍ lo esté.
                        const colPrefix = step.sid.replace(/(\[\d+,)\d+\]$/, '$1'); // …UNAME[0,
                        const _frame = page.frames().find(f => /webgui/i.test(f.url()));
                        const targetSid = _frame ? await _frame.evaluate(({ prefix, exact }) => {
                            const usableInput = (c) => {
                                const i = c.tagName === 'INPUT' ? c : c.querySelector('input, textarea, [contenteditable]');
                                return i && !i.readOnly && !i.disabled && !(i.value || '').trim();
                            };
                            const cells = Array.from(document.querySelectorAll('[lsdata]'))
                                .filter(e => (e.getAttribute('lsdata') || '').includes('"SID":"' + prefix));
                            const exactCell = cells.find(e => (e.getAttribute('lsdata') || '').includes('"SID":"' + exact + '"'));
                            if (exactCell && usableInput(exactCell)) return exact;
                            for (const c of cells) {
                                if (!usableInput(c)) continue;
                                const m = (c.getAttribute('lsdata') || '').match(/"SID":"([^"]+)"/);
                                return m ? m[1] : null;
                            }
                            return null;
                        }, { prefix: colPrefix, exact: step.sid }).catch(() => null) : null;
                        if (targetSid && targetSid !== step.sid) {
                            console.log(`${T_STEP}↪️  Celda ${step.sid} ocupada → primera fila libre (${targetSid}).`);
                            fillLoc = page.frameLocator('iframe[id^="application-"]').first()
                                          .locator(`[lsdata*='"SID":"${targetSid}"']`).first()
                                          .locator('input, textarea, [contenteditable]').first();
                        }
                    }
                    await fillLoc.fill(step.value);
                } else if (step.action === 'check') {
                    await locator.check();
                } else if (step.action === 'uncheck') {
                    await locator.uncheck();
                }


            } else if (step.technology === 'WEBDYNPRO') {
                const sel = step.selector;
                console.log(`${T_SUB}🧩 WD ct=${sel.ct} text="${sel.text || sel.labelText || sel.name || '(sin texto)'}"${sel.lowConfidence ? ' ⚠️ LOW-CONF' : ''}`);

                const scopes = [
                    page.frameLocator('iframe[id^="application-"]').first(),
                    page
                ];
                const strategies = buildWDStrategies(sel, step);
                let matched = null;

                for (const strat of strategies) {
                    for (const scope of scopes) {
                        try {
                            const loc = strat(scope);
                            await loc.waitFor({ state: 'visible', timeout: 3000 });
                            matched = { loc, stratName: strat.name || 'anonymous' };
                            break;
                        } catch (e) { /* prueba la siguiente */ }
                    }
                    if (matched) break;
                }

                if (!matched && strategies.length > 0) {
                    console.log(`${T_SUB}⚠️  Ninguna estrategia rápida hizo match. Fallback 30s sobre '${strategies[0].name}'...`);
                    for (const scope of scopes) {
                        try {
                            const loc = strategies[0](scope);
                            await loc.waitFor({ state: 'visible', timeout: 30000 });
                            matched = { loc, stratName: (strategies[0].name || 'anonymous') + ' (30s)' };
                            break;
                        } catch (e) { /* siguiente scope */ }
                    }
                }

                if (!matched) {
                    // Diagnóstico: volcar frames + búsqueda del texto en todo el DOM antes de fallar.
                    const probeText = sel.text || sel.ariaLabel || sel.labelText;
                    console.log(`   🔎 DIAGNÓSTICO de fallo (texto buscado: "${probeText}")`);
                    try {
                        const frames = page.frames();
                        console.log(`      • Frames en la página: ${frames.length}`);
                        for (const fr of frames) {
                            console.log(`        - ${fr.url().slice(0, 90)}`);
                        }
                        if (probeText) {
                            for (const fr of frames) {
                                try {
                                    const n = await fr.getByText(probeText, { exact: false }).count();
                                    if (n > 0) console.log(`      • "${probeText}" aparece ${n}x en frame ${fr.url().slice(0, 70)}`);
                                } catch {}
                            }
                        }
                        // Volcar identidad real de botones + diálogos abiertos en el frame WebDynpro
                        const wdFrame = frames.find(f => f.url().includes('webdynpro')) || page.mainFrame();
                        const dump = await wdFrame.evaluate(() => {
                            const btns = [];
                            document.querySelectorAll('[ct="B"]').forEach(el => {
                                const r = el.getBoundingClientRect();
                                if (r.width === 0 || r.height === 0) return;
                                let sid = null;
                                try { const d = JSON.parse(el.getAttribute('lsdata') || '{}'); sid = d.SID || null; } catch {}
                                btns.push({
                                    t: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30),
                                    title: el.getAttribute('title'),
                                    aria: el.getAttribute('aria-label'),
                                    sid
                                });
                            });
                            const dialogs = [...document.querySelectorAll('[role="dialog"], [ct="PW"]')]
                                .map(d => (d.getAttribute('aria-label') || d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60));
                            return { btns, dialogs };
                        });
                        console.log(`      • Diálogos abiertos: ${JSON.stringify(dump.dialogs)}`);
                        console.log(`      • Botones visibles (ct=B) en frame WebDynpro:`);
                        dump.btns.forEach(b => console.log(`         text="${b.t}" title="${b.title||''}" aria="${b.aria||''}" SID=${b.sid||''}`));
                        await page.screenshot({ path: 'diag_failure.png', fullPage: false });
                        console.log(`      • Captura guardada: diag_failure.png`);
                    } catch (e) {
                        console.log(`      • Diagnóstico falló: ${e.message}`);
                    }
                    throw new Error(`No hay estrategias disponibles para el selector WD: ${JSON.stringify(sel)}`);
                }

                // Las estrategias posicionales (nth) NO matchean por identidad: pueden
                // hacer clic en el elemento equivocado si el DOM cambió desde la grabación.
                if (/nth/i.test(matched.stratName)) {
                    console.log(`${T_SUB}🟠 POSICIONAL: "${matched.stratName}" — clic por índice (${sel.nthOfCt}), NO por identidad. Posible clic erróneo si el UI cambió.`);
                } else {
                    console.log(`${T_SUB}✅ Estrategia ganadora: ${matched.stratName}`);
                }
                step._played_with = matched.stratName;

                // 🛑 Salvaguarda: detener antes de cualquier "Save" hasta que el manejo de
                // Transport Request esté implementado. Evita mutar catálogos en SAP.
                if (!allowSave && step.action === 'click' && /^save$/i.test((sel.text || '').trim())) {
                    console.log(`\n🛑 STOP antes de "Save" (paso ${i+1}). Modo no-mutante. Usar --allow-save para permitir el guardado.`);
                    console.log(`   Hasta aquí la navegación llegó correctamente. No se ha persistido nada en SAP.`);
                    break;
                }

                if (step.action === 'click') {
                    await matched.loc.click({ force: true });
                } else if (step.action === 'hover') {
                    await matched.loc.hover({ force: true });
                    await page.waitForTimeout(500);
                } else if (step.action === 'fill') {
                    await matched.loc.fill(step.value);
                } else if (step.action === 'check') {
                    await matched.loc.check();
                } else if (step.action === 'uncheck') {
                    await matched.loc.uncheck();
                }

            } else if (step.technology === 'UI5') {
                const sel = step.wdi5_selector;
                console.log(`${T_SUB}🧩 UI5 Control: ${sel.controlType} | ⏳ Esperando renderizado...`);

                // 🛠️ MEJORA 2: Polling Inteligente para esperar a que los Tiles/Controles existan
                await page.waitForFunction((sSel) => {
                    const sapObj = window.sap || window.top.sap;
                    if (!sapObj || !sapObj.ui) return false;
                    const hasGetCore = typeof sapObj.ui.getCore === 'function';
                    if (!hasGetCore && !(sapObj.ui.core && sapObj.ui.core.Element)) return false;

                    const core = hasGetCore ? sapObj.ui.getCore() : null;

                    // 1. Búsqueda por ID estático. Si el id existe → ok. Si NO (p.ej. id con clone
                    // volátil "-__cloneN" que cambia entre renders), NO abortar: seguir con la
                    // búsqueda por tipo+propiedades+visibilidad.
                    if (core && sSel.id && !sSel.id.startsWith("__") && core.byId(sSel.id)) {
                        return true;
                    }

                    // 2. Búsqueda dinámica en el registro de elementos
                    let isFound = false;
                    if (sapObj.ui.core && sapObj.ui.core.Element && sapObj.ui.core.Element.registry) {
                        sapObj.ui.core.Element.registry.forEach(el => {
                            if (isFound) return;
                            
                            if (el.getMetadata().getName() === sSel.controlType) {
                                let isMatch = true;
                                if (sSel.properties) {
                                    for (let key in sSel.properties) {
                                        if (sSel.properties[key] === '' || sSel.properties[key] == null) continue; // '' = comodín (la plataforma rellena props ausentes con "")
                                        const getter = `get${key.charAt(0).toUpperCase() + key.slice(1)}`;
                                        if (typeof el[getter] === 'function') {
                                            const av = el[getter](), bv = sSel.properties[key];
                                            // Comparación insensible a mayúsculas para strings: SAP normaliza IDs
                                            // (p.ej. catálogos) a MAYÚSCULAS aunque la data traiga "Xxx_Catalog".
                                            const eq = (typeof av === 'string' && typeof bv === 'string') ? av.toLowerCase() === bv.toLowerCase() : av === bv;
                                            if (!eq) isMatch = false;
                                        }
                                    }
                                }
                                // Requerir que esté VISIBLE (renderizada) para que el paso de acción
                                // encuentre el mismo control con DOM utilizable.
                                if (isMatch) { const d = el.getDomRef && el.getDomRef(); if (d) { const r = d.getBoundingClientRect(); if (r.width > 0 && r.height > 0) isFound = true; } }
                            }
                        });
                    }
                    return isFound;
                }, sel, { polling: 500, timeout: step.optional ? optionalTimeoutMs : 30000 }); // pasos optional → timeout corto

                // Para un FILL sobre ComboBox/Select: esperar a que carguen los ITEMS (OData async)
                // antes de casar el valor. Si no, getItems() está vacío → no hay match → el key no se
                // selecciona → campo en ROJO (p.ej. Transport al crear una página cuyo id ya está en
                // un transporte, que añade una consulta extra y retrasa la carga de items).
                if (step.action === 'fill' || step.action === 'change' || step.action === 'enterText') {
                    await page.waitForFunction((sSel) => {
                        const sapObj = window.sap || window.top.sap;
                        // Si el target es un ComboBox/Select, esperar a que exista uno FRESCO:
                        // visible + con items + con VALOR VACÍO. Esto evita casar el ComboBox de
                        // transporte OBSOLETO que queda del intent anterior (mismo diálogo reusado,
                        // no destruido) mientras el nuevo aún no se ha renderizado.
                        // esperar a que el ComboBox del DIÁLOGO ABIERTO tenga items (carga async);
                        // así no casa el combo obsoleto del intent previo ni corre antes de tiempo.
                        const dlgs = Array.from(document.querySelectorAll('.sapMDialog, .sapMPopover, .sapMResponsivePopover'))
                            .filter(d => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                        let anyCombo = false, ready = false;
                        if (sapObj.ui.core && sapObj.ui.core.Element) sapObj.ui.core.Element.registry.forEach(el => {
                            if (el.getMetadata().getName() !== sSel.controlType) return;
                            if (typeof el.getItems !== 'function' || typeof el.setSelectedKey !== 'function') return;
                            anyCombo = true;
                            const d = el.getDomRef && el.getDomRef(); const r = d && d.getBoundingClientRect();
                            const inScope = dlgs.length ? (d && dlgs.some(dd => dd.contains(d))) : true;
                            if (inScope && r && r.width > 0 && r.height > 0 && (el.getItems() || []).length > 0) ready = true;
                        });
                        return anyCombo ? ready : true;   // no-combo → no bloquear
                    }, sel, { polling: 300, timeout: 15000 }).catch(() => {});
                }

                console.log(`${T_SUB}✅ Control detectado. Ejecutando acción: ${step.action.toUpperCase()}`);

                // Localizar el control y ejecutar la acción. Para click/select/press hacemos un CLIC
                // DOM REAL sobre el nodo del control (fiel: navega filas de lista, pulsa botones,
                // marca checkboxes/items) — firePress NO reproduce navegación ni selección. Para fill
                // se setea el valor y se disparan los eventos (incl. 'search' para filtrar la lista).
                const _outcome = await page.evaluate(({ sAction, sSel, sValue }) => {
                    const sapObj = window.sap || window.top.sap;
                    const core = typeof sapObj.ui.getCore === 'function' ? sapObj.ui.getCore() : null;
                    const isFill = (sAction === 'fill' || sAction === 'change' || sAction === 'enterText');
                    const findControl = (s) => {
                        if (core && s.id && !s.id.startsWith("__")) { const c = core.byId(s.id); if (c) return c; }
                        // Preferir la coincidencia VISIBLE (con DOM renderizado): p.ej. hay varios
                        // botones "Add Section"/"Add" y solo uno está visible; los ocultos/plantilla no
                        // sirven. Para FILL, preferir además el input con valor VACÍO — así el título
                        // de la NUEVA sección se escribe en su campo (vacío), no renombra otra sección.
                        let found = null, foundVisible = null, foundEnabled = null, foundEmpty = null;
                        sapObj.ui.core.Element.registry.forEach(el => {
                            if (foundEmpty) return;
                            const isType = el.getMetadata().getName() === s.controlType;
                            let isMatch = isType;
                            if (isType && s.properties) {
                                for (let key in s.properties) {
                                    if (s.properties[key] === '' || s.properties[key] == null) continue; // '' = comodín
                                    const getter = `get${key.charAt(0).toUpperCase() + key.slice(1)}`;
                                    if (typeof el[getter] === 'function') {
                                        const av = el[getter](), bv = s.properties[key];
                                        const eq = (typeof av === 'string' && typeof bv === 'string') ? av.toLowerCase() === bv.toLowerCase() : av === bv;
                                        if (!eq) isMatch = false;
                                    }
                                }
                            }
                            if (isMatch) {
                                if (!found) found = el;
                                const dom = el.getDomRef && el.getDomRef();
                                const r = dom && dom.getBoundingClientRect();
                                const vis = r && r.width > 0 && r.height > 0;
                                if (vis) {
                                    if (!foundVisible) foundVisible = el;
                                    // Preferir ENABLED: desambigua p.ej. el "Add" del tile (habilitado)
                                    // frente al "Add" de la barra (deshabilitado si no hay tile marcado).
                                    const enabled = typeof el.getEnabled !== 'function' || el.getEnabled() !== false;
                                    if (enabled && !foundEnabled) foundEnabled = el;
                                    if (isFill && typeof el.getValue === 'function' && el.getValue() === '') foundEmpty = el;
                                }
                            }
                        });
                        return foundEmpty || foundEnabled || foundVisible || found;
                    };
                    let oControl = findControl(sSel);
                    if (!oControl) return { ok: false };
                    // ComboBox/Select: reasignar al que está DENTRO de un diálogo/popover ABIERTO (el
                    // del intent actual). Tras crear el space, su ComboBox de transporte queda en el
                    // registro "visible" y findControl podría cogerlo (obsoleto) en vez del de la
                    // página. Filtrar por contención en un .sapMDialog visible lo resuelve.
                    if (sSel.controlType === 'sap.m.ComboBox' || sSel.controlType === 'sap.m.Select') {
                        const dlgs = Array.from(document.querySelectorAll('.sapMDialog, .sapMPopover, .sapMResponsivePopover'))
                            .filter(d => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                        if (dlgs.length) {
                            let inDlg = null;
                            sapObj.ui.core.Element.registry.forEach(el => {
                                if (inDlg) return;
                                if (el.getMetadata().getName() !== sSel.controlType) return;
                                const dom = el.getDomRef && el.getDomRef();
                                if (dom && dlgs.some(d => d.contains(dom))) inDlg = el;
                            });
                            if (inDlg) oControl = inDlg;
                        }
                    }
                    if (sAction === 'fill' || sAction === 'change' || sAction === 'enterText') {
                        // ComboBox/Select: hay que SELECCIONAR el item (fija selectedKey), no solo
                        // poner el texto — si no, el control queda sin key y la validación (p.ej. el
                        // Transport al Crear) sale en ROJO. Se casa el valor por key primero (único),
                        // luego por texto (el recorder guarda el texto visible, que puede repetirse).
                        if (typeof oControl.getItems === 'function' && typeof oControl.setSelectedKey === 'function') {
                            const items = oControl.getItems() || [];
                            const match = items.find(it => it.getKey && it.getKey() === sValue)
                                       || items.find(it => it.getText && it.getText() === sValue)
                                       || items.find(it => it.getText && sValue && it.getText().indexOf(sValue) !== -1);
                            if (match) {
                                if (typeof oControl.setSelectedItem === 'function') oControl.setSelectedItem(match);
                                else oControl.setSelectedKey(match.getKey ? match.getKey() : sValue);
                                const txt = match.getText ? match.getText() : sValue;
                                if (oControl.setValue) oControl.setValue(txt);
                                oControl.fireEvent('selectionChange', { selectedItem: match });
                                oControl.fireEvent('change', { value: txt, selectedItem: match, itemPressed: true });
                                if (core) core.applyChanges();
                                return { ok: true, click: false };
                            }
                            // ComboBox con items pero el valor NO coincide con ninguno → el key
                            // inyectado no está en la lista. No hacer setValue (dejaría el campo en
                            // rojo y el fallo aparecería más tarde como timeout); avisar fuerte.
                            if (items.length) return { ok: true, click: false, comboNoMatch: { value: sValue, keys: items.map(it => it.getKey && it.getKey()) } };
                        }
                        if (oControl.setValue) {
                            oControl.setValue(sValue);
                            oControl.fireEvent('liveChange', { newValue: sValue });
                            oControl.fireEvent('change', { value: sValue });
                            if (typeof oControl.fireSearch === 'function') oControl.fireSearch({ query: sValue, clearButtonPressed: false });
                        }
                        if (core) core.applyChanges();
                        return { ok: true, click: false };
                    }
                    // click / select / press → marcar el nodo DOM del control para un clic real
                    const dom = (oControl.getFocusDomRef && oControl.getFocusDomRef()) || (oControl.getDomRef && oControl.getDomRef());
                    if (!dom) return { ok: false };
                    dom.setAttribute('data-fiori-click', '1');
                    return { ok: true, click: true };
                }, { sAction: step.action, sSel: sel, sValue: step.value });
                if (!_outcome || !_outcome.ok) throw new Error(`Control UI5[${sel.controlType}] desapareció o no tiene DOM.`);
                if (_outcome.comboNoMatch) console.warn(`${T_SUB}⚠️ ComboBox: el valor "${_outcome.comboNoMatch.value}" NO coincide con ningún item — keys disponibles: ${JSON.stringify(_outcome.comboNoMatch.keys)}. El campo quedará vacío (revisa el key inyectado o si el runner tiene el fix de ComboBox).`);
                if (_outcome.click) {
                    await page.locator('[data-fiori-click="1"]').first().click({ force: true });
                    await page.evaluate(() => document.querySelectorAll('[data-fiori-click]').forEach(n => n.removeAttribute('data-fiori-click')));
                }
            }

            } catch (stepErr) {
                if (step.optional) {
                    console.log(`${T_STEP}⏭️  Paso ${i+1} opcional omitido (no apareció): ${(stepErr.message || '').split('\n')[0]}`);
                    continue;
                }
                if (step.technology === 'UI5' && /Timeout/.test(stepErr.message || '')) {
                    try { const diag = await page.evaluate((ct) => { const sap = window.sap || window.top.sap; let title='', n=0, vis=0; sap.ui.core.Element.registry.forEach(el => { if (/customerTitle|customerCreatedTitle/.test(el.getId()) && el.getText) title = el.getText(); if (el.getMetadata().getName() === ct) { n++; const d=el.getDomRef&&el.getDomRef(); const r=d&&d.getBoundingClientRect(); if (r&&r.width>0&&r.height>0) vis++; } }); return { title, n, vis, hash: location.hash }; }, step.wdi5_selector && step.wdi5_selector.controlType); console.log(`${T_SUB}🔬 DIAG timeout: título="${diag.title}" ${step.wdi5_selector && step.wdi5_selector.controlType}: total=${diag.n} visibles=${diag.vis} hash=${diag.hash}`); } catch (e) {}
                }
                throw stepErr;
            }

            // Una ligera pausa visual entre pasos (opcional, ayuda a ver la ejecución en modo headless: false)
            await page.waitForTimeout(1000);
        }
        }

        for (const block of [...blocks].sort(bySeq('block_seq'))) {
          console.log(`\n━━━━━ BLOCK ${block.block_seq ?? '?'} · ${block.block_id || '?'}  (tOrder: ${block.tOrder_id || '—'}) ━━━━━`);
          emit({ level: 'MILESTONE', done: stepsDone, total: totalSteps, block: block.block_id, message: `▶ Block ${block.block_seq ?? '?'} · ${block.block_id || '?'}` });
          for (const instr of [...(block.instructions || [])].sort(bySeq('instruction_seq'))) {
            console.log(`  ┣━ INSTRUCTION ${instr.instruction_seq ?? '?'} · ${instr.instruction_id || '?'}`);
            emit({ level: 'MILESTONE', done: stepsDone, total: totalSteps, block: block.block_id, instruction: instr.instruction_id, message: `▶ Instruction ${instr.instruction_seq ?? '?'} · ${instr.instruction_id || '?'}` });
            for (const inst of [...(instr.instances || [])].sort(bySeq('instance_seq'))) {
              console.log(`  ┃  ┣━ INSTANCE ${inst.instance_seq ?? '?'}`);
              // Línea de progreso de esta instancia (misma `id` para started → STEP updates → completed).
              const _instTotal = (inst.intents || []).reduce((n, it) => n + (it.code || []).length, 0) || 1;
              // intent en started/completed = intent de la instancia (normalmente única). Así la terna de
              // agrupado (block, instruction, intent, instance) es consistente con los STEP (que llevan
              // current.intent) y única incluso si hubiera varios grupos aggregated en la instrucción.
              const _instIntent = (inst.intents && inst.intents[0] && inst.intents[0].intent_id) || null;
              instCtx = { label: `Instance ${inst.instance_seq ?? '?'}`, total: _instTotal, done: 0 };
              emit({ level: 'INFO', percent: 0, done: stepsDone, total: totalSteps, block: block.block_id, instruction: instr.instruction_id, intent: _instIntent, instance: inst.instance_seq, message: `▶ Instance ${inst.instance_seq ?? '?'} — 0%` });
              for (const intent of [...(inst.intents || [])].sort(bySeq('intent_seq'))) {
                const steps = intent.code || [];
                const appLink = resolveUrl(intent.APP_LINK || BASE_LINK);
                current = { block: block.block_id, instruction: instr.instruction_id, instance: inst.instance_seq, intent: intent.intent_id, stepIndex: null, action: null, sid: null, message: null };
                console.log(`  ┃  ┃  ┣━ INTENT ${intent.intent_seq ?? '?'} · ${intent.intent_id || '?'}  (${steps.length} pasos)`);
                await arriveAtApp(appLink, steps);
                await runStepList(steps);
                result.intentsCompleted++;
              } // fin INTENT
              // Instancia completada (item-level): reportar su iid si lo trae.
              const _instIid = inst.instance_iid || inst.instance_id;
              if (_instIid != null) result.completedInstanceIids.push(_instIid);
              emit({ level: 'MILESTONE', percent: 100, done: stepsDone, total: totalSteps, block: block.block_id, instruction: instr.instruction_id, intent: _instIntent, instance: inst.instance_seq, message: `✓ Instance ${inst.instance_seq ?? '?'} — 100% completed (${result.intentsCompleted}/${result.intentsTotal})` });
              instCtx = null; // salimos de la instancia → los siguientes pasos no son de esta línea
            } // fin INSTANCE

            // ── aggregated_intents (contrato): por cada grupo → navegar UNA vez → setup →
            //    bucle de items SIN re-navegar → SIEMPRE finalize. Reportar cada item en cuanto
            //    sus pasos terminan; ante un fallo, parar el bucle, correr finalize igual y
            //    propagar (el `failure` apunta al item vía current.instance_iid).
            for (const entry of [...(instr.aggregated_intents || [])].sort(bySeq('intent_seq'))) {
              const setup = entry.setup || [], items = entry.items || [], finalize = entry.finalize || [];
              const appLink = resolveUrl(entry.APP_LINK || BASE_LINK);
              current = { block: block.block_id, instruction: instr.instruction_id, intent: entry.intent_id, group_key: entry.group_key, instance_iid: null, stepIndex: null, action: null, sid: null, message: null };
              console.log(`  ┃  ┣━ AGGREGATED ${entry.intent_seq ?? '?'} · ${entry.intent_id || '?'} · grupo "${entry.group_key ?? '?'}"  (${items.length} items)`);
              // Navegar una sola vez. Detección WEBGUI a partir de los pasos de setup (o del 1er item).
              await arriveAtApp(appLink, setup.length ? setup : ((items[0] && items[0].code) || []));
              // setup FUERA del try/finally: si falla, no hay items que persistir → no corras finalize.
              if (setup.length) { console.log(`  ┃  ┃  ┣━ setup (${setup.length} pasos)`); await runStepList(setup); }
              let _pendingErr = null;
              let _itemIdx = 0; // índice 1-based del item dentro del grupo → "Instancia N" legible en la consola
              try {
                for (const item of items) {
                  _itemIdx++;
                  // instance = índice legible 1-based (para STEP/ERROR de este item); instance_iid = uuid
                  // (se conserva en result.failure para identificar exactamente el item que falló).
                  current.instance = _itemIdx; current.instance_iid = item.instance_iid; current.stepIndex = null; current.action = null; current.sid = null;
                  console.log(`  ┃  ┃  ┣━ item ${item.instance_iid ?? '?'}  (${(item.code || []).length} pasos)`);
                  // Línea de progreso de este item (misma `id` para started → STEP updates → completed).
                  instCtx = { label: `Instance ${_itemIdx}`, total: (item.code || []).length || 1, done: 0 };
                  emit({ level: 'INFO', percent: 0, done: stepsDone, total: totalSteps, block: block.block_id, instruction: instr.instruction_id, instance: _itemIdx, intent: entry.intent_id, message: `▶ Instance ${_itemIdx} — 0%` });
                  try { await runStepList(item.code || []); }
                  catch (e) { _pendingErr = e; instCtx = null; break; }   // fallo de item → parar el bucle
                  result.completedInstanceIids.push(item.instance_iid);
                  result.intentsCompleted++;
                  // The live console shows "Instance N" (readable index) instead of the item uuid.
                  emit({ level: 'MILESTONE', percent: 100, done: stepsDone, total: totalSteps, block: block.block_id, instruction: instr.instruction_id, instance: _itemIdx, intent: entry.intent_id, message: `✓ Instance ${_itemIdx} — 100% completed (${result.intentsCompleted}/${result.intentsTotal})` });
                  instCtx = null; // salimos del item → los pasos de finalize no son de esta línea
                }
              } finally {
                // SIEMPRE finalize (persiste los items ya añadidos), incluso si un item falló.
                // Limpiar el contexto de instancia: finalize NO pertenece a ningún item, así sus pasos
                // no se agrupan bajo la línea del último item (si _pendingErr, conservamos el item que
                // falló para que result.failure/ERROR lo señalen — no lo limpiamos en ese caso).
                if (!_pendingErr) { current.instance = null; current.instance_iid = null; }
                instCtx = null;
                if (finalize.length) { try { console.log(`  ┃  ┃  ┗━ finalize (${finalize.length} pasos)`); await runStepList(finalize); } catch (e) { if (!_pendingErr) _pendingErr = e; } }
              }
              if (_pendingErr) throw _pendingErr;                   // propaga; current apunta al item fallido
            }
            emit({ level: 'MILESTONE', done: stepsDone, total: totalSteps, block: block.block_id, instruction: instr.instruction_id, message: `✓ Instruction ${instr.instruction_id || '?'} finished` });
          } // fin INSTRUCTION
          emit({ level: 'MILESTONE', done: stepsDone, total: totalSteps, block: block.block_id, message: `✓ Block ${block.block_id || '?'} finished` });
        } // fin BLOCK

        result.success = true;
        console.log("\n🏁 ¡Escenario completado con éxito!");

    } catch (error) {
        // ERROR: emitir en el paso que falla, justo antes de poblar result.failure (misma info).
        emit({ level: 'ERROR', done: stepsDone, total: totalSteps, ...ctx(),
               step_no: current && current.stepIndex, action: current && current.action,
               message: `❌ Error (intent=${current?.intent ?? '?'}, step=${current?.stepIndex ?? '?'} ${current?.action ?? ''} ${current?.sid ?? ''}): ${error.message}` });
        result.failure = { ...(current || {}), message: error.message };
        console.error(`\n❌ Error en la ejecución (intent=${current?.intent ?? '?'}, paso=${current?.stepIndex ?? '?'} ${current?.action ?? ''} ${current?.sid ?? ''}): ${error.message}`);
    } finally {
        // 🔓 Liberar el lock de SAP: si quedamos en modo edición, salir con "Cancel"
        // (o "Discard") antes de cerrar. De lo contrario SAP retiene el enqueue lock
        // del catálogo y bloquea ejecuciones posteriores. Best-effort, no crítico.
        try {
            const scopes = [page.frameLocator('iframe[id^="application-"]').first(), page];
            for (const label of ['Cancel', 'Discard', 'Discard Draft']) {
                for (const scope of scopes) {
                    try {
                        const btn = scope.locator('[ct="B"]').filter({ hasText: label }).first();
                        await btn.waitFor({ state: 'visible', timeout: 1500 });
                        console.log(`🔓 Liberando edición: clic en "${label}" para soltar el lock de SAP.`);
                        await btn.click({ force: true });
                        await page.waitForTimeout(1000);
                        // Confirmar posible diálogo "¿Descartar cambios?"
                        const confirm = scope.locator('[ct="B"]').filter({ hasText: /^(OK|Yes|Discard)$/ }).first();
                        await confirm.click({ force: true, timeout: 1500 }).catch(() => {});
                        break;
                    } catch { /* botón no presente en este scope */ }
                }
            }
        } catch (e) {
            console.log(`⚠️ No se pudo ejecutar la limpieza de lock: ${e.message}`);
        }

        // Detener el trace (solo si debug)
        if (debug) {
            console.log("💾 Guardando el archivo de trace (trace.zip)...");
            await context.tracing.stop({ path: 'trace.zip' }).catch(() => {});
        }
        await browser.close().catch(() => {});
    }

    result.durationMs = Date.now() - startedAt;
    console.log(`🏁 runFiori: success=${result.success} intents=${result.intentsCompleted}/${result.intentsTotal} (${result.durationMs}ms)`);
    emit({ level: 'INFO', done: stepsDone, total: totalSteps,
           message: `Execution finished: success=${result.success} · ${result.intentsCompleted}/${result.intentsTotal} intent(s) · ${result.durationMs}ms` });
    return result;
}