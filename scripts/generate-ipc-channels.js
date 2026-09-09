#!/usr/bin/env node
/**
 * scripts/generate-ipc-channels.js
 *
 * Genera la whitelist de canales IPC del preload a partir del código real.
 *
 * POR QUÉ EXISTE:
 *   La whitelist de src/electron/preload.js se mantenía a mano. Con 22 archivos
 *   de handlers eso derivó en drift en las dos direcciones: canales listados sin
 *   handler (la UI recibía "No handler registered") y handlers registrados que
 *   el preload no exponía (código backend inalcanzable).
 *
 *   La fuente de verdad ahora es el código:
 *     ipcMain.handle('x')          → INVOKE_CHANNELS   (renderer → main → renderer)
 *     ipcMain.on('x')              → SEND_CHANNELS     (renderer → main)
 *     webContents.send('x')        → RECEIVE_CHANNELS  (main → renderer)
 *
 * USO:
 *   node scripts/generate-ipc-channels.js           Regenera el archivo
 *   node scripts/generate-ipc-channels.js --check   Falla si está desactualizado
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'src', 'electron', 'ipc-channels.generated.js');
const PRELOAD_FILE = path.join(ROOT, 'src', 'electron', 'preload.js');
const START_MARKER = '// ── BEGIN GENERATED CHANNELS ──';
const END_MARKER = '// ── END GENERATED CHANNELS ──';

/** Directorios donde se buscan registros y emisiones de canales */
const SCAN_DIRS = ['src/electron', 'src/main', 'src/services', 'src/infrastructure'];

const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', '__snapshots__']);

// ── Patrones ──────────────────────────────────────────────────────────────────
// Solo se aceptan literales entre comillas. Un canal construido dinámicamente
// no se puede verificar de forma estática y debe declararse a mano en EXTRA_*.

const RE_HANDLE = /ipcMain\s*\.\s*handle\s*\(\s*['"]([^'"]+)['"]/g;
const RE_ON = /ipcMain\s*\.\s*on\s*\(\s*['"]([^'"]+)['"]/g;

// Emisiones main → renderer. Además del `webContents.send` directo hay dos
// helpers locales que envuelven el envío con el canal como primer argumento:
//   main.js        → sendToRenderer('canal', payload)
//   cms/fleet.ipc  → emit('canal', payload)
// Sin estos patrones el generador borraba canales que SÍ se emiten (todo el
// grupo updater:*, cms:*, fleet:*), rompiendo features que funcionaban.
const RE_SEND_DIRECT = /(?:webContents|sender)\s*\.\s*send\s*\(\s*['"]([^'"]+)['"]/g;
const RE_SEND_HELPER = /\b(?:sendToRenderer|emit)\s*\(\s*['"]([^'"]+)['"]/g;

// Los helpers `emit` conviven con EventEmitter.emit('progress'|'debug'|...),
// que son eventos internos, no canales IPC. Un canal IPC de este proyecto
// siempre lleva ':' o '-'; eso alcanza para separarlos.
const RE_LOOKS_LIKE_CHANNEL = /[:-]/;

/**
 * Canales main → renderer que no se detectan estáticamente porque el nombre
 * viaja en una variable. Se declaran a mano.
 * Mantener esta lista corta: si crece, conviene arreglar el emisor.
 */
const EXTRA_RECEIVE = [
  // AppStateManager._broadcast() → win.webContents.send('state:update', ...)
  'state:update',
  // deployment.ipc.js hace event.sender.send(eventName, ...) donde eventName
  // llega desde deployment-service como onDomainEvent(domain, eventName, ...)
  'migrate-domain-start',
  'migrate-domain-success',
  'migrate-domain-error',
  'migrate-domain-warning',
];

// ── Recolección ───────────────────────────────────────────────────────────────

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
    } else if (entry.name.endsWith('.js') && !/\.(test|spec)\.js$/.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function collect() {
  const invoke = new Set();
  const send = new Set();
  const receive = new Set(EXTRA_RECEIVE);

  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

  for (const file of files) {
    // El preload declara la whitelist, no registra handlers: se excluye para
    // que el generador no se alimente de su propia salida.
    if (file === OUT_FILE) continue;
    if (path.relative(ROOT, file).replace(/\\/g, '/') === 'src/electron/preload.js') continue;

    const source = fs.readFileSync(file, 'utf8');

    for (const [re, target] of [[RE_HANDLE, invoke], [RE_ON, send], [RE_SEND_DIRECT, receive]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(source)) !== null) target.add(m[1]);
    }

    RE_SEND_HELPER.lastIndex = 0;
    let m;
    while ((m = RE_SEND_HELPER.exec(source)) !== null) {
      if (RE_LOOKS_LIKE_CHANNEL.test(m[1])) receive.add(m[1]);
    }
  }

  // Los canales del ciclo de vida de Electron no son nuestros y no deben
  // exponerse al renderer.
  for (const interno of ['app:frontend-ready']) send.add(interno);

  return {
    invoke: [...invoke].sort(),
    send: [...send].sort(),
    receive: [...receive].sort(),
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

function render({ invoke, send, receive }) {
  const list = (items) => items.map((c) => `  '${c}',`).join('\n');

  return `// ARCHIVO GENERADO — NO EDITAR A MANO.
//
// Generado por scripts/generate-ipc-channels.js a partir del código fuente.
// Para agregar un canal, registrá su handler y volvé a correr:
//
//   npm run ipc:channels
//
// Verificar que esté al día (falla si hay drift):
//
//   npm run ipc:check

'use strict';

/** renderer → main → renderer (ipcMain.handle) */
const INVOKE_CHANNELS = [
${list(invoke)}
];

/** renderer → main (ipcMain.on) */
const SEND_CHANNELS = [
${list(send)}
];

/** main → renderer (webContents.send) */
const RECEIVE_CHANNELS = [
${list(receive)}
];

module.exports = { INVOKE_CHANNELS, SEND_CHANNELS, RECEIVE_CHANNELS };
`;
}

function renderPreloadBlock({ invoke, send, receive }) {
  const list = (items) => items.map((c) => `  '${c}',`).join('\n');

  return `${START_MARKER}
// Auto-generated by scripts/generate-ipc-channels.js — DO NOT EDIT MANUALLY

const INVOKE_CHANNELS = [
${list(invoke)}
];

const SEND_CHANNELS = [
${list(send)}
];

const RECEIVE_CHANNELS = [
${list(receive)}
];
${END_MARKER}`;
}

function updatePreload(preloadContent, newBlock) {
  const startIndex = preloadContent.indexOf(START_MARKER);
  const endIndex = preloadContent.indexOf(END_MARKER);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Markers ${START_MARKER} / ${END_MARKER} no encontrados en preload.js`);
  }
  return preloadContent.slice(0, startIndex) + newBlock + preloadContent.slice(endIndex + END_MARKER.length);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const channels = collect();
const output = render(channels);
const preloadBlock = renderPreloadBlock(channels);
const isCheck = process.argv.includes('--check');

if (isCheck) {
  const actualOut = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
  const actualPreload = fs.existsSync(PRELOAD_FILE) ? fs.readFileSync(PRELOAD_FILE, 'utf8') : '';

  const outOk = actualOut === output;
  const preloadOk = actualPreload.includes(preloadBlock);

  if (!outOk || !preloadOk) {
    console.error('[IPC] La whitelist de canales está DESACTUALIZADA.');
    console.error('[IPC] Corré: npm run ipc:channels');
    process.exit(1);
  }
  console.log(
    `[IPC] Whitelist al día — ${channels.invoke.length} invoke, ` +
    `${channels.send.length} send, ${channels.receive.length} receive.`
  );
  process.exit(0);
}

fs.writeFileSync(OUT_FILE, output, 'utf8');
if (fs.existsSync(PRELOAD_FILE)) {
  const currentPreload = fs.readFileSync(PRELOAD_FILE, 'utf8');
  const updatedPreload = updatePreload(currentPreload, preloadBlock);
  fs.writeFileSync(PRELOAD_FILE, updatedPreload, 'utf8');
}
console.log(
  `[IPC] ${path.relative(ROOT, OUT_FILE)} y ${path.relative(ROOT, PRELOAD_FILE)} actualizados — ` +
  `${channels.invoke.length} invoke, ${channels.send.length} send, ${channels.receive.length} receive.`
);
