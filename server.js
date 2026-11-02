#!/usr/bin/env node
'use strict';

/**
 * wacrawl-mcp — MCP server (stdio) sobre el archivo local de WhatsApp.
 *
 * Todo local. Sin dependencias npm, sin red.
 *
 * Todas las lecturas van por `wacrawl sql`, que es de sólo lectura (rechaza
 * cualquier cosa que no sea un único SELECT) y tarda ~1-3s. Deliberadamente NO
 * usamos los subcomandos `chats` / `messages` / `search`: hacen un "backfill"
 * que escribe en la base y tardan MINUTOS sobre un archivo de cientos de miles de mensajes,
 * lo que hacía que Claude Desktop cortara por timeout. Además `search` devuelve
 * muchísimos menos resultados que consultar el índice FTS directo.
 *
 * El archivo se mantiene fresco con el agente de launchd (`wacrawl sync` cada
 * 6h), no desde acá: nunca escribimos ni movemos ~/.wacrawl/wacrawl.db.
 */

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const WACRAWL_BIN =
  process.env.WACRAWL_BIN ||
  [
    path.join(os.homedir(), '.local/bin/wacrawl'),
    '/opt/homebrew/bin/wacrawl',
    '/usr/local/bin/wacrawl',
  ].find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  }) ||
  'wacrawl';

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MS = 60000;

function execWacrawl(args) {
  return new Promise((resolve, reject) => {
    execFile(WACRAWL_BIN, args, { maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).toString().trim();
        reject(new Error(`wacrawl falló: ${detail}`));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocked = (err) => /database is locked|SQLITE_BUSY/i.test(err.message || '');

/** Serializa las llamadas y reintenta si el sync de launchd tiene la base tomada. */
let queue = Promise.resolve();

function runWacrawl(args) {
  const result = queue.then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await execWacrawl(args);
      } catch (err) {
        if (!isLocked(err) || attempt >= 4) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  });
  queue = result.then(() => {}, () => {});
  return result;
}

/** Ejecuta un SELECT y devuelve las filas. `--sync never` = lectura pura. Sin `db`, el archivo principal. */
async function runSQL(sql, db = null) {
  const out = await runWacrawl([...(db ? ['--db', db] : []), '--sync', 'never', '--json', 'sql', sql]);
  const trimmed = out.trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`wacrawl devolvió una salida no-JSON: ${trimmed.slice(0, 400)}`);
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((r) => r && typeof r === 'object');
}

/* ------------------------------------------------------------------ */
/* histórico del iPhone: un segundo archivo, fijo, con los años viejos  */
/* ------------------------------------------------------------------ */

/**
 * WhatsApp Desktop recibe ~1 año de historia al vincularse. Los años anteriores se importan
 * una vez desde un backup del iPhone (importar-iphone.sh) a un archivo APARTE: cuando WhatsApp
 * renumera, el sync reconstruye el principal entero con lo que tiene Desktop, y se llevaría
 * puesto lo importado.
 *
 * Los dos se solapan en el último año, así que cada uno responde sólo su tramo: el histórico
 * antes de `corte`, el principal desde `corte` (el primer mes en que el principal ya está
 * completo). Así los conteos suman sin duplicar.
 */
const HISTORICO_DIR = process.env.WACRAWL_HISTORICO_DIR || path.join(os.homedir(), '.wacrawl/historico');

function historico() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(HISTORICO_DIR, 'corte.json'), 'utf8'));
    const db = path.join(HISTORICO_DIR, 'wacrawl.db');
    if (Number.isFinite(info.corte) && fs.existsSync(db)) return { ...info, db };
  } catch {}
  return null;
}

/** Hasta dónde llega la historia en ESTA Mac, para las instrucciones del server. */
function profundidad() {
  const h = historico();
  if (!h) {
    return 'el archivo tiene lo que WhatsApp Desktop recibió del teléfono al vincularse, más todo lo que llegó después. Suele cubrir meses, no años.';
  }
  return `además de lo que WhatsApp Desktop recibió al vincularse, en esta Mac se importó la historia del iPhone ` +
    `(backup del ${h.backup}): las búsquedas cubren desde ${h.desde}. Lo que llegó después de ese backup entra por el sync normal. ` +
    `Los adjuntos viejos son los que el iPhone tenía guardados${h.sinVideos ? ' (sin videos ni stickers)' : ''}. ` +
    `Los audios de antes del ${h.corteFecha} pueden no estar transcriptos: transcribir_audios los transcribe a pedido.`;
}

/** Qué adjuntos existen en esta Mac, para explicar por qué falta uno. */
function queArchivosHay() {
  const h = historico();
  if (!h) {
    return 'Sólo existen los archivos que WhatsApp Desktop descargó desde que se vinculó a esta Mac;' +
      ' de mensajes anteriores existe el registro pero no el archivo.';
  }
  return `Sólo existen los archivos que WhatsApp Desktop descargó desde que se vinculó a esta Mac y los que el` +
    ` iPhone tenía guardados al hacer el backup${h.adjuntosDesde ? ` (desde ${h.adjuntosDesde})` : ''}` +
    `${h.sinVideos ? ', sin videos ni stickers' : ''}; de lo anterior existe el registro pero no el archivo.`;
}

/** La misma consulta en los dos archivos, cada uno en su tramo. `armar` recibe la condición de fecha. */
function enAmbos(armar) {
  const h = historico();
  if (!h) return [runSQL(armar(''))];
  return [runSQL(armar(` AND m.ts >= ${h.corte}`)), runSQL(armar(` AND m.ts < ${h.corte}`), h.db)];
}

/* ------------------------------------------------------------------ */
/* fuente en vivo: la base de WhatsApp Desktop, ESTRICTAMENTE read-only */
/* ------------------------------------------------------------------ */

/** CoreData cuenta segundos desde 2001-01-01, no desde 1970. */
const APPLE_EPOCH = 978307200;

let sourcePathPromise = null;

/** Ruta de ChatStorage.sqlite, según el propio wacrawl (no la hardcodeamos). */
function sourcePath() {
  if (!sourcePathPromise) {
    sourcePathPromise = runWacrawl(['--sync', 'never', 'doctor'])
      .then((out) => {
        const chatDb = JSON.parse(out)?.desktop?.chat_db;
        if (!chatDb) throw new Error('wacrawl doctor no reportó la ruta de WhatsApp Desktop.');
        return chatDb;
      })
      .catch((err) => {
        sourcePathPromise = null;
        throw err;
      });
  }
  return sourcePathPromise;
}

/**
 * Consulta la base VIVA de WhatsApp, a través del propio wacrawl.
 *
 * Va por wacrawl y no por /usr/bin/sqlite3 por un motivo concreto: macOS le
 * pedía permiso a NODE cada vez, porque node era quien abría el container de
 * WhatsApp. wacrawl ya tiene ese permiso concedido (es el que sincroniza), así
 * que usándolo el prompt desaparece — y de paso no hace falta darle acceso a
 * todo el disco a node, que sería mucho más amplio.
 *
 * `sql` de wacrawl rechaza todo lo que no sea un único SELECT, y está
 * verificado que no modifica el archivo de WhatsApp.
 */
async function runLiveSQL(sql) {
  const db = await sourcePath();
  const out = await runWacrawl(['--db', db, '--sync', 'never', '--json', 'sql', sql]);
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((r) => r && typeof r === 'object');
  } catch {
    throw new Error(`wacrawl devolvió una salida inesperada: ${trimmed.slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ */
/* media: convertir a algo que Claude pueda VER                        */
/* ------------------------------------------------------------------ */

const SIPS_BIN = '/usr/bin/sips';
const MAX_PX = 1024;

/**
 * Normaliza cualquier adjunto a JPEG para devolverlo como imagen por MCP.
 *
 * Los PDF se RENDERIZAN a imagen en vez de extraerles el texto: macOS no trae
 * nada nativo para eso (Spotlight no indexa el container de WhatsApp y PyObjC
 * no está instalado), y renderizar sirve igual para PDFs escaneados, donde no
 * hay texto que extraer. `sips` viene con el sistema, así que cero dependencias.
 *
 * Ojo: de un PDF sale SÓLO la primera página.
 */
async function renderToJpeg(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacrawl-media-'));
  const out = path.join(dir, 'out.jpg');
  try {
    const ext = extensionDe(srcPath);
    if (ext && path.extname(srcPath).toLowerCase() !== ext) {
      const conExt = path.join(dir, `in${ext}`);
      fs.copyFileSync(srcPath, conExt);
      srcPath = conExt;
    }
    await new Promise((resolve, reject) => {
      execFile(
        SIPS_BIN,
        ['-s', 'format', 'jpeg', '-Z', String(MAX_PX), srcPath, '--out', out],
        { timeout: 30000 },
        (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim())) : resolve())
      );
    });
    return fs.readFileSync(out).toString('base64');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* no importa */ }
  }
}

const EXT_SOPORTADAS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.pdf', '.tiff', '.bmp']);

/** Documentos que se pueden LEER como texto con textutil (viene con macOS, sin dependencias). */
const EXT_TEXTO = new Set(['.docx', '.doc', '.rtf', '.odt', '.txt', '.html', '.htm']);
const MAX_TEXTO = 20000;

async function textoDeDocumento(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacrawl-doc-'));
  try {
    // textutil decide el formato por la extensión: wacrawl 0.4.x guarda sin extensión.
    const ext = extensionDe(srcPath);
    const entrada = path.join(dir, `in${ext}`);
    fs.copyFileSync(srcPath, entrada);
    const texto = await new Promise((resolve, reject) => {
      execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', entrada], { maxBuffer: MAX_BUFFER, timeout: 30000 },
        (err, out, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim())) : resolve(out.toString())));
    });
    const limpio = texto.replace(/\n{3,}/g, '\n\n').trim();
    return limpio.length > MAX_TEXTO
      ? `${limpio.slice(0, MAX_TEXTO)}\n\n[… recortado: el documento sigue. Exportalo con exportar_archivo para tenerlo completo.]`
      : limpio;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* no importa */ }
  }
}

/**
 * Extensión real de un adjunto. wacrawl 0.3.x copiaba la media con su nombre
 * original (".../uuid.jpg"), pero 0.4.x la guarda por hash y SIN extensión
 * (".../media/46/4637a2f5…"), y no registra el tipo en ningún lado. Entonces,
 * si no hay extensión, la deducimos de los primeros bytes, como hace `file`.
 */
function extensionDe(ruta) {
  const ext = path.extname(ruta).toLowerCase();
  if (ext && ext.length <= 6) return ext;
  let b;
  try {
    const fd = fs.openSync(ruta, 'r');
    b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, 4096, 0);
    fs.closeSync(fd);
    b = b.subarray(0, n);
  } catch {
    return '';
  }
  const asc = (i, len) => b.toString('latin1', i, i + len);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (asc(0, 4) === '\x89PNG') return '.png';
  if (asc(0, 4) === '%PDF') return '.pdf';
  if (asc(0, 4) === 'GIF8') return '.gif';
  if (asc(0, 4) === 'RIFF' && asc(8, 4) === 'WEBP') return '.webp';
  if (asc(0, 4) === 'OggS') return '.opus';
  if (asc(4, 4) === 'ftyp') {
    const marca = asc(8, 4);
    if (['heic', 'heix', 'mif1', 'msf1'].includes(marca)) return '.heic';
    if (marca === 'M4A ') return '.m4a';
    if (marca === 'qt  ') return '.mov';
    return '.mp4';
  }
  if (asc(0, 4) === 'PK\x03\x04') {          // Office moderno = zip
    // El índice de un zip está al FINAL: miramos el principio y la cola.
    let cola = Buffer.alloc(0);
    try {
      const fd = fs.openSync(ruta, 'r');
      const tam = fs.fstatSync(fd).size;
      cola = Buffer.alloc(Math.min(65536, tam));
      fs.readSync(fd, cola, 0, cola.length, Math.max(0, tam - cola.length));
      fs.closeSync(fd);
    } catch { /* con el principio alcanza */ }
    const cuerpo = b.toString('latin1') + cola.toString('latin1');
    if (cuerpo.includes('word/')) return '.docx';
    if (cuerpo.includes('xl/')) return '.xlsx';
    if (cuerpo.includes('ppt/')) return '.pptx';
    return '.zip';
  }
  if (/^\s*<(!doctype html|html)/i.test(asc(0, 64))) return '.html';
  return '';
}

/* ------------------------------------------------------------------ */
/* borradores: el modelo redacta, la persona envía                     */
/* ------------------------------------------------------------------ */

/**
 * Nivel 1 de "enviar": NUNCA se envía nada. Se abre WhatsApp Desktop en el
 * chat con el texto escrito en la caja, y la persona aprieta Enter.
 *
 * Las barreras viven acá y no en el prompt, porque un modelo que se desboca
 * ignora instrucciones pero no un `if`. Los límites se persisten en disco para
 * que reiniciar el server no los resetee.
 */
// Overridables sólo para test (check.sh): carpeta de estado y comando que abre.
const DRAFTS_DIR = process.env.WACRAWL_DRAFTS_DIR || path.join(os.homedir(), '.wacrawl');
const OPEN_BIN = process.env.WACRAWL_OPEN_BIN || '/usr/bin/open';
const DRAFTS_LOG = path.join(DRAFTS_DIR, 'borradores.jsonl');
const KILL_SWITCH = path.join(DRAFTS_DIR, 'STOP');
const LIMITES_DEFAULT = {
  porMinuto: 3,          // borradores sueltos (preparar_mensaje)
  porHora: 15,
  largoMax: 2000,
  ventanaDifusionMin: 60,
  antiDifusion: true,    // mismo texto a otro chat → bloqueado
  colaMax: 30,           // mensajes por cola
  colaEsperaMin: 10,     // sin envío en este lapso → la cola se pausa
  permitirEnvio: false,  // enviar_mensaje APRIETA ENTER: apagado salvo que la persona lo active
  enviosPorHora: 10,
};
/**
 * Se pueden ajustar en ~/.wacrawl/limites.json (ej. {"porHora": 40}). Es
 * decisión de la persona: el riesgo de que WhatsApp restrinja la cuenta es
 * suyo. Lo que NO es ajustable es que nunca se envía nada solo.
 */
function cargarLimites() {
  try {
    const propio = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, 'limites.json'), 'utf8'));
    return { ...LIMITES_DEFAULT, ...propio };
  } catch {
    return { ...LIMITES_DEFAULT };
  }
}
let LIMITES = cargarLimites();

function leerBorradores() {
  try {
    return fs.readFileSync(DRAFTS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const normalizarTexto = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

/** Devuelve el motivo del bloqueo, o null si se puede abrir el borrador. */
function chequearBarreras(telefono, texto, { enCola = false } = {}) {
  LIMITES = cargarLimites();
  if (fs.existsSync(KILL_SWITCH)) {
    return `Borradores DESACTIVADOS: existe ${KILL_SWITCH}. Borrá ese archivo para reactivarlos.`;
  }
  const ahora = Date.now();
  const previos = leerBorradores();
  const enVentana = (min) => previos.filter((b) => ahora - b.ts < min * 60000);

  if ((!enCola || enCola === 'envio') && enVentana(1).length >= LIMITES.porMinuto) {
    return `Límite: máximo ${LIMITES.porMinuto} borradores por minuto. Esperá un momento.`;
  }
  if (enCola === 'envio' && enVentana(60).filter((b) => b.envio).length >= LIMITES.enviosPorHora) {
    return `Límite: máximo ${LIMITES.enviosPorHora} envíos por hora. Esto frena una ráfaga; se libera solo (ajustable en ~/.wacrawl/limites.json).`;
  }
  if (enVentana(60).length >= LIMITES.porHora) {
    return `Límite: máximo ${LIMITES.porHora} borradores por hora. Esto frena una ráfaga; se libera solo.`;
  }
  // Anti-difusión: el mismo texto a OTRO destinatario es el patrón de un
  // broadcast, que es lo que hace que WhatsApp banee cuentas.
  const t = normalizarTexto(texto);
  const repetido = LIMITES.antiDifusion &&
    enVentana(LIMITES.ventanaDifusionMin).find((b) => b.texto === t && b.telefono !== telefono);
  if (repetido) {
    return `Bloqueado: ese mismo texto ya se preparó para otro chat (${repetido.chat}) en la última hora. No se arman difusiones.`;
  }
  return null;
}

function registrarBorrador(entrada) {
  fs.mkdirSync(path.dirname(DRAFTS_LOG), { recursive: true });
  fs.appendFileSync(DRAFTS_LOG, JSON.stringify(entrada) + '\n');
}

/** Teléfono (sólo dígitos) de un chat, o error explicando por qué no hay. */
async function telefonoDeChat(chat) {
  const valor = String(chat).trim();

  // Número escrito directamente
  const digitos = valor.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (/^\d{8,15}$/.test(digitos)) {
    const [previo] = await runSQL(`SELECT name FROM chats WHERE jid = ${sqlString(`${digitos}@s.whatsapp.net`)} LIMIT 1`);
    return { telefono: digitos, jid: `${digitos}@s.whatsapp.net`, nombre: previo?.name || `+${digitos}`, conocido: Boolean(previo) };
  }

  const jid = await resolveChatJID(valor);
  const [fila] = await runSQL(`SELECT name FROM chats WHERE jid = ${sqlString(jid)} LIMIT 1`);
  const nombre = fila?.name || valor;

  if (jid.endsWith('@g.us')) {
    throw new Error(`"${nombre}" es un grupo. WhatsApp sólo permite abrir chats individuales por enlace: abrí el grupo a mano.`);
  }
  if (jid.endsWith('@s.whatsapp.net')) {
    return { telefono: jid.split('@')[0], jid, nombre, conocido: true };
  }
  if (jid.endsWith('@lid')) {
    const [ct] = await runSQL(
      `SELECT jid FROM contacts WHERE lid = ${sqlString(jid)} AND deleted_at IS NULL AND jid LIKE '%@s.whatsapp.net' LIMIT 1`
    );
    if (ct) return { telefono: ct.jid.split('@')[0], jid, nombre, conocido: true };
    throw new Error(
      `No tengo el número de "${nombre}": no está en tu agenda y WhatsApp oculta el número de los no agendados. ` +
      `Si lo sabés, pasámelo directamente.`
    );
  }
  throw new Error(`"${nombre}" no es un chat individual.`);
}

/**
 * Envío real: aprieta Enter en WhatsApp Desktop (la app oficial, así no hay riesgo de bloqueo por
 * usar un cliente no oficial). Antes verifica que WhatsApp sea la app al frente: si el foco se fue
 * a otra ventana, el Enter caería ahí. Necesita permiso de Accesibilidad para el proceso
 * responsable (el runtime de node); sin él macOS rechaza el keystroke y se avisa cómo darlo.
 */
const ENTER_BIN = process.env.WACRAWL_ENTER_BIN || null;   // sólo para test

const SCRIPT_ENTER = `
tell application "WhatsApp" to activate
delay 0.4
tell application "System Events"
  set frente to name of first application process whose frontmost is true
  if frente is not "WhatsApp" then error "frente:" & frente
  key code 36
end tell`;

function presionarEnter() {
  return new Promise((resolve, reject) => {
    const [bin, args] = ENTER_BIN ? [ENTER_BIN, []] : ['/usr/bin/osascript', ['-e', SCRIPT_ENTER]];
    execFile(bin, args, { timeout: 15000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const msg = String(stderr || err.message);
      if (/frente:/.test(msg)) {
        const app = msg.split('frente:')[1].split('(')[0].trim();
        reject(new Error(`No envié: WhatsApp no quedó al frente (estaba ${app}), y el Enter habría caído ahí. El mensaje quedó escrito en WhatsApp sin enviar.`));
      } else if (/1002|not allowed to send keystrokes|assistive/i.test(msg)) {
        reject(new Error(
          'No envié: macOS no le da permiso de Accesibilidad a este server para apretar Enter. ' +
          'El usuario tiene que ir a Ajustes del Sistema → Privacidad y seguridad → Accesibilidad → + → ⌘⇧G → ' +
          `${process.execPath} → activarlo. El mensaje quedó escrito en WhatsApp sin enviar.`
        ));
      } else if (/-1743|not authorized to send apple events|no autorizado/i.test(msg)) {
        reject(new Error(
          'No envié: macOS no le permite a este server controlar "System Events". El usuario tiene que ir a ' +
          'Ajustes del Sistema → Privacidad y seguridad → Automatización y activar System Events para node. ' +
          'El mensaje quedó escrito en WhatsApp sin enviar.'
        ));
      } else {
        reject(new Error(`No envié: ${msg.trim().slice(0, 200)}. El mensaje quedó escrito en WhatsApp sin enviar.`));
      }
    });
  });
}

/** Abre WhatsApp en el chat con el texto escrito. No envía. */
async function abrirBorrador({ telefono, nombre }, cuerpo, extra = {}) {
  const url = `whatsapp://send?phone=${telefono}&text=${encodeURIComponent(cuerpo)}`;
  await new Promise((resolve, reject) => {
    execFile(OPEN_BIN, [url], { timeout: 15000 }, (err, _out, stderr) =>
      err ? reject(new Error(`No pude abrir WhatsApp: ${(stderr || err.message).toString().trim()}`)) : resolve()
    );
  });
  registrarBorrador({ ts: Date.now(), telefono, chat: nombre, texto: normalizarTexto(cuerpo), ...extra });
}

function notificar(texto) {
  execFile('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(texto)} with title "wacrawl"`], () => {});
}

/**
 * ¿Salió algún mensaje MÍO en ese chat desde `desdeMs`? No exige el mismo texto:
 * la persona puede corregir el borrador antes de mandarlo, y eso cuenta igual.
 * OJO: un chat NUEVO (justo el caso de los mensajes en frío) WhatsApp lo crea
 * con ZCONTACTJID = <algo>@lid, y deja el teléfono en ZCONTACTIDENTIFIER. Buscar
 * sólo por ZCONTACTJID no lo encontraba nunca y la cola quedaba esperando.
 */
async function detectarEnvio({ jid, telefono }, desdeMs) {
  if (process.env.WACRAWL_FAKE_SENT_FILE) {   // sólo para test
    try { return fs.readFileSync(process.env.WACRAWL_FAKE_SENT_FILE, 'utf8').split('\n').includes(telefono); }
    catch { return false; }
  }
  const jids = [...new Set([jid, `${telefono}@s.whatsapp.net`].filter(Boolean))];
  const lista = jids.map(sqlString).join(', ');
  const desde = Math.floor(desdeMs / 1000) - APPLE_EPOCH - 5;
  const [fila] = await runLiveSQL(
    `SELECT count(*) AS n FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION` +
    ` WHERE (s.ZCONTACTJID IN (${lista}) OR s.ZCONTACTIDENTIFIER IN (${lista}))` +
    ` AND m.ZISFROMME = 1 AND m.ZMESSAGEDATE >= ${desde}`
  );
  return (fila?.n ?? 0) > 0;
}

/**
 * Cola de borradores. WhatsApp NO conserva el texto de un borrador si se abre
 * otro chat, así que nunca se abren dos seguidos: el siguiente se abre recién
 * cuando se detecta que la persona mandó el actual. El ritmo lo pone ella, no un
 * timer (un timer pisa el borrador si alguien tarda en leer o corregir).
 */
let cola = null;
const POLL_MS = Number(process.env.WACRAWL_COLA_POLL_MS) || 2500;

function resumenCola() {
  if (!cola) return 'No hay ninguna cola.';
  const c = (e) => cola.items.filter((i) => i.estado === e).length;
  const lineas = cola.items.map((i, n) => {
    const marca = { enviado: '✓', salteado: '↷', abierto: '▶', pendiente: '·', error: '✗' }[i.estado];
    return `${marca} ${n + 1}. ${i.nombre}${i.estado === 'error' ? ` — ${i.motivo}` : ''}`;
  });
  return (
    `Cola ${cola.estado}: ${c('enviado')} enviados, ${c('salteado')} salteados, ` +
    `${c('pendiente') + c('abierto')} por mandar.\n\n${lineas.join('\n')}`
  );
}

async function abrirSiguiente() {
  const i = cola.items.findIndex((x) => x.estado === 'pendiente');
  if (i === -1) {
    cola.estado = 'terminada';
    clearInterval(cola.timer);
    notificar(`Cola terminada: ${cola.items.filter((x) => x.estado === 'enviado').length} de ${cola.items.length} enviados.`);
    return;
  }
  const item = cola.items[i];
  const bloqueo = chequearBarreras(item.telefono, item.texto, { enCola: true });
  if (bloqueo) {
    cola.estado = 'pausada';
    cola.motivo = bloqueo;
    notificar(`Cola pausada: ${bloqueo}`);
    return;
  }
  try {
    await abrirBorrador(item, item.texto, { cola: true });
    item.estado = 'abierto';
    item.abiertoEn = Date.now();
  } catch (err) {
    item.estado = 'error';
    item.motivo = err.message;
    await abrirSiguiente();
  }
}

async function vigilarCola() {
  if (!cola || cola.estado !== 'activa' || cola.chequeando) return;
  cola.chequeando = true;
  try {
    if (fs.existsSync(KILL_SWITCH)) {
      cola.estado = 'cancelada';
      clearInterval(cola.timer);
      notificar('Cola cancelada: se activó STOP.');
      return;
    }
    const item = cola.items.find((x) => x.estado === 'abierto');
    if (!item) return;
    if (await detectarEnvio(item, item.abiertoEn)) {
      item.estado = 'enviado';
      // pausa breve para que WhatsApp termine de mandar antes de cambiar de chat
      await sleep(1500);
      await abrirSiguiente();
    } else if (Date.now() - item.abiertoEn > cargarLimites().colaEsperaMin * 60000) {
      cola.estado = 'pausada';
      cola.motivo = `no se mandó "${item.nombre}" en ${cargarLimites().colaEsperaMin} min`;
      notificar(`Cola pausada: ${cola.motivo}.`);
    }
  } catch (err) {
    // Sin permiso para leer WhatsApp en vivo no se puede detectar el envío:
    // mejor frenar que seguir abriendo a ciegas.
    cola.estado = 'pausada';
    cola.motivo = `no pude chequear si se envió (${err.message.slice(0, 120)})`;
    notificar('Cola pausada: no puedo detectar envíos.');
  } finally {
    if (cola) cola.chequeando = false;
  }
}

/* ------------------------------------------------------------------ */
/* transcripciones de audio (Whisper local, ver transcribir.py)        */
/* ------------------------------------------------------------------ */

/**
 * Las transcripciones viven en una base APARTE (~/.wacrawl/transcripciones.sqlite):
 * el archivo de wacrawl nunca se escribe. Las hace transcribir.py, en segundo
 * plano después de cada sync, o en el momento con la tool transcribir_audios.
 * Función y no constante: DRAFTS_DIR se declara más abajo.
 */
const transcDb = () => path.join(DRAFTS_DIR, 'transcripciones.sqlite');
const WHISPER = (() => {
  const v = { python: '3.12', paquete: 'mlx-whisper==0.4.3', modelo: 'mlx-community/whisper-large-v3-turbo' };
  try {   // whisper.env es la fuente de verdad, compartida con los scripts
    for (const l of fs.readFileSync(path.join(__dirname, 'whisper.env'), 'utf8').split('\n')) {
      const m = l.match(/^WHISPER_(PYTHON|PAQUETE|MODELO)=(.+)$/);
      if (m) v[{ PYTHON: 'python', PAQUETE: 'paquete', MODELO: 'modelo' }[m[1]]] = m[2].trim();
    }
  } catch { /* defaults */ }
  return v;
})();

async function runTranscSQL(sql) {
  if (!fs.existsSync(transcDb())) return [];
  const out = (await runWacrawl(['--db', transcDb(), '--sync', 'never', '--json', 'sql', sql])).trim();
  if (!out) return [];
  const p = JSON.parse(out);
  return (Array.isArray(p) ? p : [p]).filter((r) => r && typeof r === 'object');
}

/** Pega la transcripción (si existe) a cada fila de audio. "" = no se detectó voz. */
async function adjuntarTranscripciones(rows) {
  const audios = rows.filter((r) => r.message_type === 'audio' && r.message_id);
  if (!audios.length) return rows;
  const ids = [...new Set(audios.map((r) => r.message_id))];
  let tr;
  try {
    tr = await runTranscSQL(`SELECT msg_id, chat_jid, texto FROM transcripciones WHERE msg_id IN (${ids.map(sqlString).join(', ')})`);
  } catch {
    return rows;   // sin transcripciones se muestra "(audio)" como siempre
  }
  const mapa = new Map(tr.map((t) => [`${t.msg_id}|${t.chat_jid}`, t.texto ?? '']));
  for (const r of audios) {
    const k = `${r.message_id}|${r.chat_jid}`;
    if (mapa.has(k)) r.transcripcion = mapa.get(k);
  }
  return rows;
}

/** Busca en lo que se DIJO en los audios. Devuelve null si no hay transcripciones. */
async function buscarEnAudios({ terms, jid, desde, hasta, de_mi, limite }) {
  if (!fs.existsSync(transcDb())) return null;
  const w = ["texto <> ''"];
  for (const t of terms) w.push(`lower(texto) LIKE ${sqlString(`%${likeLiteral(t.toLowerCase())}%`)} ESCAPE '\\'`);
  if (jid) w.push(`chat_jid IN (${(await variantes(jid)).map(sqlString).join(', ')})`);
  if (desde) w.push(`ts >= ${toEpoch(desde, 'desde')}`);
  if (hasta) w.push(`ts < ${toEpoch(hasta, 'hasta')}`);
  if (typeof de_mi === 'boolean') w.push(`from_me = ${de_mi ? 1 : 0}`);
  const clause = w.join(' AND ');
  let total, hits;
  try {
    const [c] = await runTranscSQL(`SELECT count(*) AS n FROM transcripciones WHERE ${clause}`);
    total = c?.n ?? 0;
    hits = total ? await runTranscSQL(`SELECT msg_id, chat_jid, texto FROM transcripciones WHERE ${clause} ORDER BY ts DESC LIMIT ${limite}`) : [];
  } catch {
    return null;
  }
  if (!hits.length) return { total, rows: [] };
  // Los datos para mostrar (quién, dónde, cuándo) salen del archivo, como el resto.
  const rows = await selectMessages(
    'messages m', `m.deleted_at IS NULL AND m.msg_id IN (${hits.map((h) => sqlString(h.msg_id)).join(', ')})`, 'DESC', limite * 2
  );
  const mapa = new Map(hits.map((h) => [`${h.msg_id}|${h.chat_jid}`, h.texto]));
  const conTexto = rows
    .filter((r) => mapa.has(`${r.message_id}|${r.chat_jid}`))
    .map((r) => ({ ...r, transcripcion: mapa.get(`${r.message_id}|${r.chat_jid}`) }));
  return { total, rows: conTexto.slice(0, limite) };
}

function seccionAudios(res) {
  if (!res || !res.total) return '';
  const shown = res.total > res.rows.length ? ` (mostrando ${res.rows.length})` : '';
  return `\n\nEn audios (transcriptos): ${res.total}${shown}:\n\n${formatMessages(res.rows, { withChat: true })}`;
}

/** uv + modelo bajado + script. Si falta algo, error con la instrucción para arreglarlo. */
function whisperListo() {
  const uv = [process.env.WACRAWL_UV, path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv',
    path.join(os.homedir(), '.cargo/bin/uv')].find((p) => p && fs.existsSync(p));
  const modelo = path.join(os.homedir(), '.cache/huggingface/hub', `models--${WHISPER.modelo.replace('/', '--')}`);
  const script = path.join(__dirname, 'transcribir.py');
  if (!uv || !fs.existsSync(modelo) || !fs.existsSync(script)) {
    throw new Error(
      'La transcripción de audios no está instalada en esta Mac. Hay que correr una vez ./setup-whisper.sh ' +
      '(baja el modelo, ~1,6 GB; después todo corre local y sin conexión).'
    );
  }
  return { uv, script };
}

/** Corre transcribir.py con la lista por stdin; devuelve {clave: texto}. Sin red. */
function correrTranscriptor({ uv, script }, items) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const hijo = spawn(uv, ['run', '--quiet', '--python', WHISPER.python, '--with', WHISPER.paquete, 'python', script, '--stdin'], {
      env: {
        HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        UV_OFFLINE: '1', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', WACRAWL_DIR: DRAFTS_DIR, WHISPER_MODELO: WHISPER.modelo,
      },
    });
    let out = '', err = '';
    const reloj = setTimeout(() => { hijo.kill(); reject(new Error('La transcripción tardó demasiado; probá con menos audios.')); }, 170000);
    hijo.stdout.on('data', (d) => (out += d));
    hijo.stderr.on('data', (d) => (err += d));
    hijo.on('error', (e) => { clearTimeout(reloj); reject(e); });
    hijo.on('close', (code) => {
      clearTimeout(reloj);
      const res = {};
      for (const l of out.split('\n').filter(Boolean)) {
        try { const j = JSON.parse(l); res[`${j.msg_id}|${j.chat_jid}`] = j.texto; } catch { /* línea ajena */ }
      }
      if (code !== 0 && !Object.keys(res).length) {
        reject(new Error(`No pude transcribir: ${err.split('\n').filter((x) => x && !/Warning/.test(x)).slice(-2).join(' ').slice(0, 200)}`));
      } else resolve(res);
    });
    hijo.stdin.end(JSON.stringify(items));
  });
}

/* ------------------------------------------------------------------ */
/* adjuntos: archivo histórico + WhatsApp en vivo                      */
/* ------------------------------------------------------------------ */

/**
 * El archivo histórico se actualiza cada 6 h: un documento que llegó hace un
 * rato existe en la Mac (WhatsApp lo descarga solo) pero todavía no está ahí.
 * Antes, ver/exportar sólo miraban el archivo, así que pedir "el docx que me
 * mandaron recién" devolvía el último que sí estaba — otro archivo, más viejo.
 * Ahora se buscan los dos lados y se unen por id de mensaje.
 *
 * En la base viva: ZMESSAGETYPE 1 imagen, 2 video, 3 audio, 8 documento,
 * 11 gif, 15 sticker (7 son miniaturas de links: se ignoran). Para documentos,
 * ZTEXT es el NOMBRE ORIGINAL del archivo y ZTITLE el texto que lo acompaña.
 * ZMEDIALOCALPATH es relativo a <container>/Message/.
 */
const TIPO_VIVO = { 1: 'image', 2: 'video', 3: 'audio', 8: 'document', 11: 'gif', 15: 'sticker' };
const CODIGO_VIVO = Object.fromEntries(Object.entries(TIPO_VIVO).map(([k, v]) => [v, Number(k)]));

async function adjuntosEnVivo({ jid, chatTexto, tipos, contiene, desde, hasta, limite }) {
  const container = path.dirname(await sourcePath());
  // Sin filtrar por ZMEDIALOCALPATH: un adjunto que WhatsApp no descargó (los grandes no se bajan
  // solos) tiene que aparecer como tal. Si se descarta en silencio, el modelo inventa un motivo.
  const w = [];
  const codigos = tipos.map((t) => CODIGO_VIVO[t]).filter(Boolean);
  w.push(`m.ZMESSAGETYPE IN (${codigos.join(', ')})`);
  if (jid) {
    const lista = (await variantes(jid)).map(sqlString).join(', ');
    w.push(`(s.ZCONTACTJID IN (${lista}) OR s.ZCONTACTIDENTIFIER IN (${lista}))`);
  }
  else if (chatTexto) w.push(`lower(s.ZPARTNERNAME) LIKE ${sqlString(`%${likeLiteral(chatTexto.toLowerCase())}%`)} ESCAPE '\\'`);
  if (contiene) {
    w.push(`lower(coalesce(m.ZTEXT, '') || ' ' || coalesce(mi.ZTITLE, '')) LIKE ${sqlString(`%${likeLiteral(String(contiene).toLowerCase())}%`)} ESCAPE '\\'`);
  }
  if (desde) w.push(`m.ZMESSAGEDATE >= ${toEpoch(desde, 'desde') - APPLE_EPOCH}`);
  if (hasta) w.push(`m.ZMESSAGEDATE < ${toEpoch(hasta, 'hasta') - APPLE_EPOCH}`);
  const filas = await runLiveSQL(
    `SELECT m.ZSTANZAID AS message_id, CAST(m.ZMESSAGEDATE + ${APPLE_EPOCH} AS INTEGER) AS ts,` +
    ` strftime('%Y-%m-%d %H:%M', m.ZMESSAGEDATE + ${APPLE_EPOCH}, 'unixepoch', 'localtime') AS timestamp,` +
    ` m.ZISFROMME AS from_me, m.ZMESSAGETYPE AS codigo, m.ZTEXT AS text, mi.ZTITLE AS media_title,` +
    ` mi.ZMEDIALOCALPATH AS ruta_rel, s.ZPARTNERNAME AS chat_name, s.ZCONTACTJID AS chat_jid,` +
    ` gm.ZCONTACTNAME AS member_name, gm.ZMEMBERJID AS member_jid, mi.ZFILESIZE AS bytes` +
    ` FROM ZWAMESSAGE m JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM` +
    ` JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER` +
    ` WHERE ${w.join(' AND ')} ORDER BY m.ZMESSAGEDATE DESC LIMIT ${limite}`
  );
  return filas.map((f) => ({
    message_id: f.message_id, ts: f.ts, timestamp: f.timestamp, from_me: f.from_me,
    message_type: TIPO_VIVO[f.codigo], text: f.text, media_title: f.media_title,
    media_path: f.ruta_rel ? path.join(container, 'Message', f.ruta_rel) : null,
    descargado: Boolean(f.ruta_rel), bytes: f.bytes,
    chat_name: f.chat_name, chat_jid: f.chat_jid,
    // senderLabel: en un grupo, el miembro; en un DM, la contraparte del chat
    sender_name: f.member_name || null, sender_jid: f.member_jid || f.chat_jid,
  }));
}

/** Adjuntos del archivo histórico Y de WhatsApp en vivo, unidos, del más nuevo al más viejo. */
async function buscarAdjuntos({ chat, tipos, contiene, desde, hasta, limite }) {
  let jid = null;
  let chatTexto = null;
  if (chat) {
    try {
      jid = await resolveChatJID(chat);
    } catch (err) {
      // Un chat nuevo puede no estar todavía en el archivo: se busca por nombre en vivo.
      if (!/No encontré/.test(err.message)) throw err;
      chatTexto = String(chat).trim();
    }
  }

  let archivo = [];
  if (!chatTexto) {
    const where = await commonFilters({ chat: jid, desde, hasta });
    where.push(`m.media_path IS NOT NULL AND m.media_path <> ''`);
    where.push(`m.message_type IN (${tipos.map(sqlString).join(', ')})`);
    if (contiene) {
      const c = sqlString(`%${likeLiteral(String(contiene).toLowerCase())}%`);
      where.push(`(lower(coalesce(m.text, '')) LIKE ${c} ESCAPE '\\' OR lower(coalesce(m.media_title, '')) LIKE ${c} ESCAPE '\\')`);
    }
    archivo = await selectMessages('messages m', where.join(' AND '), 'DESC', limite);
  }

  let vivo = [];
  let avisoVivo = null;
  try {
    vivo = await adjuntosEnVivo({ jid, chatTexto, tipos, contiene, desde, hasta, limite });
  } catch (err) {
    avisoVivo = `No pude mirar WhatsApp en vivo (${err.message.slice(0, 100)}): puede faltar lo que llegó en las últimas horas.`;
  }

  // Si el archivo tiene su copia en disco, se usa esa (no depende de permisos de macOS).
  const porId = new Map(vivo.map((r) => [r.message_id, r]));
  for (const r of archivo) {
    if (r.media_path && fs.existsSync(r.media_path)) porId.set(r.message_id, r);
    else if (!porId.has(r.message_id)) porId.set(r.message_id, r);
  }
  const filas = [...porId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { filas, avisoVivo, chatNoEncontrado: chatTexto && !filas.length ? chatTexto : null };
}

const tamano = (b) => !b ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

/** Aviso para un adjunto que existe en el chat pero WhatsApp Desktop no descargó. */
function avisoNoDescargado(m) {
  const nombre = nombreOriginal(m) || m.text || TIPOS[m.message_type] || 'archivo';
  const peso = m.bytes ? `, ${tamano(m.bytes)}` : '';
  return `${m.timestamp} [${m.chat_name}] «${nombre}»${peso}: WhatsApp Desktop NO lo descargó` +
    `${m.bytes > 1e8 ? ' (los archivos grandes no se bajan solos)' : ''}. No es un problema de atraso ni de sync:` +
    ` hay que abrir ese chat en WhatsApp Desktop y tocar el archivo para descargarlo; apenas termine, ya se puede leer/exportar.`;
}

/** Nombre original de un documento (WhatsApp lo guarda), o null si no es un nombre de archivo. */
function nombreOriginal(m) {
  // En documentos, ese campo es el título del archivo (el texto que lo acompaña va en media_title).
  // A veces WhatsApp lo guarda SIN extensión ("Informe trimestral - final"): se le agrega la real.
  const t = String(m.text || '').trim();
  if (m.message_type !== 'document' || !t || looksLikeBlob(t) || t.length > 150 || /\n/.test(t)) return null;
  if (/\.[A-Za-z0-9]{2,5}$/.test(t)) return t;
  const ext = m.media_path && fs.existsSync(m.media_path) ? extensionDe(m.media_path) : '';
  return ext ? `${t}${ext}` : t;
}

/* ------------------------------------------------------------------ */
/* SQL helpers                                                         */
/* ------------------------------------------------------------------ */

/** Literal SQL entrecomillado. Duplica las comillas simples. */
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Escapa los comodines de LIKE para que la búsqueda sea literal (ESCAPE '\'). */
const likeLiteral = (value) => String(value).replace(/([\\%_])/g, '\\$1');

/** Query FTS5 como frase literal: entre comillas dobles, duplicando las internas. */
const ftsPhrase = (value) => `"${String(value).replace(/"/g, '""')}"`;

/** Convierte YYYY-MM-DD o RFC3339 a epoch en segundos. */
function toEpoch(value, label) {
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`\`${label}\` no es una fecha válida: "${value}". Usá YYYY-MM-DD o RFC3339.`);
  }
  return Math.floor(ms / 1000);
}

function clampLimit(limit, fallback, max) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(n, 1), max);
}

/**
 * El archivo guarda la misma conversación más de una vez (mismo msg_id con
 * distinto source_pk), así que agrupamos siempre — y antes del LIMIT, o los
 * conteos salen ~3x inflados y el limit devuelve de menos.
 */
const GROUPING = 'GROUP BY m.msg_id, m.chat_jid, m.ts, m.text';

const MSG_COLUMNS =
  `m.msg_id AS message_id, m.chat_jid, m.chat_name, m.sender_name, m.sender_jid,` +
  ` m.from_me, m.text, m.message_type, m.media_title, m.media_path, m.ts,` +
  // Hora LOCAL de esta Mac. En UTC los mensajes de la noche caen al día
  // siguiente y todo se lee corrido.
  ` strftime('%Y-%m-%d %H:%M', m.ts, 'unixepoch', 'localtime') AS timestamp`;

async function countDistinct(from, clause) {
  const partes = await Promise.all(enAmbos((tramo) =>
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${from} WHERE (${clause})${tramo} ${GROUPING})`));
  return partes.reduce((total, [row]) => total + (row?.n ?? 0), 0);
}

async function selectMessages(from, clause, order, limit) {
  const partes = await Promise.all(enAmbos((tramo) =>
    `SELECT ${MSG_COLUMNS} FROM ${from} WHERE (${clause})${tramo} ${GROUPING} ORDER BY m.ts ${order} LIMIT ${limit}`));
  if (partes.length === 1) return partes[0];
  const filas = partes.flat().sort((a, b) => (order === 'ASC' ? a.ts - b.ts : b.ts - a.ts));
  return filas.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* dominio                                                             */
/* ------------------------------------------------------------------ */

// Ojo con `chats.last_message_at`: hay filas con fechas corruptas (año 9026)
// que encabezarían cualquier orden por fecha. Usamos max(m.ts) de los mensajes
// reales, que no puede mentir.
const chatsSQL = (tramo) =>
  `SELECT c.jid, c.kind, c.name, c.unread_count,` +
  ` count(m.rowid) AS message_count,` +
  ` max(m.ts) AS last_ts` +
  ` FROM chats c LEFT JOIN messages m ON m.chat_jid = c.jid AND m.deleted_at IS NULL${tramo}` +
  ` WHERE c.deleted_at IS NULL`;

const ORDERS = {
  recientes: (a, b) => (b.last_ts || 0) - (a.last_ts || 0),
  mensajes: (a, b) => b.message_count - a.message_count,
};

/**
 * La misma persona puede tener dos JID: WhatsApp pasó muchos contactos al "@lid" nuevo (Desktop
 * ya los guarda así) y el iPhone o los chats viejos los tienen con el número. Sin unirlos, un chat
 * sale dos veces y buscarlo por nombre da "ambiguo". `contacts.lid` de cada archivo da el par.
 */
let aliasCache = null;

async function aliasesLid() {
  if (aliasCache && Date.now() - aliasCache.t < 10 * 60 * 1000) return aliasCache.mapa;
  const sql = `SELECT jid, lid FROM contacts WHERE lid LIKE '%@lid' AND jid LIKE '%@s.whatsapp.net'`;
  const h = historico();
  const filas = (await Promise.all([runSQL(sql), h ? runSQL(sql, h.db) : []])).flat();
  const mapa = new Map();
  for (const { jid, lid } of filas) { mapa.set(lid, jid); mapa.set(jid, lid); }
  aliasCache = { t: Date.now(), mapa };
  return mapa;
}

/** Los JID con que puede aparecer un chat: el dado y, si lo hay, su par @lid ⇄ número. */
async function variantes(jid) {
  const par = (await aliasesLid()).get(jid);
  return par ? [jid, par] : [jid];
}

/**
 * Los conteos por chat del histórico se calculan UNA vez y quedan en historico/chats.json: es una
 * foto fija y la consulta tarda ~15 s, lo mismo que la del principal. Repetirla duplicaba lo que
 * tarda listar_chats, y precalentarla al arrancar trababa la primera consulta de cada sesión.
 */
let chatsHistorico = null;

function chatsDelHistorico(h) {
  if (chatsHistorico?.corte === h.corte) return chatsHistorico.promesa;
  const archivo = path.join(HISTORICO_DIR, 'chats.json');
  let promesa;
  try {
    const guardado = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    if (guardado.corte !== h.corte) throw new Error('es de otra importación');
    promesa = Promise.resolve(guardado.chats);
  } catch {
    promesa = runSQL(`${chatsSQL(` AND m.ts < ${h.corte}`)} GROUP BY c.jid`, h.db).then((chats) => {
      try { fs.writeFileSync(archivo, JSON.stringify({ corte: h.corte, chats })); } catch {}
      return chats;
    });
    promesa.catch(() => { chatsHistorico = null; });
  }
  chatsHistorico = { corte: h.corte, promesa };
  return promesa;
}

/** Chats de los dos archivos unidos por persona. `nombre` (en minúsculas) filtra por subcadena. */
async function queryChats(nombre = null) {
  const h = historico();
  const filtro = nombre ? ` AND lower(c.name) LIKE ${sqlString(`%${likeLiteral(nombre)}%`)} ESCAPE '\\'` : '';
  const [principal, viejos, alias] = await Promise.all([
    runSQL(`${chatsSQL(h ? ` AND m.ts >= ${h.corte}` : '')}${filtro} GROUP BY c.jid`),
    h ? chatsDelHistorico(h) : [],
    aliasesLid(),
  ]);
  const partes = [principal, nombre ? viejos.filter((c) => (c.name || '').toLowerCase().includes(nombre)) : viejos];
  const clave = (jid) => (jid.endsWith('@lid') && alias.get(jid)) || jid;
  const porJid = new Map();
  partes.forEach((filas, i) => {
    for (const c of filas) {
      const previo = porJid.get(clave(c.jid));
      // Los no leídos del histórico son de la foto del iPhone, no de hoy.
      if (!previo) { porJid.set(clave(c.jid), i === 0 ? { ...c } : { ...c, unread_count: 0 }); continue; }
      previo.unread_count += i === 0 ? c.unread_count : 0;
      previo.message_count += c.message_count;
      previo.last_ts = Math.max(previo.last_ts || 0, c.last_ts || 0) || null;
      previo.name ||= c.name;   // el principal va primero y tiene el nombre actual
    }
  });
  return [...porJid.values()].map((c) => ({
    ...c,
    last_message_at: c.last_ts ? new Date(c.last_ts * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null,
  }));
}

const listChats = async (orden = 'recientes') =>
  (await queryChats()).sort(ORDERS[orden] || ORDERS.recientes);

/** Resuelve un nombre de chat a su JID. Si ya es un JID, lo devuelve tal cual. */
async function resolveChatJID(chat) {
  const value = String(chat).trim();
  if (value.includes('@')) return value;

  const needle = value.toLowerCase();
  const rows = (await queryChats(needle)).sort(ORDERS.mensajes);

  if (rows.length === 0) {
    throw new Error(
      `No encontré ningún chat que coincida con "${value}". Puede estar agendado con un apodo o sólo con el nombre: ` +
      `probá con una parte (el apellido, el nombre de pila), usá listar_chats con un filtro, o preguntale al usuario cómo lo tiene agendado. ` +
      `No adivines cuál es: si hay dudas, preguntá.`
    );
  }

  // Los chats de estados (las historias, *@*.status) tienen el mismo nombre que la persona pero no son
  // una conversación: si hay otro candidato, no cuentan. Sin esto "Juan Pérez" era "ambiguo".
  const conversaciones = rows.filter((c) => c.kind !== 'status' && !String(c.jid).endsWith('.status'));
  const pool = conversaciones.length ? conversaciones : rows;
  const exact = pool.filter((c) => (c.name || '').toLowerCase() === needle);
  const candidates = exact.length ? exact : pool;
  if (candidates.length === 1) return candidates[0].jid;

  const top = candidates.slice(0, 10).map((c) => `  • ${c.name} — ${c.jid} (${c.message_count} mensajes)`);
  throw new Error(
    `"${value}" coincide con ${candidates.length} chats. Volvé a llamar con el JID exacto:\n${top.join('\n')}` +
    (candidates.length > 10 ? `\n  … y ${candidates.length - 10} más` : '')
  );
}

/**
 * En ~21% de los mensajes recibidos en grupos el remitente no quedó resuelto:
 * `sender_jid` es el JID del grupo y `sender_name` un blob base64 tipo "IAA=".
 * No hay de dónde recuperar la identidad (contacts.lid no matchea), así que lo
 * decimos explícitamente en vez de mostrar el blob como si fuera un nombre.
 */
// Dos formas en que se filtran identificadores internos como si fueran texto:
// base64 con "=" de padding (nombres de remitente, hashes de media) y hex largo
// en mayúsculas (las reacciones). Ningún mensaje real se ve así.
const looksLikeBlob = (value) => {
  const v = String(value).trim();
  return /^[A-Za-z0-9+/]{2,}={1,2}$/.test(v) || /^[0-9A-F]{16,}$/.test(v);
};

function senderLabel(m) {
  if (m.from_me) return 'Yo';
  const name = m.sender_name;
  if (name && !looksLikeBlob(name)) return name;

  // En un DM el remitente es, por definición, la contraparte del chat: aunque
  // el nombre venga como blob, sabemos perfectamente quién es. Lo mismo vale
  // para un estado: lo publicó el dueño del chat.
  if (esEstado(m)) return m.chat_name || 'alguien';
  if (m.sender_jid && m.sender_jid === m.chat_jid) return m.chat_name || m.sender_jid;

  // En grupos sólo queda el @lid opaco. Lo mostramos igual porque es estable
  // por persona: permite ver que dos mensajes son del mismo desconocido.
  return m.sender_jid ? `(no identificado · ${m.sender_jid})` : '(remitente no identificado)';
}

/** Etiqueta legible por tipo, para lo que no es texto. */
const TIPOS = {
  audio: 'audio', sticker: 'sticker', image: 'imagen', video: 'video',
  document: 'documento', location: 'ubicación', contact: 'contacto',
  reaction: 'reacción', system: 'mensaje de sistema', group_event: 'evento de grupo',
};

/**
 * OJO: en audios, stickers e imágenes wacrawl mete el HASH del archivo en el
 * campo `text`. Mostrarlo tal cual hacía que un audio y un sticker se vieran
 * exactamente igual — un blob base64 indistinguible. Si el texto es un blob,
 * mandamos el tipo.
 */
function messageBody(m) {
  if (m.message_type === 'audio' && m.transcripcion !== undefined) {
    return m.transcripcion ? `(audio) «${m.transcripcion}»` : '(audio sin voz detectable)';
  }
  const texto = m.text ? String(m.text).trim() : '';
  if (texto && !looksLikeBlob(texto)) return texto;

  const tipo = TIPOS[m.message_type] || m.message_type || 'sin texto';
  const titulo = m.media_title && !looksLikeBlob(m.media_title) ? `: ${m.media_title}` : '';
  return `(${tipo}${titulo})`;
}

/**
 * Los estados (las historias de 24h) vienen mezclados con los mensajes y se ven
 * igual que un DM, aunque no te los mandaron a vos: se publican para todos los
 * contactos. WhatsApp los marca con la dirección reservada `status@broadcast`,
 * así que no hay que adivinar nada — sólo mostrarlo.
 */
const esEstado = (m) => String(m.sender_jid || '').includes('status@broadcast');

function formatMessages(rows, { withChat }) {
  if (rows.length === 0) return 'Sin resultados.';
  return rows
    .map((m) => {
      const where = withChat ? ` [${m.chat_name || m.chat_jid}]` : '';
      const marca = esEstado(m) ? ' [estado]' : '';
      return `${m.timestamp || '?'}${where}${marca} ${senderLabel(m)}: ${messageBody(m)}`;
    })
    .join('\n');
}

/**
 * Compara el archivo contra WhatsApp Desktop EN VIVO y avisa si quedó atrás.
 *
 * `wacrawl doctor` lee la fuente real en ~1s, así que siempre podemos saber
 * cuánto nos falta — aunque traerlo cueste un sync completo de ~5min y por eso
 * no se pueda hacer dentro de un tool call.
 */
async function freshnessNote() {
  let archivo;
  try {
    const [row] = await runSQL(`SELECT max(ts) AS t FROM messages WHERE deleted_at IS NULL`);
    archivo = row?.t;
  } catch {
    return '';
  }
  if (!archivo) return '';

  let fuente;
  try {
    const doc = JSON.parse(await runWacrawl(['--sync', 'never', 'doctor']));
    fuente = Date.parse(doc?.desktop?.newest_message) / 1000;
  } catch {
    return '';
  }
  if (!Number.isFinite(fuente)) return '';

  const minutos = Math.round((fuente - archivo) / 60);
  if (minutos < 15) return '';

  const desfasaje = minutos < 120 ? `${minutos} min` : `${Math.round(minutos / 60)} h`;
  return (
    `\n\n⚠️ El archivo está ${desfasaje} atrás de WhatsApp: hay mensajes más nuevos que todavía no entraron` +
    ` (el sync corre cada 6h y tarda ~5 min, no se puede hacer al vuelo).` +
    ` Para lo de último momento, mirá WhatsApp directamente.`
  );
}

/** Filtros comunes a las búsquedas. */
async function commonFilters({ chat, desde, hasta, de_mi }) {
  const where = ['m.deleted_at IS NULL'];
  if (chat) where.push(`m.chat_jid IN (${(await variantes(await resolveChatJID(chat))).map(sqlString).join(', ')})`);
  if (desde) where.push(`m.ts >= ${toEpoch(desde, 'desde')}`);
  if (hasta) where.push(`m.ts < ${toEpoch(hasta, 'hasta')}`);
  if (typeof de_mi === 'boolean') where.push(`m.from_me = ${de_mi ? 1 : 0}`);
  return where;
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

/**
 * Guía a nivel servidor (campo `instructions` del handshake MCP). Es el lugar
 * formal para lo que no cabe en la descripción de cada tool: cómo interpretar
 * los datos y cuándo NO confiar en ellos. Las cifras salen de medir este
 * archivo, no de estimaciones.
 */
const SERVER_INSTRUCTIONS = `Acceso al WhatsApp local del usuario: un archivo histórico (sólo lectura) más WhatsApp Desktop en vivo. Cómo interpretar los resultados:

PROFUNDIDAD: __PROFUNDIDAD__ Si no encontrás algo viejo, decí que no está en el archivo local — no que no existe.

FRESCURA: el archivo se sincroniza cada 6h y un sync tarda minutos, así que NO se puede refrescar durante una consulta. Las tools avisan cuando detectan mensajes más nuevos sin importar. Para "¿me contestó recién?" usá mensajes_recientes, que lee WhatsApp en vivo.

QUIÉN DIJO QUÉ: en chats individuales la atribución es confiable. En grupos, muchos mensajes de gente no agendada aparecen como "(no identificado · <jid>@lid)": WhatsApp no guarda su nombre. Ese lid es estable por persona (sirve para saber que dos mensajes son del mismo desconocido) pero NO para ponerle nombre. Nunca inventes de quién es un mensaje así, ni lo atribuyas al dueño del chat. Los "[estado]" son historias publicadas, no mensajes dirigidos al usuario.

BÚSQUEDA: usá buscar_whatsapp primero (índice full-text, palabras completas). Si devuelve poco o nada, reintentá con busqueda_profunda, que matchea subcadenas. Los conteos son exactos sobre todo el archivo; los mensajes mostrados están topeados por 'limit', así que una síntesis de un período largo sale de una MUESTRA — decilo en vez de presentarla como completa. Si un nombre no aparece, la persona puede estar agendada con un apodo: preguntá, no adivines.

ADJUNTOS: imágenes, PDFs y documentos Word se pueden MIRAR/LEER con ver_archivos y SACAR a una carpeta con exportar_archivo. Estas dos tools miran WhatsApp EN VIVO: los adjuntos NO tienen las 6 h de atraso del archivo — nunca uses el atraso como explicación de por qué falta un adjunto. Si una tool dice que un adjunto NO está descargado, decíselo así al usuario: tiene que abrir el chat en WhatsApp Desktop y tocar el archivo (los grandes no se bajan solos); esperar no lo resuelve. __ARCHIVOS__ AUDIOS: si la transcripción local está instalada, las notas de voz aparecen como (audio) «texto» y también salen en las búsquedas (sección "En audios"). Es transcripción automática con Whisper: el sentido es confiable, pero los nombres propios y términos en inglés pueden salir mal — no los cites como exactos. Al buscar un NOMBRE en audios, si hay pocos resultados probá también cómo suena mal escrito (ej. "Viatik" → "viatic", "Lucho" → "lucio"): la transcripción falla justo en los nombres poco comunes. Si un audio aparece como "(audio)" sin texto, todavía no se transcribió: usá transcribir_audios. "(audio sin voz detectable)" es silencio o ruido.

ESCRITURA: enviar_mensaje ENVÍA de verdad (si el usuario lo activó en esta Mac). Usala sólo cuando el usuario pidió explícitamente mandar/enviar, mostrándole antes destinatario y texto exacto; si dice redactar o preparar, usá preparar_mensaje. Nunca reintentes un envío que respondió \"no pude confirmar\". Para borradores: preparar_mensaje (uno) o cola_mensajes (varios; abre el siguiente cuando detecta que el usuario mandó el anterior). Abre WhatsApp con el texto escrito y el usuario decide si lo manda. Para varios mensajes usá SIEMPRE cola_mensajes, nunca varios preparar_mensaje seguidos: WhatsApp pierde el borrador anterior al abrir otro chat. Con preparar_mensaje y cola_mensajes nunca digas que enviaste algo: decí que quedó listo para que lo revise y lo mande. Sólo enviar_mensaje con respuesta \"✓ Enviado\" es un envío. Si una barrera bloquea un borrador (límite, texto repetido, STOP), explicá el motivo; no intentes esquivarla reformulando el texto o cambiando el destinatario.`;

const TOOLS = [
  {
    name: 'buscar_whatsapp',
    description:
      'Busca texto en el archivo local de mensajes de WhatsApp usando el índice full-text. Rápido; es la búsqueda por defecto. Matchea palabras completas — si buscás fragmentos o no aparece lo que esperabas, usá busqueda_profunda.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar (se busca como frase).' },
        chat: { type: 'string', description: 'Opcional: limitar a un chat, por nombre o por JID.' },
        desde: { type: 'string', description: 'Opcional: sólo mensajes posteriores. YYYY-MM-DD o RFC3339.' },
        hasta: { type: 'string', description: 'Opcional: sólo mensajes anteriores. YYYY-MM-DD o RFC3339.' },
        de_mi: { type: 'boolean', description: 'Opcional: true = sólo míos, false = sólo recibidos. Omitir para ambos.' },
        limit: { type: 'integer', description: 'Máximo de mensajes a mostrar (default 50, máx 500).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'listar_chats',
    description:
      'Lista los chats archivados (individuales y grupos), con la fecha del último mensaje, cantidad de mensajes y no leídos. Por defecto ordena por actividad más reciente, así que sirve para responder "mis últimas conversaciones". Con `filtro`, sólo los que contienen ese texto en el nombre.',
    inputSchema: {
      type: 'object',
      properties: {
        filtro: { type: 'string', description: 'Opcional: subcadena a buscar en el nombre del chat (case-insensitive).' },
        orden: {
          type: 'string',
          enum: ['recientes', 'mensajes'],
          description: '`recientes` (default) = los de actividad más reciente primero. `mensajes` = los de más mensajes primero.',
        },
        solo_no_leidos: { type: 'boolean', description: 'Opcional: sólo chats con mensajes sin leer.' },
        limit: { type: 'integer', description: 'Máximo de chats a devolver (default 100, máx 2000).' },
      },
    },
  },
  {
    name: 'busqueda_profunda',
    description:
      'Búsqueda exhaustiva por subcadena sobre TODOS los mensajes, sin usar el índice full-text. Más lenta que buscar_whatsapp pero encuentra coincidencias parciales dentro de palabras. Usala cuando buscar_whatsapp devuelve poco, o para contar/barrer todo.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar. Por defecto se busca como frase literal (case-insensitive).' },
        todas_las_palabras: {
          type: 'boolean',
          description: 'Si es true, busca mensajes que contengan TODAS las palabras de `query` en cualquier orden, en vez de la frase exacta.',
        },
        chat: { type: 'string', description: 'Opcional: limitar a un chat, por nombre o por JID.' },
        desde: { type: 'string', description: 'Opcional: sólo mensajes posteriores. YYYY-MM-DD o RFC3339.' },
        hasta: { type: 'string', description: 'Opcional: sólo mensajes anteriores. YYYY-MM-DD o RFC3339.' },
        de_mi: { type: 'boolean', description: 'Opcional: true = sólo míos, false = sólo recibidos. Omitir para ambos.' },
        limit: { type: 'integer', description: 'Máximo de mensajes a mostrar (default 50, máx 500). El total de coincidencias se informa igual.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mensajes_recientes',
    description:
      'Lee los mensajes MÁS NUEVOS directamente de WhatsApp Desktop, en vivo (incluye lo que llegó hace segundos). Usala para "¿me contestó?", "qué me llegó recién", "últimos mensajes de este chat". Las otras tools leen el archivo, que va hasta 6h atrás; esta no. A cambio no tiene búsqueda full-text ni historial profundo.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Opcional: limitar a un chat por nombre (subcadena, case-insensitive). Sin esto, trae lo último de todos los chats.' },
        minutos: { type: 'integer', description: 'Opcional: sólo mensajes de los últimos N minutos.' },
        solo_recibidos: { type: 'boolean', description: 'Opcional: true = sólo lo que me mandaron, ignorando lo que escribí yo.' },
        limit: { type: 'integer', description: 'Máximo de mensajes (default 30, máx 200).' },
      },
    },
  },
  {
    name: 'ver_archivos',
    description:
      'Muestra las imágenes y documentos que se mandaron en un chat, para poder MIRARLOS o LEERLOS (no sólo saber que existen). Word, RTF, OpenDocument y texto se devuelven como texto completo. Los PDF se ven como imagen de su primera página. Incluye lo que llegó hace minutos (mira WhatsApp en vivo, no sólo el archivo). Sólo existen los archivos que hay en esta Mac: los que WhatsApp Desktop descargó desde que se vinculó, y los del histórico del iPhone si se importó.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Opcional: limitar a un chat, por nombre o por JID.' },
        tipo: { type: 'string', enum: ['imagen', 'documento', 'todos'], description: 'Qué traer. Default: todos.' },
        contiene: { type: 'string', description: 'Opcional: parte del nombre del archivo o del texto que lo acompaña.' },
        desde: { type: 'string', description: 'Opcional: sólo posteriores. YYYY-MM-DD o RFC3339.' },
        hasta: { type: 'string', description: 'Opcional: sólo anteriores. YYYY-MM-DD o RFC3339.' },
        limit: { type: 'integer', description: 'Máximo de archivos (default 3, máx 10). Son imágenes: pedí pocas.' },
      },
    },
  },
  {
    name: 'exportar_archivo',
    description:
      'Copia un adjunto de WhatsApp a una carpeta normal (por defecto ~/Downloads), con su nombre original si es un documento, y devuelve la ruta, para poder USARLO. Incluye lo que llegó hace minutos (mira WhatsApp en vivo): subirlo, adjuntarlo, mandarlo a otra herramienta. Distinto de ver_archivos, que sólo permite mirarlo. Sirve para cualquier tipo de archivo, también los que no se pueden mostrar (videos, audios, planillas).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Opcional: limitar a un chat, por nombre o por JID.' },
        contiene: { type: 'string', description: 'Opcional: parte del NOMBRE del archivo (ej. "gacetilla") o del texto que lo acompaña.' },
        tipo: {
          type: 'string',
          enum: ['imagen', 'documento', 'audio', 'video', 'todos'],
          description: 'Qué tipo de adjunto. Default: todos.',
        },
        desde: { type: 'string', description: 'Opcional: sólo posteriores. YYYY-MM-DD o RFC3339.' },
        hasta: { type: 'string', description: 'Opcional: sólo anteriores. YYYY-MM-DD o RFC3339.' },
        destino: { type: 'string', description: 'Carpeta donde copiarlo. Default: ~/Downloads.' },
        limit: { type: 'integer', description: 'Máximo de archivos a exportar (default 1, máx 20).' },
      },
    },
  },
  {
    name: 'preparar_mensaje',
    description:
      'Abre WhatsApp Desktop en un chat individual con un mensaje YA ESCRITO en la caja de texto, listo para que el usuario lo revise y lo mande apretando Enter. NO ENVÍA NADA: sólo deja el borrador. Usala cuando el usuario pida redactar o preparar un mensaje para alguien. No sirve para grupos. Tiene límites duros (pocos por minuto/hora, y nunca el mismo texto a varios chats).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Destinatario: nombre del chat, JID, o número de teléfono con código de país.' },
        texto: { type: 'string', description: 'El mensaje a dejar escrito. Máx 2000 caracteres.' },
      },
      required: ['chat', 'texto'],
    },
  },
  {
    name: 'enviar_mensaje',
    description:
      'ENVÍA de verdad un mensaje de WhatsApp a un chat individual, desde la app oficial de la Mac, y verifica que haya salido. ' +
      'Usala SÓLO si el usuario pidió explícitamente ENVIAR/MANDAR (no "redactar" ni "preparar": para eso es preparar_mensaje) ' +
      'y después de mostrarle el texto exacto y el destinatario. No sirve para grupos. Si responde que no pudo confirmar el envío, ' +
      'NO la vuelvas a llamar con el mismo mensaje: puede haber salido igual; pedile al usuario que mire WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Destinatario: nombre del chat, JID, o número con código de país.' },
        texto: { type: 'string', description: 'El mensaje exacto a enviar. Máx 2000 caracteres.' },
      },
      required: ['chat', 'texto'],
    },
  },
  {
    name: 'cola_mensajes',
    description:
      'Para preparar VARIOS mensajes seguidos. Abre el primer borrador en WhatsApp y, cada vez que detecta que el usuario lo mandó, abre el siguiente solo. NO ENVÍA NADA: cada mensaje lo manda el usuario con Enter, a su ritmo. Si no manda uno en 10 min, la cola se pausa. Acciones: crear (con la lista), estado, saltar (pasa al siguiente sin mandar el actual), reanudar, cancelar. Para un único mensaje usá preparar_mensaje.',
    inputSchema: {
      type: 'object',
      properties: {
        accion: { type: 'string', enum: ['crear', 'estado', 'saltar', 'reanudar', 'cancelar'] },
        mensajes: {
          type: 'array',
          description: 'Sólo para crear: lista de {chat, texto}, en el orden en que se van a abrir.',
          items: {
            type: 'object',
            properties: { chat: { type: 'string' }, texto: { type: 'string' } },
            required: ['chat', 'texto'],
          },
        },
      },
      required: ['accion'],
    },
  },
  {
    name: 'transcribir_audios',
    description:
      'Transcribe notas de voz que todavía no tienen texto, con Whisper corriendo en esta Mac (no sale nada de la computadora). Los audios ya transcriptos aparecen solos como (audio) «texto» en leer_chat y en las búsquedas: usá esto sólo si ves "(audio)" sin texto y hace falta saber qué dice. Tarda unos segundos por audio (más ~5 s la primera vez).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Opcional: audios de un chat, por nombre o JID.' },
        desde: { type: 'string', description: 'Opcional: sólo posteriores. YYYY-MM-DD o RFC3339.' },
        hasta: { type: 'string', description: 'Opcional: sólo anteriores. YYYY-MM-DD o RFC3339.' },
        limit: { type: 'integer', description: 'Máximo de audios (default 5, máx 15), los más recientes.' },
      },
    },
  },
  {
    name: 'leer_chat',
    description:
      'Lee los mensajes de un chat en orden cronológico (del más viejo al más nuevo), con remitente y fecha.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Nombre del chat o JID.' },
        desde: { type: 'string', description: 'Opcional: sólo mensajes posteriores. YYYY-MM-DD o RFC3339.' },
        hasta: { type: 'string', description: 'Opcional: sólo mensajes anteriores. YYYY-MM-DD o RFC3339.' },
        limit: { type: 'integer', description: 'Máximo de mensajes (default 100, máx 1000).' },
      },
      required: ['chat'],
    },
  },
];

const handlers = {
  async buscar_whatsapp({ query, chat, desde, hasta, de_mi, limit }) {
    if (!query || !String(query).trim()) throw new Error('`query` es obligatorio.');
    const max = clampLimit(limit, 50, 500);

    const from = 'messages_fts f JOIN messages m ON m.rowid = f.rowid';
    const jid = chat ? await resolveChatJID(chat) : null;
    const where = await commonFilters({ chat: jid, desde, hasta, de_mi });
    where.push(`messages_fts MATCH ${sqlString(ftsPhrase(String(query).trim()))}`);
    const clause = where.join(' AND ');

    const total = await countDistinct(from, clause);
    const rows = await adjuntarTranscripciones(await selectMessages(from, clause, 'DESC', max));
    const audios = await buscarEnAudios({ terms: [String(query).trim()], jid, desde, hasta, de_mi, limite: Math.min(max, 20) });

    const scope = chat ? ` en ${chat}` : '';
    const shown = total > rows.length ? ` (mostrando ${rows.length})` : '';
    const hint = total === 0 && !audios?.total ? '\n\nSugerencia: probá busqueda_profunda, que busca subcadenas y suele encontrar más.' : '';
    return `${total} mensaje(s) para "${query}"${scope}${shown}:\n\n${formatMessages(rows, { withChat: true })}${seccionAudios(audios)}${hint}${await freshnessNote()}`;
  },

  async listar_chats({ filtro, orden, solo_no_leidos, limit }) {
    const max = clampLimit(limit, 100, 2000);
    const modo = orden === 'mensajes' ? 'mensajes' : 'recientes';

    let chats = await listChats(modo);
    if (filtro) {
      const needle = String(filtro).toLowerCase();
      chats = chats.filter((c) => (c.name || '').toLowerCase().includes(needle));
    }
    if (solo_no_leidos) chats = chats.filter((c) => c.unread_count > 0);

    const shown = chats.slice(0, max);
    if (shown.length === 0) return `Sin chats${filtro ? ` que coincidan con "${filtro}"` : ''}.`;

    const lines = shown.map((c) => {
      const kind = { group: 'grupo', dm: 'dm', status: 'estados', newsletter: 'canal' }[c.kind] || c.kind;
      const unread = c.unread_count ? `, ${c.unread_count} sin leer` : '';
      const last = c.last_message_at ? `último ${c.last_message_at}` : 'sin mensajes';
      return `• ${c.name || '(sin nombre)'} — ${kind} — ${last} — ${c.message_count} mensajes${unread} — ${c.jid}`;
    });
    const criterio = modo === 'mensajes' ? 'más mensajes primero' : 'actividad más reciente primero';
    const more = chats.length > shown.length ? `\n… y ${chats.length - shown.length} chats más.` : '';
    return (
      `${shown.length} de ${chats.length} chat(s)${filtro ? ` que coinciden con "${filtro}"` : ''}` +
      ` — ordenados por ${criterio}:\n\n${lines.join('\n')}${more}${await freshnessNote()}`
    );
  },

  async busqueda_profunda({ query, todas_las_palabras, chat, desde, hasta, de_mi, limit }) {
    if (!query || !String(query).trim()) throw new Error('`query` es obligatorio.');
    const max = clampLimit(limit, 50, 500);

    const terms = todas_las_palabras ? String(query).trim().split(/\s+/) : [String(query).trim()];
    const jid = chat ? await resolveChatJID(chat) : null;
    const where = await commonFilters({ chat: jid, desde, hasta, de_mi });
    where.push('m.text IS NOT NULL');
    for (const t of terms) {
      where.push(`lower(m.text) LIKE ${sqlString(`%${likeLiteral(t.toLowerCase())}%`)} ESCAPE '\\'`);
    }
    const clause = where.join(' AND ');

    const total = await countDistinct('messages m', clause);
    const rows = await adjuntarTranscripciones(await selectMessages('messages m', clause, 'DESC', max));
    const audios = await buscarEnAudios({ terms, jid, desde, hasta, de_mi, limite: Math.min(max, 20) });

    const modo = todas_las_palabras ? 'todas las palabras' : 'frase literal';
    const scope = chat ? ` en ${chat}` : '';
    const shown = total > rows.length ? ` (mostrando ${rows.length})` : '';
    return `${total} coincidencia(s) para "${query}"${scope} — ${modo}${shown}:\n\n${formatMessages(rows, { withChat: true })}${seccionAudios(audios)}${await freshnessNote()}`;
  },

  async mensajes_recientes({ chat, minutos, solo_recibidos, limit }) {
    const max = clampLimit(limit, 30, 200);

    // Texto, o adjuntos (imagen, video, audio, documento) aunque no tengan texto.
    const where = ['(m.ZTEXT IS NOT NULL OR m.ZMESSAGETYPE IN (1, 2, 3, 8))'];
    if (chat) {
      where.push(`lower(cs.ZPARTNERNAME) LIKE ${sqlString(`%${likeLiteral(String(chat).toLowerCase())}%`)} ESCAPE '\\'`);
    }
    if (Number.isFinite(minutos)) {
      const desde = Math.floor(Date.now() / 1000) - Math.floor(minutos) * 60 - APPLE_EPOCH;
      where.push(`m.ZMESSAGEDATE >= ${desde}`);
    }
    if (solo_recibidos) where.push('m.ZISFROMME = 0');

    const rows = await runLiveSQL(
      `SELECT strftime('%Y-%m-%d %H:%M', m.ZMESSAGEDATE + ${APPLE_EPOCH}, 'unixepoch', 'localtime') AS timestamp,` +
      ` cs.ZPARTNERNAME AS chat_name, m.ZISFROMME AS from_me,` +
      ` gm.ZCONTACTNAME AS member_name, gm.ZMEMBERJID AS member_jid,` +
      ` m.ZPUSHNAME AS push_name, m.ZFROMJID AS sender_jid, m.ZTEXT AS text, m.ZMESSAGETYPE AS codigo, mi.ZMEDIALOCALPATH AS ruta_rel, mi.ZFILESIZE AS bytes` +
      ` FROM ZWAMESSAGE m` +
      ` LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION` +
      ` LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER` +
      ` LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM` +
      ` WHERE ${where.join(' AND ')} ORDER BY m.ZMESSAGEDATE DESC LIMIT ${max}`
    );

    if (rows.length === 0) {
      return `Sin mensajes${chat ? ` en chats que coincidan con "${chat}"` : ''}${Number.isFinite(minutos) ? ` en los últimos ${minutos} min` : ''}.`;
    }

    // Mismo criterio que el archivo: en grupo mandan ZCONTACTNAME/JID del
    // miembro; en DM el remitente es la contraparte del chat.
    const lines = rows.map((m) => {
      const cuando = m.timestamp || '?';
      const donde = m.chat_name || '(chat sin nombre)';
      let quien;
      if (m.from_me) quien = 'Yo';
      else if (m.member_name && !looksLikeBlob(m.member_name)) quien = m.member_name;
      else if (m.member_jid) quien = `(no identificado · ${m.member_jid})`;
      else if (m.push_name && !looksLikeBlob(m.push_name)) quien = m.push_name;
      else quien = donde;
      const texto = String(m.text || '').trim();
      const legible = texto && !looksLikeBlob(texto) ? texto : '';
      // Un documento trae su nombre en ZTEXT: sin esto parecía un mensaje de texto.
      const tipo = { 1: 'imagen', 2: 'video', 3: 'audio', 8: 'documento' }[m.codigo];
      const bajado = m.ruta_rel ? 'se puede ver/exportar' : `${m.bytes ? tamano(m.bytes) + ', ' : ''}NO descargado en WhatsApp Desktop: hay que tocarlo ahí para bajarlo`;
      const cuerpo = tipo === 'documento' ? `(documento: ${legible || 'sin nombre'} — ${bajado})`
        : tipo ? `(${tipo})${legible ? ' ' + legible : ''}` : (legible || '(archivo adjunto)');
      return `${cuando} [${donde}] ${quien}: ${cuerpo}`;
    });

    return (
      `${rows.length} mensaje(s) EN VIVO desde WhatsApp Desktop` +
      `${chat ? ` en "${chat}"` : ''}${Number.isFinite(minutos) ? ` (últimos ${minutos} min)` : ''},` +
      ` del más nuevo al más viejo:\n\n${lines.join('\n')}`
    );
  },

  async ver_archivos({ chat, tipo, contiene, desde, hasta, limit }) {
    const max = clampLimit(limit, 3, 10);
    const tipos = tipo === 'imagen' ? ['image'] : tipo === 'documento' ? ['document'] : ['image', 'document'];
    const { filas: rows, avisoVivo, chatNoEncontrado } = await buscarAdjuntos({ chat, tipos, contiene, desde, hasta, limite: max * 3 });
    if (chatNoEncontrado) throw new Error(`No encontré ningún chat que coincida con "${chatNoEncontrado}", ni en el archivo ni en WhatsApp en vivo.`);

    const content = [];
    let mostrados = 0;
    const problemas = [];

    const sinDescargar = [];
    for (const m of rows) {
      if (mostrados >= max) break;
      if (m.descargado === false) { sinDescargar.push(avisoNoDescargado(m)); continue; }
      const ruta = m.media_path;
      if (!ruta || !fs.existsSync(ruta)) {
        problemas.push(`${m.timestamp} ${m.chat_name}: el archivo ya no está en disco`);
        continue;
      }
      const ext = extensionDe(ruta);
      if (EXT_TEXTO.has(ext)) {
        try {
          const texto = await textoDeDocumento(ruta);
          const nombre = nombreOriginal(m) ? ` «${nombreOriginal(m)}»` : '';
          content.push({
            type: 'text',
            text: `${m.timestamp} [${m.chat_name || m.chat_jid}] ${senderLabel(m)} — documento${nombre}, texto completo:\n\n${texto || '(el documento no tiene texto)'}\n\n— fin del documento —`,
          });
          mostrados += 1;
        } catch (err) {
          problemas.push(`${m.timestamp} ${m.chat_name}: no se pudo leer el ${ext} (${err.message.slice(0, 80)})`);
        }
        continue;
      }
      if (!EXT_SOPORTADAS.has(ext)) {
        problemas.push(`${m.timestamp} ${m.chat_name}: ${ext || 'formato desconocido'} no se puede mostrar (usá exportar_archivo)`);
        continue;
      }
      try {
        const data = await renderToJpeg(ruta);
        const que = m.message_type === 'document' ? 'documento (primera página)' : 'imagen';
        const nombre = nombreOriginal(m) ? ` «${nombreOriginal(m)}»` : '';
        const titulo = m.media_title && !looksLikeBlob(m.media_title) ? ` — "${String(m.media_title).trim().slice(0, 120)}"` : '';
        content.push({
          type: 'text',
          text: `${m.timestamp} [${m.chat_name || m.chat_jid}] ${senderLabel(m)} — ${que}${nombre}${titulo}`,
        });
        content.push({ type: 'image', data, mimeType: 'image/jpeg' });
        mostrados += 1;
      } catch (err) {
        problemas.push(`${m.timestamp} ${m.chat_name}: no se pudo convertir (${err.message.slice(0, 80)})`);
      }
    }

    if (mostrados === 0) {
      const detalle = (sinDescargar.length ? `\n\n${sinDescargar.join('\n')}` : '') +
        (problemas.length ? `\n\n${problemas.join('\n')}` : '') + (avisoVivo ? `\n\n${avisoVivo}` : '');
      return (
        `No hay archivos para mostrar${chat ? ` en "${chat}"` : ''}.` +
        ` ${queArchivosHay()}${detalle}`
      );
    }

    content.unshift({
      type: 'text',
      text: (sinDescargar.length ? `⚠️ Hay adjuntos más nuevos que coinciden pero NO están descargados:\n${sinDescargar.join('\n')}\n\n` : '') +
        `${mostrados} archivo(s)${chat ? ` de "${chat}"` : ''}, del más nuevo al más viejo:`,
    });
    if (problemas.length) {
      content.push({ type: 'text', text: `\nNo se pudieron mostrar:\n${problemas.join('\n')}` });
    }
    if (avisoVivo) content.push({ type: 'text', text: `\n${avisoVivo}` });
    return content;
  },

  async exportar_archivo({ chat, contiene, tipo, desde, hasta, destino, limit }) {
    const max = clampLimit(limit, 1, 20);
    const PORTIPO = {
      imagen: ['image'], documento: ['document'], audio: ['audio'], video: ['video'],
    };
    const tipos = PORTIPO[tipo] || ['image', 'document', 'audio', 'video', 'sticker'];

    const dir = destino
      ? path.resolve(destino.replace(/^~(?=$|\/)/, os.homedir()))
      : path.join(os.homedir(), 'Downloads');
    if (!fs.existsSync(dir)) {
      throw new Error(`La carpeta de destino no existe: ${dir}`);
    }

    const { filas: rows, avisoVivo, chatNoEncontrado } = await buscarAdjuntos({ chat, tipos, contiene, desde, hasta, limite: max * 3 });
    if (chatNoEncontrado) throw new Error(`No encontré ningún chat que coincida con "${chatNoEncontrado}", ni en el archivo ni en WhatsApp en vivo.`);

    const hechos = [];
    const fallados = [];

    const sinDescargar = [];
    for (const m of rows) {
      if (hechos.length >= max) break;
      if (m.descargado === false) { sinDescargar.push(avisoNoDescargado(m)); continue; }
      if (!m.media_path || !fs.existsSync(m.media_path)) {
        fallados.push(`${m.timestamp} ${m.chat_name}: el archivo no está en disco`);
        continue;
      }
      // Nombre legible: el archivo original es un UUID, y media_title no sirve
      // (a veces trae el texto del mensaje, a veces un blob base64).
      const limpio = (s) => String(s || '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const base = [
        (m.timestamp || '').replace(/[: ]/g, '-'),
        limpio(m.chat_name),
        limpio(senderLabel(m)),
      ].filter(Boolean).join('_');

      // Documentos: con su nombre ORIGINAL (WhatsApp lo guarda). El resto: fecha_chat_remitente.
      let ext = extensionDe(m.media_path);
      let raiz = base;
      const original = nombreOriginal(m);
      if (original) {
        const limpioArchivo = original.replace(/[\/:\0]/g, '-').trim();
        ext = path.extname(limpioArchivo) || ext;
        raiz = limpioArchivo.slice(0, limpioArchivo.length - path.extname(limpioArchivo).length);
      }
      let salida = path.join(dir, `${raiz}${ext}`);
      for (let i = 2; fs.existsSync(salida); i += 1) salida = path.join(dir, `${raiz} (${i})${ext}`);

      try {
        fs.copyFileSync(m.media_path, salida);
        const kb = Math.round(fs.statSync(salida).size / 1024);
        const acompana = original ? m.media_title : m.text;
        const contexto = acompana && !looksLikeBlob(acompana) ? `\n   mensaje: "${String(acompana).trim().slice(0, 120)}"` : '';
        hechos.push(
          `• ${salida}\n   ${kb} KB — ${m.timestamp} en "${m.chat_name}", de ${senderLabel(m)}${contexto}`
        );
      } catch (err) {
        fallados.push(`${m.timestamp} ${m.chat_name}: ${err.message.slice(0, 80)}`);
      }
    }

    if (hechos.length === 0) {
      if (sinDescargar.length) return sinDescargar.join('\n');
      return (
        (avisoVivo ? `${avisoVivo}\n\n` : '') +
        `No encontré ningún archivo para exportar${chat ? ` en "${chat}"` : ''}` +
        `${contiene ? ` que mencione "${contiene}"` : ''}.` +
        ` ${queArchivosHay()}` +
        (fallados.length ? `\n\n${fallados.join('\n')}` : '')
      );
    }

    return (
      // Si el más nuevo que coincide no está descargado, se dice PRIMERO: si no, el modelo
      // usa el archivo viejo que sí se exportó como si fuera el pedido.
      (sinDescargar.length ? `⚠️ El/los más nuevo(s) que coinciden NO están descargados — lo exportado abajo es OTRO archivo, más viejo:\n${sinDescargar.join('\n')}\n\n` : '') +
      `${hechos.length} archivo(s) copiado(s) a ${dir}. Verificá que fecha, chat y nombre sean los que pidió el usuario antes de usarlo:\n\n${hechos.join('\n')}` +
      (avisoVivo ? `\n\n${avisoVivo}` : '') +
      (fallados.length ? `\n\nNo se pudieron copiar:\n${fallados.join('\n')}` : '')
    );
  },

  async preparar_mensaje({ chat, texto }) {
    if (!chat || !String(chat).trim()) throw new Error('`chat` es obligatorio.');
    const cuerpo = String(texto || '').trim();
    if (!cuerpo) throw new Error('`texto` está vacío.');
    if (cuerpo.length > LIMITES.largoMax) {
      throw new Error(`El texto tiene ${cuerpo.length} caracteres; el máximo es ${LIMITES.largoMax}.`);
    }

    if (cola && cola.estado === 'activa') {
      throw new Error('Hay una cola de mensajes en curso: abrir otro borrador pisaría el que el usuario está por mandar. Esperá a que termine o cancelala con cola_mensajes.');
    }
    const destino = await telefonoDeChat(chat);
    const { nombre, conocido } = destino;

    const bloqueo = chequearBarreras(destino.telefono, cuerpo);
    if (bloqueo) throw new Error(bloqueo);

    await abrirBorrador(destino, cuerpo);

    const aviso = conocido
      ? ''
      : '\n\n⚠️ Nunca hablaste con este número. Verificá que sea el correcto antes de mandar.';
    return (
      `Abrí WhatsApp en el chat con "${nombre}" con el mensaje escrito.\n` +
      `NO se envió nada: el usuario lo revisa y aprieta Enter si está bien.${aviso}`
    );
  },

  async enviar_mensaje({ chat, texto }) {
    const lim = cargarLimites();
    if (!lim.permitirEnvio) {
      throw new Error(
        'El envío automático está desactivado en esta Mac (por defecto lo está). Mientras tanto usá preparar_mensaje, ' +
        'que deja el mensaje escrito para que el usuario lo mande. Para activarlo, el usuario pone "permitirEnvio": true en ~/.wacrawl/limites.json.'
      );
    }
    if (!chat || !String(chat).trim()) throw new Error('`chat` es obligatorio.');
    const cuerpo = String(texto || '').trim();
    if (!cuerpo) throw new Error('`texto` está vacío.');
    if (cuerpo.length > lim.largoMax) throw new Error(`El texto tiene ${cuerpo.length} caracteres; el máximo es ${lim.largoMax}.`);
    if (cola && cola.estado === 'activa') {
      throw new Error('Hay una cola de borradores en curso: enviar ahora pisaría el que el usuario está por mandar.');
    }

    const destino = await telefonoDeChat(chat);
    const bloqueo = chequearBarreras(destino.telefono, cuerpo, { enCola: 'envio' });
    if (bloqueo) throw new Error(bloqueo);

    const antes = Date.now();
    await abrirBorrador(destino, cuerpo, { envio: true });
    await sleep(1500);   // que WhatsApp abra el chat y ponga el texto

    // Un segundo Enter es seguro: si el primero mandó, la caja quedó vacía y no manda nada.
    let enviado = false;
    for (let intento = 1; intento <= 2 && !enviado; intento += 1) {
      await presionarEnter();
      for (let i = 0; i < 12 && !enviado; i += 1) {
        await sleep(500);
        enviado = await detectarEnvio(destino, antes);
      }
    }

    const aviso = destino.conocido ? '' : ' (era un número con el que nunca habías hablado)';
    if (!enviado) {
      return (
        `No pude confirmar que el mensaje a "${destino.nombre}" haya salido: apreté Enter pero no apareció en WhatsApp. ` +
        `Quedó escrito en el chat; que el usuario lo revise y lo mande. NO reintentes: podría duplicarse.`
      );
    }
    return `✓ Enviado a "${destino.nombre}"${aviso}, verificado en WhatsApp:\n\n${cuerpo}`;
  },

  async cola_mensajes({ accion, mensajes }) {
    if (accion === 'estado') return resumenCola();

    if (accion === 'cancelar') {
      if (!cola) return 'No hay ninguna cola.';
      clearInterval(cola.timer);
      cola.estado = 'cancelada';
      return `Cola cancelada. El borrador que esté abierto queda en WhatsApp; no se abre ninguno más.\n\n${resumenCola()}`;
    }

    if (accion === 'saltar') {
      if (!cola || !['activa', 'pausada'].includes(cola.estado)) return 'No hay una cola en curso.';
      const actual = cola.items.find((x) => x.estado === 'abierto');
      if (actual) actual.estado = 'salteado';
      cola.estado = 'activa';
      await abrirSiguiente();
      return resumenCola();
    }

    if (accion === 'reanudar') {
      if (!cola || cola.estado !== 'pausada') return 'No hay una cola pausada.';
      cola.estado = 'activa';
      cola.motivo = null;
      const actual = cola.items.find((x) => x.estado === 'abierto');
      // si se pausó por demora, reabrimos el mismo borrador (WhatsApp pudo haberlo perdido)
      if (actual) { actual.estado = 'pendiente'; }
      await abrirSiguiente();
      return resumenCola();
    }

    if (accion !== 'crear') throw new Error(`Acción desconocida: ${accion}`);

    if (cola && ['activa', 'pausada'].includes(cola.estado)) {
      throw new Error('Ya hay una cola en curso. Cancelala o esperá a que termine antes de crear otra.');
    }
    if (fs.existsSync(KILL_SWITCH)) throw new Error(`Borradores DESACTIVADOS: existe ${KILL_SWITCH}.`);
    const lim = cargarLimites();
    if (!Array.isArray(mensajes) || mensajes.length === 0) throw new Error('`mensajes` está vacío.');
    if (mensajes.length > lim.colaMax) {
      throw new Error(`La cola tiene ${mensajes.length} mensajes; el máximo es ${lim.colaMax} (ajustable en ~/.wacrawl/limites.json).`);
    }

    // Validar TODO antes de abrir el primero: mejor fallar acá que a mitad de camino.
    const items = [];
    const problemas = [];
    const vistos = new Map();
    for (const [n, m] of mensajes.entries()) {
      const texto = String(m.texto || '').trim();
      try {
        if (!texto) throw new Error('texto vacío');
        if (texto.length > lim.largoMax) throw new Error(`texto de ${texto.length} caracteres (máx ${lim.largoMax})`);
        const d = await telefonoDeChat(m.chat);
        if (vistos.has(d.telefono)) throw new Error(`repite destinatario con el #${vistos.get(d.telefono)}`);
        vistos.set(d.telefono, n + 1);
        if (lim.antiDifusion) {
          const igual = items.find((i) => normalizarTexto(i.texto) === normalizarTexto(texto));
          if (igual) throw new Error(`mismo texto que el de ${igual.nombre} (anti-difusión)`);
        }
        items.push({ ...d, texto, estado: 'pendiente' });
      } catch (err) {
        problemas.push(`#${n + 1} ${m.chat}: ${err.message}`);
      }
    }
    if (problemas.length) {
      throw new Error(`No armé la cola; hay que corregir esto primero:\n${problemas.join('\n')}`);
    }
    if (items.length > lim.porHora) {
      throw new Error(`La cola tiene ${items.length} mensajes y el límite es ${lim.porHora} por hora (ajustable en ~/.wacrawl/limites.json).`);
    }

    cola = { items, estado: 'activa', creada: Date.now() };
    cola.timer = setInterval(vigilarCola, POLL_MS);
    cola.timer.unref?.();
    await abrirSiguiente();

    return (
      `Cola armada con ${items.length} mensajes. Abrí el primero en WhatsApp (${items[0].nombre}).\n` +
      `El usuario lo revisa y aprieta Enter; cuando detecto que salió, abro el siguiente solo. ` +
      `NO se envía nada automáticamente.\n\n${resumenCola()}`
    );
  },

  async transcribir_audios({ chat, desde, hasta, limit }) {
    const max = clampLimit(limit, 5, 15);
    const jid = chat ? await resolveChatJID(chat) : null;
    const where = await commonFilters({ chat: jid, desde, hasta });
    where.push(`m.message_type = 'audio'`);
    const rows = await adjuntarTranscripciones(await selectMessages('messages m', where.join(' AND '), 'DESC', max));
    if (!rows.length) return `No hay audios${chat ? ` en "${chat}"` : ''} en ese período.`;

    const conArchivo = (r) => r.media_path && fs.existsSync(r.media_path);
    const faltan = rows.filter((r) => r.transcripcion === undefined && conArchivo(r));
    const sinArchivo = rows.filter((r) => r.transcripcion === undefined && !conArchivo(r));
    const yaEstaban = rows.length - faltan.length - sinArchivo.length;

    if (faltan.length) {
      const res = await correrTranscriptor(whisperListo(), faltan.map((r) => ({
        msg_id: r.message_id, chat_jid: r.chat_jid, chat_name: r.chat_name, sender_name: r.sender_name,
        from_me: r.from_me, ts: r.ts, media_path: r.media_path,
      })));
      for (const r of faltan) {
        const k = `${r.message_id}|${r.chat_jid}`;
        if (k in res) r.transcripcion = res[k];
      }
    }

    const nuevos = faltan.filter((r) => r.transcripcion !== undefined).length;
    const fallidos = faltan.length - nuevos;
    const notas = [];
    if (yaEstaban) notas.push(`${yaEstaban} ya estaban transcriptos`);
    if (nuevos) notas.push(`${nuevos} transcriptos ahora`);
    if (fallidos) notas.push(`${fallidos} no se pudieron leer (archivo de audio dañado o incompleto; se puede escuchar en WhatsApp)`);
    if (sinArchivo.length) notas.push(`${sinArchivo.length} sin archivo en esta Mac (WhatsApp Desktop no los descargó; suelen ser anteriores a vincularlo)`);
    rows.reverse();   // del más viejo al más nuevo, como se escucharían
    return `${rows.length} audio(s)${chat ? ` en "${rows[0].chat_name || chat}"` : ''} — ${notas.join(', ')}.\n` +
      `Ojo: es transcripción automática; los nombres propios pueden salir mal.\n\n${formatMessages(rows, { withChat: !chat })}`;
  },

  async leer_chat({ chat, desde, hasta, limit }) {
    if (!chat) throw new Error('`chat` es obligatorio.');
    const jid = await resolveChatJID(chat);
    const where = await commonFilters({ chat: jid, desde, hasta });
    const clause = where.join(' AND ');

    const rows = await adjuntarTranscripciones(await selectMessages('messages m', clause, 'ASC', clampLimit(limit, 100, 1000)));
    const name = rows[0]?.chat_name || chat;
    return `${rows.length} mensaje(s) en "${name}" (${jid}), en orden cronológico:\n\n${formatMessages(rows, { withChat: false })}${await freshnessNote()}`;
  },
};

/* ------------------------------------------------------------------ */
/* MCP stdio loop (JSON-RPC 2.0, line-delimited)                       */
/* ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleRequest(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: req.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'wacrawl-mcp', version: '2.1.0' },
        instructions: SERVER_INSTRUCTIONS.replace('__PROFUNDIDAD__', profundidad()).replace('__ARCHIVOS__', queArchivosHay()),
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args } = req.params || {};
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool desconocida: ${name}`);
      // Las tools devuelven texto, o ya un array de contenido MCP cuando
      // mandan imágenes junto con su contexto.
      // Un fallo de la tool (chat ambiguo, sin número, límite alcanzado) va como
      // resultado con isError, NO como error de protocolo: Claude Desktop muestra
      // los errores de protocolo como un "failed" pelado y el modelo nunca ve el
      // motivo. Así veía "falló" sin saber que el nombre coincidía con 6 chats.
      try {
        const salida = await handler(args || {});
        return { content: Array.isArray(salida) ? salida : [{ type: 'text', text: salida }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err.message || String(err) }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Método no soportado: ${req.method}`), { code: -32601 });
  }
}

// Importable desde check.sh para probar el renderizado sin levantar el server.
if (require.main !== module) {
  module.exports = { messageBody, senderLabel, formatMessages, looksLikeBlob, TIPOS, detectarEnvio };
  return;
}

let buffer = '';
let pending = 0;
let stdinEnded = false;

function maybeExit() {
  // NO usar process.exit(): trunca lo que quede sin vaciar en stdout, y una
  // imagen en base64 no entra de una sola pasada. Soltamos stdin y dejamos que
  // node salga solo cuando ya no tenga nada pendiente.
  if (stdinEnded && pending === 0) {
    process.exitCode = 0;
    process.stdin.pause();
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }

    // Notificaciones (sin id) no llevan respuesta.
    if (req.id === undefined || req.id === null) continue;

    pending += 1;
    handleRequest(req)
      .then((result) => send({ jsonrpc: '2.0', id: req.id, result }))
      .catch((err) =>
        send({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: err.code || -32000, message: err.message || String(err) },
        })
      )
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
