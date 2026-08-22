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
 * que escribe en la base y tardan MINUTOS sobre este archivo (~935k mensajes),
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

/** Ejecuta un SELECT y devuelve las filas. `--sync never` = lectura pura. */
async function runSQL(sql) {
  const out = await runWacrawl(['--sync', 'never', '--json', 'sql', sql]);
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
  ` m.from_me, m.text, m.message_type, m.media_title, m.media_path,` +
  // Hora LOCAL de esta Mac. En UTC los mensajes de la noche caen al día
  // siguiente y todo se lee corrido.
  ` strftime('%Y-%m-%d %H:%M', m.ts, 'unixepoch', 'localtime') AS timestamp`;

async function countDistinct(from, clause) {
  const [row] = await runSQL(`SELECT count(*) AS n FROM (SELECT 1 FROM ${from} WHERE ${clause} ${GROUPING})`);
  return row?.n ?? 0;
}

const selectMessages = (from, clause, order, limit) =>
  runSQL(`SELECT ${MSG_COLUMNS} FROM ${from} WHERE ${clause} ${GROUPING} ORDER BY m.ts ${order} LIMIT ${limit}`);

/* ------------------------------------------------------------------ */
/* dominio                                                             */
/* ------------------------------------------------------------------ */

// Ojo con `chats.last_message_at`: hay filas con fechas corruptas (año 9026)
// que encabezarían cualquier orden por fecha. Usamos max(m.ts) de los mensajes
// reales, que no puede mentir.
const CHATS_SQL =
  `SELECT c.jid, c.kind, c.name, c.unread_count,` +
  ` count(m.rowid) AS message_count,` +
  ` strftime('%Y-%m-%dT%H:%M:%SZ', max(m.ts), 'unixepoch') AS last_message_at,` +
  ` max(m.ts) AS last_ts` +
  ` FROM chats c LEFT JOIN messages m ON m.chat_jid = c.jid AND m.deleted_at IS NULL` +
  ` WHERE c.deleted_at IS NULL`;

const ORDERS = {
  recientes: 'last_ts DESC',
  mensajes: 'message_count DESC',
};

const listChats = (orden = 'recientes') =>
  runSQL(`${CHATS_SQL} GROUP BY c.jid ORDER BY ${ORDERS[orden] || ORDERS.recientes}`);

/** Resuelve un nombre de chat a su JID. Si ya es un JID, lo devuelve tal cual. */
async function resolveChatJID(chat) {
  const value = String(chat).trim();
  if (value.includes('@')) return value;

  const needle = value.toLowerCase();
  const rows = await runSQL(
    `${CHATS_SQL} AND lower(c.name) LIKE ${sqlString(`%${likeLiteral(needle)}%`)} ESCAPE '\\'` +
    ` GROUP BY c.jid ORDER BY message_count DESC`
  );

  if (rows.length === 0) {
    throw new Error(`No encontré ningún chat que coincida con "${value}". Probá listar_chats para ver los nombres disponibles.`);
  }

  const exact = rows.filter((c) => (c.name || '').toLowerCase() === needle);
  const candidates = exact.length ? exact : rows;
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
  if (chat) where.push(`m.chat_jid = ${sqlString(await resolveChatJID(chat))}`);
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
const SERVER_INSTRUCTIONS = `Acceso de sólo lectura al archivo local de WhatsApp de Renzo (~935k mensajes). Cómo interpretar los resultados:

PROFUNDIDAD REAL: el 99,9% del archivo es de los últimos ~19 meses (2025-2026). Antes de 2025 hay ~625 registros y casi sin texto. Si no encontrás algo viejo, es que WhatsApp Desktop no lo guarda localmente — decilo así, no como "no encontré".

FRESCURA: el archivo se sincroniza cada 6h y un sync tarda ~5 min, así que NO se puede refrescar durante una consulta. Las tools avisan explícitamente cuando detectan mensajes más nuevos sin importar. Para "¿me contestó recién?" el archivo no sirve: hay que mirar WhatsApp directamente.

QUIÉN DIJO QUÉ: en DMs la atribución es confiable. En grupos, ~103k mensajes de texto no tienen nombre de remitente y aparecen como "(no identificado · <jid>@lid)"; ese lid es estable por persona, así que sirve para saber que dos mensajes son del mismo desconocido, pero NO para ponerle nombre. Nunca inventes de quién es un mensaje así, ni lo atribuyas al dueño del chat.

BÚSQUEDA: usá buscar_whatsapp primero (índice full-text, palabras completas). Si devuelve poco o nada, reintentá con busqueda_profunda, que matchea subcadenas y suele encontrar más. Los conteos que reportan son exactos sobre todo el archivo; los mensajes mostrados están topeados por 'limit', así que cualquier síntesis de un período largo sale de una MUESTRA — decilo cuando corresponda en vez de presentarla como completa.

CONTENIDO NO TEXTUAL: audios, imágenes y documentos aparecen con metadata pero sin transcripción ni OCR. Un audio se sabe que existe y cuándo, no qué dice. Además ~9% del texto son blobs no decodificables.

ESCRITURA: este server no puede mandar, responder ni marcar nada. Es sólo lectura.`;

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
      'Muestra las imágenes y documentos que se mandaron en un chat, para poder MIRARLOS (no sólo saber que existen). Los PDF se ven como imagen de su primera página. Ojo: WhatsApp Desktop sólo guarda media en esta Mac desde el 2026-08-06; de antes no hay archivos, aunque el mensaje exista.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Opcional: limitar a un chat, por nombre o por JID.' },
        tipo: { type: 'string', enum: ['imagen', 'documento', 'todos'], description: 'Qué traer. Default: todos.' },
        desde: { type: 'string', description: 'Opcional: sólo posteriores. YYYY-MM-DD o RFC3339.' },
        hasta: { type: 'string', description: 'Opcional: sólo anteriores. YYYY-MM-DD o RFC3339.' },
        limit: { type: 'integer', description: 'Máximo de archivos (default 3, máx 10). Son imágenes: pedí pocas.' },
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
    const where = await commonFilters({ chat, desde, hasta, de_mi });
    where.push(`messages_fts MATCH ${sqlString(ftsPhrase(String(query).trim()))}`);
    const clause = where.join(' AND ');

    const total = await countDistinct(from, clause);
    const rows = await selectMessages(from, clause, 'DESC', max);

    const scope = chat ? ` en ${chat}` : '';
    const shown = total > rows.length ? ` (mostrando ${rows.length})` : '';
    const hint = total === 0 ? '\n\nSugerencia: probá busqueda_profunda, que busca subcadenas y suele encontrar más.' : '';
    return `${total} mensaje(s) para "${query}"${scope}${shown}:\n\n${formatMessages(rows, { withChat: true })}${hint}${await freshnessNote()}`;
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
    const where = await commonFilters({ chat, desde, hasta, de_mi });
    where.push('m.text IS NOT NULL');
    for (const t of terms) {
      where.push(`lower(m.text) LIKE ${sqlString(`%${likeLiteral(t.toLowerCase())}%`)} ESCAPE '\\'`);
    }
    const clause = where.join(' AND ');

    const total = await countDistinct('messages m', clause);
    const rows = await selectMessages('messages m', clause, 'DESC', max);

    const modo = todas_las_palabras ? 'todas las palabras' : 'frase literal';
    const scope = chat ? ` en ${chat}` : '';
    const shown = total > rows.length ? ` (mostrando ${rows.length})` : '';
    return `${total} coincidencia(s) para "${query}"${scope} — ${modo}${shown}:\n\n${formatMessages(rows, { withChat: true })}${await freshnessNote()}`;
  },

  async mensajes_recientes({ chat, minutos, solo_recibidos, limit }) {
    const max = clampLimit(limit, 30, 200);

    const where = ['m.ZTEXT IS NOT NULL'];
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
      ` m.ZPUSHNAME AS push_name, m.ZFROMJID AS sender_jid, m.ZTEXT AS text` +
      ` FROM ZWAMESSAGE m` +
      ` LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION` +
      ` LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER` +
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
      const texto = String(m.text).trim();
      return `${cuando} [${donde}] ${quien}: ${looksLikeBlob(texto) ? '(archivo adjunto)' : texto}`;
    });

    return (
      `${rows.length} mensaje(s) EN VIVO desde WhatsApp Desktop` +
      `${chat ? ` en "${chat}"` : ''}${Number.isFinite(minutos) ? ` (últimos ${minutos} min)` : ''},` +
      ` del más nuevo al más viejo:\n\n${lines.join('\n')}`
    );
  },

  async ver_archivos({ chat, tipo, desde, hasta, limit }) {
    const max = clampLimit(limit, 3, 10);
    const tipos = tipo === 'imagen' ? ['image'] : tipo === 'documento' ? ['document'] : ['image', 'document'];

    const where = await commonFilters({ chat, desde, hasta });
    where.push(`m.media_path IS NOT NULL AND m.media_path <> ''`);
    where.push(`m.message_type IN (${tipos.map(sqlString).join(', ')})`);

    const rows = await selectMessages('messages m', where.join(' AND '), 'DESC', max * 3);

    const content = [];
    let mostrados = 0;
    const problemas = [];

    for (const m of rows) {
      if (mostrados >= max) break;
      const ruta = m.media_path;
      if (!ruta || !fs.existsSync(ruta)) {
        problemas.push(`${m.timestamp} ${m.chat_name}: el archivo ya no está en disco`);
        continue;
      }
      if (!EXT_SOPORTADAS.has(path.extname(ruta).toLowerCase())) {
        problemas.push(`${m.timestamp} ${m.chat_name}: ${path.extname(ruta)} no se puede mostrar`);
        continue;
      }
      try {
        const data = await renderToJpeg(ruta);
        const que = m.message_type === 'document' ? 'documento (primera página)' : 'imagen';
        const titulo = m.media_title && !looksLikeBlob(m.media_title) ? ` — ${m.media_title}` : '';
        content.push({
          type: 'text',
          text: `${m.timestamp} [${m.chat_name || m.chat_jid}] ${senderLabel(m)} — ${que}${titulo}`,
        });
        content.push({ type: 'image', data, mimeType: 'image/jpeg' });
        mostrados += 1;
      } catch (err) {
        problemas.push(`${m.timestamp} ${m.chat_name}: no se pudo convertir (${err.message.slice(0, 80)})`);
      }
    }

    if (mostrados === 0) {
      const detalle = problemas.length ? `\n\n${problemas.join('\n')}` : '';
      return (
        `No hay archivos para mostrar${chat ? ` en "${chat}"` : ''}.` +
        ` Recordá que WhatsApp Desktop sólo guarda media en esta Mac desde el 2026-08-06;` +
        ` de mensajes anteriores existe el registro pero no el archivo.${detalle}`
      );
    }

    content.unshift({
      type: 'text',
      text: `${mostrados} archivo(s)${chat ? ` de "${chat}"` : ''}, del más nuevo al más viejo:`,
    });
    if (problemas.length) {
      content.push({ type: 'text', text: `\nNo se pudieron mostrar:\n${problemas.join('\n')}` });
    }
    return content;
  },

  async leer_chat({ chat, desde, hasta, limit }) {
    if (!chat) throw new Error('`chat` es obligatorio.');
    const jid = await resolveChatJID(chat);
    const where = await commonFilters({ chat: jid, desde, hasta });
    const clause = where.join(' AND ');

    const rows = await selectMessages('messages m', clause, 'ASC', clampLimit(limit, 100, 1000));
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
        instructions: SERVER_INSTRUCTIONS,
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
      const salida = await handler(args || {});
      return { content: Array.isArray(salida) ? salida : [{ type: 'text', text: salida }] };
    }
    default:
      throw Object.assign(new Error(`Método no soportado: ${req.method}`), { code: -32601 });
  }
}

// Importable desde check.sh para probar el renderizado sin levantar el server.
if (require.main !== module) {
  module.exports = { messageBody, senderLabel, formatMessages, looksLikeBlob, TIPOS };
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
