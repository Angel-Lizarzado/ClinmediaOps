#!/usr/bin/env node
/**
 * scripts/obfuscate-main.js
 *
 * Ofusca el código del Main Process (Node.js) de Clinmedia Ops.
 *
 * ESTRATEGIA:
 *   - Lee los fuentes de src/{electron,main,services}/
 *   - Escribe la versión ofuscada en .build-obfuscated/src/{electron,main,services}/
 *   - El código fuente original NUNCA se modifica
 *   - Los archivos no-JS (.html, .json, etc.) se copian sin cambios
 *
 * CUÁNDO CORRE:
 *   - Solo en `npm run dist` (antes de que electron-builder empaquete el .asar)
 *   - NUNCA en desarrollo (`npm run dev` / `npm start`)
 *
 * USO:
 *   node scripts/obfuscate-main.js
 */

'use strict';

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs   = require('fs');
const path = require('path');

// ── Rutas ──────────────────────────────────────────────────────────────────────

const ROOT     = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, '.build-obfuscated');

/** Directorios del Main Process que se van a ofuscar (relativos a ROOT) */
const SRC_DIRS = [
  'src/electron',
  'src/main',
  'src/services',
  'src/infrastructure',
];

// ── Configuración del ofuscador ────────────────────────────────────────────────
//
// Perfil: equilibrado entre protección y rendimiento para procesos Node.js
// con operaciones SSH intensivas.
//
// controlFlowFlattening: false  → No matar rendimiento en operaciones pesadas
// deadCodeInjection: false      → No inflar el bundle inútilmente
// selfDefending: false          → Rompe el modo estricto y entornos Node
// debugProtection: false        → Inutilizable en Main Process de Electron
// disableConsoleOutput: false   → Los logs del frontend dependen de estos canales

const OBFUSCATOR_OPTIONS = {
  target: 'node',
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  rotateStringArray: true,
  shuffleStringArray: true,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
};

/**
 * Archivos que se copian sin ofuscar.
 * Motivo típico: patrones JSDoc complejos que el parser de js-obfuscator
 * no puede manejar (bug conocido del ofuscador, no del código fuente).
 * Añadir aquí rutas RELATIVAS al ROOT del proyecto.
 */
const SKIP_FILES = new Set([
  'src/services/sql-sanitizer.js',
  // preload.js corre en el sandbox de Electron, donde `require` es una versión
  // restringida (preloadRequire). El ofuscador codifica los strings de require()
  // en base64, y el sandbox no puede resolver paths dinámicos/codificados.
  'src/electron/preload.js',
  // ipc-channels.generated.js se carga desde preload.js vía el sandbox require.
  // Debe mantener su estructura de module.exports intacta para que el sandbox
  // pueda resolverlo correctamente.
  'src/electron/ipc-channels.generated.js',
]);

/**
 * Directorios que NO se empaquetan. Los tests no tienen por qué viajar dentro
 * del instalador: solo inflan el .asar y exponen estructura interna.
 */
const SKIP_DIRS = new Set([
  '__tests__',
  '__mocks__',
  '__snapshots__',
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Copia y ofusca un directorio de forma recursiva */
function processDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath  = path.join(srcDir,  entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        console.log(`  [omitido]   ${path.relative(ROOT, srcPath)}/ (no se empaqueta)`);
        continue;
      }
      processDir(srcPath, destPath);
      continue;
    }

    // Archivos de test sueltos fuera de __tests__
    if (/\.(test|spec)\.js$/.test(entry.name)) {
      console.log(`  [omitido]   ${path.relative(ROOT, srcPath)} (test, no se empaqueta)`);
      continue;
    }

    if (entry.name.endsWith('.js')) {
      const relPath = path.relative(ROOT, srcPath).replace(/\\/g, '/');

      if (SKIP_FILES.has(relPath)) {
        // Archivo excluido explícitamente — copiar sin ofuscar
        fs.copyFileSync(srcPath, destPath);
        console.log(`  [excluido]  ${relPath} (copiado sin ofuscar)`);
        continue;
      }

      // Archivos JavaScript: ofuscar
      const source = fs.readFileSync(srcPath, 'utf8');
      try {
        const result = JavaScriptObfuscator.obfuscate(source, {
          ...OBFUSCATOR_OPTIONS,
          inputFileName: entry.name,
        });
        fs.writeFileSync(destPath, result.getObfuscatedCode(), 'utf8');
        console.log(`  [ofuscado]  ${path.relative(ROOT, srcPath)}`);
      } catch (err) {
        console.error(`  [ERROR] No se pudo ofuscar ${path.relative(ROOT, srcPath)}: ${err.message}`);
        // Fallback: copiar sin ofuscar antes de fallar el build
        fs.copyFileSync(srcPath, destPath);
        process.exitCode = 1;
      }
    } else {
      // Otros archivos (.html, .json, etc.): copiar tal cual
      fs.copyFileSync(srcPath, destPath);
      console.log(`  [copiado]   ${path.relative(ROOT, srcPath)}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('\n🔐 Ofuscando Main Process de Clinmedia Ops...\n');

// Limpiar staging anterior
if (fs.existsSync(OUT_ROOT)) {
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
}
fs.mkdirSync(OUT_ROOT, { recursive: true });

let skipped = 0;
let processed = 0;

for (const relDir of SRC_DIRS) {
  const srcDir  = path.join(ROOT, relDir);
  const destDir = path.join(OUT_ROOT, relDir);

  if (!fs.existsSync(srcDir)) {
    console.warn(`  [omitido]   ${relDir} — directorio no encontrado`);
    skipped++;
    continue;
  }

  processDir(srcDir, destDir);
  processed++;
}

const status = process.exitCode === 1 ? '⚠️  completado con errores' : '✅ Listo';
console.log(`\n${status}. Archivos escritos en .build-obfuscated/`);
console.log(`   Directorios procesados: ${processed}, omitidos: ${skipped}\n`);
