#!/usr/bin/env node
'use strict';

/**
 * wacrawl-mcp — an MCP server (stdio) over your local WhatsApp archive.
 *
 * Everything runs locally. No npm dependencies, no network.
 *
 * Every read goes through `wacrawl sql`, which is read-only (it rejects anything
 * that isn't a single SELECT) and takes ~1-3 s. We deliberately do NOT use the
 * `chats` / `messages` / `search` subcommands: they run a "backfill" that writes
 * to the database and takes MINUTES on an archive of hundreds of thousands of
 * messages, which made Claude Desktop time out. `search` also returns far fewer
 * results than querying the FTS index directly.
 *
 * The archive is kept fresh by the launchd agent (a sync every 6 h), not from
 * here: this server never writes or moves ~/.wacrawl/wacrawl.db.
 */

const { execFile, spawn } = require('node:child_process');
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
        reject(new Error(`wacrawl failed: ${detail}`));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocked = (err) => /database is locked|SQLITE_BUSY/i.test(err.message || '');

/** Serializes calls, and retries if the launchd sync is holding the database. */
let wacrawlQueue = Promise.resolve();

function runWacrawl(args) {
  const result = wacrawlQueue.then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await execWacrawl(args);
      } catch (err) {
        if (!isLocked(err) || attempt >= 4) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  });
  wacrawlQueue = result.then(() => {}, () => {});
  return result;
}

/** Runs a SELECT and returns the rows. `--sync never` = pure read. Without `db`, the main archive. */
async function runSQL(sql, db = null) {
  const out = await runWacrawl([...(db ? ['--db', db] : []), '--sync', 'never', '--json', 'sql', sql]);
  const trimmed = out.trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`wacrawl returned non-JSON output: ${trimmed.slice(0, 400)}`);
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((r) => r && typeof r === 'object');
}

/* ------------------------------------------------------------------ */
/* iPhone history: a second, frozen archive with the older years       */
/* ------------------------------------------------------------------ */

/**
 * WhatsApp Desktop receives ~1 year of history when it's linked. Older years are imported
 * once from an iPhone backup (import-iphone.sh) into a SEPARATE archive: when WhatsApp
 * renumbers, the sync rebuilds the main archive from scratch with what Desktop has, and
 * would wipe out anything imported into it.
 *
 * The two overlap in the last year, so each one answers only for its own range: the history
 * archive before the cutoff, the main archive from the cutoff on (the first month in which
 * the main archive is already complete). That way counts add up without duplicates.
 *
 * On-disk names (`historico/`, `corte.json` and its keys) come from the original Spanish
 * version and are kept so existing installs keep working.
 */
const HISTORY_DIR = process.env.WACRAWL_HISTORY_DIR || path.join(os.homedir(), '.wacrawl/historico');

function historyArchive() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, 'corte.json'), 'utf8'));
    const db = path.join(HISTORY_DIR, 'wacrawl.db');
    if (Number.isFinite(info.corte) && fs.existsSync(db)) {
      return {
        db,
        cutoff: info.corte,
        cutoffDate: info.corteFecha,
        since: info.desde,
        backup: info.backup,
        noVideos: Boolean(info.sinVideos),
        attachmentsSince: info.adjuntosDesde || null,
      };
    }
  } catch {}
  return null;
}

/** How far back history goes on THIS Mac, for the server instructions. */
function depthNote() {
  const h = historyArchive();
  if (!h) {
    return 'the archive has what WhatsApp Desktop received from the phone when it was linked, plus everything that arrived since. That is usually months, not years.';
  }
  return `besides what WhatsApp Desktop received when it was linked, the iPhone history was imported on this Mac ` +
    `(backup from ${h.backup}): searches go back to ${h.since}. Anything after that backup comes in through the normal sync. ` +
    `Old attachments are the ones the iPhone still had${h.noVideos ? ' (no videos or stickers)' : ''}. ` +
    `Voice notes from before ${h.cutoffDate} may not be transcribed yet: transcribe_audio transcribes them on demand.`;
}

/** Which attachments exist on this Mac, to explain why one is missing. */
function filesNote() {
  const h = historyArchive();
  if (!h) {
    return 'Only the files WhatsApp Desktop downloaded since it was linked to this Mac exist;' +
      ' for older messages the record exists but the file does not.';
  }
  return `Only the files WhatsApp Desktop downloaded since it was linked to this Mac exist, plus the ones the` +
    ` iPhone still had when the backup was made${h.attachmentsSince ? ` (since ${h.attachmentsSince})` : ''}` +
    `${h.noVideos ? ', without videos or stickers' : ''}; for anything older the record exists but the file does not.`;
}

/** The same query on both archives, each on its own range. `build` receives the date condition. */
function inBoth(build) {
  const h = historyArchive();
  if (!h) return [runSQL(build(''))];
  return [runSQL(build(` AND m.ts >= ${h.cutoff}`)), runSQL(build(` AND m.ts < ${h.cutoff}`), h.db)];
}

/* ------------------------------------------------------------------ */
/* live source: the WhatsApp Desktop database, STRICTLY read-only      */
/* ------------------------------------------------------------------ */

/** CoreData counts seconds from 2001-01-01, not 1970. */
const APPLE_EPOCH = 978307200;

let sourcePathPromise = null;

/** Path to ChatStorage.sqlite, as reported by wacrawl itself (we don't hardcode it). */
function sourcePath() {
  if (!sourcePathPromise) {
    sourcePathPromise = runWacrawl(['--sync', 'never', 'doctor'])
      .then((out) => {
        const chatDb = JSON.parse(out)?.desktop?.chat_db;
        if (!chatDb) throw new Error('wacrawl doctor did not report the WhatsApp Desktop path.');
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
 * Queries the LIVE WhatsApp database, through wacrawl itself rather than /usr/bin/sqlite3,
 * so every read has the same guarantees: wacrawl's `sql` rejects anything that isn't a single
 * SELECT, and it has been verified not to modify WhatsApp's file.
 *
 * Reading WhatsApp's container needs Full Disk Access, which macOS checks on the responsible
 * process — the dedicated node runtime — not on the binary that opens the file
 * (see TECHNICAL-NOTES.md, "macOS permissions").
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
    throw new Error(`wacrawl returned unexpected output: ${trimmed.slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ */
/* media: turn attachments into something Claude can SEE               */
/* ------------------------------------------------------------------ */

const SIPS_BIN = '/usr/bin/sips';
const MAX_PX = 1024;

/**
 * Normalizes any attachment to JPEG so it can be returned as an MCP image.
 *
 * PDFs are RENDERED to an image instead of having their text extracted: macOS ships nothing
 * native for that (Spotlight doesn't index WhatsApp's container and PyObjC isn't installed),
 * and rendering works just as well for scanned PDFs, which have no text to extract. `sips`
 * ships with the system, so: zero dependencies.
 *
 * Note: a PDF yields ONLY its first page.
 */
async function renderToJpeg(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacrawl-media-'));
  const out = path.join(dir, 'out.jpg');
  try {
    const ext = detectExtension(srcPath);
    if (ext && path.extname(srcPath).toLowerCase() !== ext) {
      const withExt = path.join(dir, `in${ext}`);
      fs.copyFileSync(srcPath, withExt);
      srcPath = withExt;
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
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* doesn't matter */ }
  }
}

const RENDERABLE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.pdf', '.tiff', '.bmp']);

/** Documents that can be READ as text with textutil (ships with macOS, no dependencies). */
const TEXT_EXTS = new Set(['.docx', '.doc', '.rtf', '.odt', '.txt', '.html', '.htm']);
const MAX_TEXT = 20000;

async function documentText(srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacrawl-doc-'));
  try {
    // textutil picks the format from the extension, and wacrawl 0.4.x stores files without one.
    const ext = detectExtension(srcPath);
    const input = path.join(dir, `in${ext}`);
    fs.copyFileSync(srcPath, input);
    const text = await new Promise((resolve, reject) => {
      execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', input], { maxBuffer: MAX_BUFFER, timeout: 30000 },
        (err, out, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim())) : resolve(out.toString())));
    });
    const clean = text.replace(/\n{3,}/g, '\n\n').trim();
    return clean.length > MAX_TEXT
      ? `${clean.slice(0, MAX_TEXT)}\n\n[… truncated: the document continues. Export it with export_attachments to get all of it.]`
      : clean;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* doesn't matter */ }
  }
}

/**
 * The real extension of an attachment. wacrawl 0.3.x copied media with its original name
 * (".../uuid.jpg"), but 0.4.x stores it by hash and WITHOUT an extension
 * (".../media/46/4637a2f5…"), and doesn't record the type anywhere. So if there's no
 * extension, we infer it from the first bytes, the way `file` does.
 */
function detectExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && ext.length <= 6) return ext;
  let b;
  try {
    const fd = fs.openSync(filePath, 'r');
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
    const brand = asc(8, 4);
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return '.heic';
    if (brand === 'M4A ') return '.m4a';
    if (brand === 'qt  ') return '.mov';
    return '.mp4';
  }
  if (asc(0, 4) === 'PK\x03\x04') {          // modern Office = zip
    // A zip's index is at the END: look at the beginning and at the tail.
    let tail = Buffer.alloc(0);
    try {
      const fd = fs.openSync(filePath, 'r');
      const size = fs.fstatSync(fd).size;
      tail = Buffer.alloc(Math.min(65536, size));
      fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
      fs.closeSync(fd);
    } catch { /* the beginning is enough */ }
    const body = b.toString('latin1') + tail.toString('latin1');
    if (body.includes('word/')) return '.docx';
    if (body.includes('xl/')) return '.xlsx';
    if (body.includes('ppt/')) return '.pptx';
    return '.zip';
  }
  if (/^\s*<(!doctype html|html)/i.test(asc(0, 64))) return '.html';
  return '';
}

/* ------------------------------------------------------------------ */
/* drafts and sending: the model writes, the person decides            */
/* ------------------------------------------------------------------ */

/**
 * By default nothing is ever sent: WhatsApp Desktop opens on the chat with the text typed
 * in the box, and the person presses Enter. Real sending (send_message) is opt-in, per Mac.
 *
 * The safeguards live here and not in the prompt, because a runaway model ignores
 * instructions but not an `if`. The counters are persisted on disk so restarting the server
 * doesn't reset them.
 */
// Overridable for tests only (check.sh): the state folder and the command that opens WhatsApp.
const DRAFTS_DIR = process.env.WACRAWL_DRAFTS_DIR || path.join(os.homedir(), '.wacrawl');
const OPEN_BIN = process.env.WACRAWL_OPEN_BIN || '/usr/bin/open';
// "borradores" means drafts: the name predates the English version and is kept for existing installs.
const DRAFTS_LOG = path.join(DRAFTS_DIR, 'borradores.jsonl');
const KILL_SWITCH = path.join(DRAFTS_DIR, 'STOP');
const DEFAULT_LIMITS = {
  perMinute: 3,           // single drafts (draft_message) and sends
  perHour: 15,
  maxLength: 2000,
  broadcastWindowMin: 60,
  antiBroadcast: true,    // same text to another chat → blocked
  queueMax: 30,           // messages per queue
  queueWaitMin: 10,       // nothing sent in this long → the queue pauses
  allowSending: false,    // send_message PRESSES ENTER: off unless the person turns it on
  sendsPerHour: 10,
};
// Keys used by the original Spanish version (~/.wacrawl/limites.json): still honored.
const LEGACY_LIMIT_KEYS = {
  porMinuto: 'perMinute', porHora: 'perHour', largoMax: 'maxLength', ventanaDifusionMin: 'broadcastWindowMin',
  antiDifusion: 'antiBroadcast', colaMax: 'queueMax', colaEsperaMin: 'queueWaitMin',
  permitirEnvio: 'allowSending', enviosPorHora: 'sendsPerHour',
};
/**
 * Adjustable in ~/.wacrawl/limits.json (e.g. {"perHour": 40}). That's the person's call: the
 * risk of WhatsApp restricting the account is theirs. What is NOT adjustable: a draft never
 * sends itself, and send_message only works with "allowSending": true.
 */
function loadLimits() {
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, name), 'utf8')) || {}; } catch { return {}; }
  };
  const legacy = Object.fromEntries(
    Object.entries(read('limites.json'))
      .filter(([k]) => k in LEGACY_LIMIT_KEYS)
      .map(([k, v]) => [LEGACY_LIMIT_KEYS[k], v])
  );
  return { ...DEFAULT_LIMITS, ...legacy, ...read('limits.json') };
}
let LIMITS = loadLimits();

function readDraftLog() {
  try {
    return fs.readFileSync(DRAFTS_LOG, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }   // a damaged line must not reset the limits
    });
  } catch {
    return [];
  }
}

// Entries written by the original Spanish version use telefono / texto / envio.
const entryPhone = (d) => d.phone ?? d.telefono;
const entryText = (d) => d.text ?? d.texto;
const entryIsSend = (d) => Boolean(d.send ?? d.envio);

const normalizeText = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

/** Returns why it's blocked, or null if the draft can be opened. mode: 'draft' | 'queue' | 'send'. */
function checkSafeguards(phone, text, { mode = 'draft' } = {}) {
  LIMITS = loadLimits();
  if (fs.existsSync(KILL_SWITCH)) {
    return `Drafts are DISABLED: ${KILL_SWITCH} exists. Delete that file to turn them back on.`;
  }
  const now = Date.now();
  const previous = readDraftLog();
  const inWindow = (min) => previous.filter((d) => now - d.ts < min * 60000);

  if (mode !== 'queue' && inWindow(1).length >= LIMITS.perMinute) {
    return `Limit: at most ${LIMITS.perMinute} drafts per minute. Wait a moment.`;
  }
  if (mode === 'send' && inWindow(60).filter(entryIsSend).length >= LIMITS.sendsPerHour) {
    return `Limit: at most ${LIMITS.sendsPerHour} sends per hour. This stops bursts and clears on its own (adjustable in ~/.wacrawl/limits.json).`;
  }
  if (inWindow(60).length >= LIMITS.perHour) {
    return `Limit: at most ${LIMITS.perHour} drafts per hour. This stops bursts and clears on its own.`;
  }
  // Anti-broadcast: the same text to ANOTHER recipient is what a broadcast looks like, and
  // broadcasts are what get WhatsApp accounts banned.
  const t = normalizeText(text);
  const repeated = LIMITS.antiBroadcast &&
    inWindow(LIMITS.broadcastWindowMin).find((d) => entryText(d) === t && entryPhone(d) !== phone);
  if (repeated) {
    return `Blocked: that same text was already drafted for another chat (${repeated.chat}) in the last hour. No broadcasts.`;
  }
  return null;
}

function logDraft(entry) {
  fs.mkdirSync(path.dirname(DRAFTS_LOG), { recursive: true });
  fs.appendFileSync(DRAFTS_LOG, JSON.stringify(entry) + '\n');
}

/** The phone number (digits only) for a chat, or an error explaining why there isn't one. */
async function recipientFor(chat) {
  const value = String(chat).trim();

  // A number typed directly
  const digits = value.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (/^\d{8,15}$/.test(digits)) {
    const [prev] = await runSQL(`SELECT name FROM chats WHERE jid = ${sqlString(`${digits}@s.whatsapp.net`)} LIMIT 1`);
    return { phone: digits, jid: `${digits}@s.whatsapp.net`, name: prev?.name || `+${digits}`, known: Boolean(prev) };
  }

  const jid = await resolveChatJID(value);
  const [row] = await runSQL(`SELECT name FROM chats WHERE jid = ${sqlString(jid)} LIMIT 1`);
  const name = row?.name || value;

  if (jid.endsWith('@g.us')) {
    throw new Error(`"${name}" is a group. WhatsApp only opens one-to-one chats through a link: open the group by hand.`);
  }
  if (jid.endsWith('@s.whatsapp.net')) {
    return { phone: jid.split('@')[0], jid, name, known: true };
  }
  if (jid.endsWith('@lid')) {
    const [ct] = await runSQL(
      `SELECT jid FROM contacts WHERE lid = ${sqlString(jid)} AND deleted_at IS NULL AND jid LIKE '%@s.whatsapp.net' LIMIT 1`
    );
    if (ct) return { phone: ct.jid.split('@')[0], jid, name, known: true };
    throw new Error(
      `I don't have the number for "${name}": they're not in your contacts, and WhatsApp hides the number of people you haven't saved. ` +
      `If you know it, give it to me directly.`
    );
  }
  throw new Error(`"${name}" is not a one-to-one chat.`);
}

/**
 * Real sending: presses Enter in WhatsApp Desktop (the official app, so there's no
 * unofficial-client risk). First it checks that WhatsApp is the frontmost app: if focus
 * moved to another window, the Enter would land there. It needs the Accessibility permission
 * for the responsible process (the node runtime); without it macOS rejects the keystroke and
 * we say how to grant it.
 */
const ENTER_BIN = process.env.WACRAWL_ENTER_BIN || null;   // tests only

const ENTER_SCRIPT = `
tell application "WhatsApp" to activate
delay 0.4
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  if frontApp is not "WhatsApp" then error "frontmost:" & frontApp
  key code 36
end tell`;

function pressEnter() {
  return new Promise((resolve, reject) => {
    const [bin, args] = ENTER_BIN ? [ENTER_BIN, []] : ['/usr/bin/osascript', ['-e', ENTER_SCRIPT]];
    execFile(bin, args, { timeout: 15000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const msg = String(stderr || err.message);
      if (/frontmost:/.test(msg)) {
        const app = msg.split('frontmost:')[1].split('(')[0].trim();
        reject(new Error(`Not sent: WhatsApp didn't stay in front (${app} was), and the Enter would have landed there. The message is typed in WhatsApp, unsent.`));
      } else if (/1002|not allowed to send keystrokes|assistive/i.test(msg)) {
        reject(new Error(
          "Not sent: macOS doesn't give this server the Accessibility permission it needs to press Enter. " +
          'The user has to go to System Settings → Privacy & Security → Accessibility → + → ⌘⇧G → ' +
          `${process.execPath} → turn it on. The message is typed in WhatsApp, unsent.`
        ));
      } else if (/-1743|not authorized to send apple events|no autorizado/i.test(msg)) {   // macOS errors can be localized
        reject(new Error(
          'Not sent: macOS doesn\'t allow this server to control "System Events". The user has to go to ' +
          'System Settings → Privacy & Security → Automation and turn on System Events for node. ' +
          'The message is typed in WhatsApp, unsent.'
        ));
      } else {
        reject(new Error(`Not sent: ${msg.trim().slice(0, 200)}. The message is typed in WhatsApp, unsent.`));
      }
    });
  });
}

/** Opens WhatsApp on the chat with the text typed in. Doesn't send. */
async function openDraft({ phone, name }, body, extra = {}) {
  const url = `whatsapp://send?phone=${phone}&text=${encodeURIComponent(body)}`;
  await new Promise((resolve, reject) => {
    execFile(OPEN_BIN, [url], { timeout: 15000 }, (err, _out, stderr) =>
      err ? reject(new Error(`Couldn't open WhatsApp: ${(stderr || err.message).toString().trim()}`)) : resolve()
    );
  });
  logDraft({ ts: Date.now(), phone, chat: name, text: normalizeText(body), ...extra });
}

function notify(text) {
  execFile('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(text)} with title "wacrawl"`], () => {});
}

/**
 * Did any message FROM ME go out in that chat since `sinceMs`? It doesn't require the same
 * text: the person may edit the draft before sending it, and that still counts.
 * CAREFUL: a NEW chat (exactly the case of cold messages) is created by WhatsApp with
 * ZCONTACTJID = <something>@lid, and the phone number goes in ZCONTACTIDENTIFIER. Looking only
 * at ZCONTACTJID never found it, and the queue waited forever.
 */
async function detectSent({ jid, phone }, sinceMs) {
  if (process.env.WACRAWL_FAKE_SENT_FILE) {   // tests only
    try { return fs.readFileSync(process.env.WACRAWL_FAKE_SENT_FILE, 'utf8').split('\n').includes(phone); }
    catch { return false; }
  }
  const jids = [...new Set([jid, `${phone}@s.whatsapp.net`].filter(Boolean))];
  const list = jids.map(sqlString).join(', ');
  const since = Math.floor(sinceMs / 1000) - APPLE_EPOCH - 5;
  const [row] = await runLiveSQL(
    `SELECT count(*) AS n FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION` +
    ` WHERE (s.ZCONTACTJID IN (${list}) OR s.ZCONTACTIDENTIFIER IN (${list}))` +
    ` AND m.ZISFROMME = 1 AND m.ZMESSAGEDATE >= ${since}`
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Draft queue. WhatsApp does NOT keep a draft's text if another chat is opened, so two are
 * never opened in a row: the next one opens only once we detect the person sent the current
 * one. The person sets the pace, not a timer (a timer overwrites the draft if someone takes a
 * while to read or edit).
 */
let draftQueue = null;
const POLL_MS = Number(process.env.WACRAWL_QUEUE_POLL_MS) || 2500;

function queueSummary() {
  if (!draftQueue) return 'There is no queue.';
  const count = (s) => draftQueue.items.filter((i) => i.status === s).length;
  const lines = draftQueue.items.map((i, n) => {
    const mark = { sent: '✓', skipped: '↷', open: '▶', pending: '·', error: '✗' }[i.status];
    return `${mark} ${n + 1}. ${i.name}${i.status === 'error' ? ` — ${i.reason}` : ''}`;
  });
  const why = draftQueue.status === 'paused' && draftQueue.reason ? ` (${draftQueue.reason})` : '';
  return (
    `Queue ${draftQueue.status}${why}: ${count('sent')} sent, ${count('skipped')} skipped, ` +
    `${count('pending') + count('open')} to go.\n\n${lines.join('\n')}`
  );
}

async function openNext() {
  const i = draftQueue.items.findIndex((x) => x.status === 'pending');
  if (i === -1) {
    draftQueue.status = 'finished';
    clearInterval(draftQueue.timer);
    notify(`Queue finished: ${draftQueue.items.filter((x) => x.status === 'sent').length} of ${draftQueue.items.length} sent.`);
    return;
  }
  const item = draftQueue.items[i];
  const blocked = checkSafeguards(item.phone, item.text, { mode: 'queue' });
  if (blocked) {
    draftQueue.status = 'paused';
    draftQueue.reason = blocked;
    notify(`Queue paused: ${blocked}`);
    return;
  }
  try {
    await openDraft(item, item.text, { queue: true });
    item.status = 'open';
    item.openedAt = Date.now();
  } catch (err) {
    item.status = 'error';
    item.reason = err.message;
    await openNext();
  }
}

async function watchQueue() {
  if (!draftQueue || draftQueue.status !== 'active' || draftQueue.checking) return;
  draftQueue.checking = true;
  try {
    if (fs.existsSync(KILL_SWITCH)) {
      draftQueue.status = 'cancelled';
      clearInterval(draftQueue.timer);
      notify('Queue cancelled: STOP was turned on.');
      return;
    }
    const item = draftQueue.items.find((x) => x.status === 'open');
    if (!item) return;
    if (await detectSent(item, item.openedAt)) {
      item.status = 'sent';
      // short pause so WhatsApp finishes sending before switching chats
      await sleep(1500);
      await openNext();
    } else if (Date.now() - item.openedAt > loadLimits().queueWaitMin * 60000) {
      draftQueue.status = 'paused';
      draftQueue.reason = `"${item.name}" wasn't sent within ${loadLimits().queueWaitMin} min`;
      notify(`Queue paused: ${draftQueue.reason}.`);
    }
  } catch (err) {
    // Without permission to read WhatsApp live we can't detect the send: better to stop than
    // to keep opening drafts blind.
    draftQueue.status = 'paused';
    draftQueue.reason = `couldn't check whether it was sent (${err.message.slice(0, 120)})`;
    notify("Queue paused: I can't detect sends.");
  } finally {
    if (draftQueue) draftQueue.checking = false;
  }
}

/* ------------------------------------------------------------------ */
/* voice note transcriptions (local Whisper, see transcribe.py)        */
/* ------------------------------------------------------------------ */

/**
 * Transcriptions live in a SEPARATE database: the wacrawl archive is never written.
 * transcribe.py fills it, in the background after each sync, or on demand through the
 * transcribe_audio tool. The file, table and column names (transcripciones, texto…) come
 * from the original Spanish version and are kept so existing installs keep their data.
 */
const TRANSCRIPTIONS_DB = path.join(DRAFTS_DIR, 'transcripciones.sqlite');

/** Whisper settings: the repo's whisper.env, then the user's ~/.wacrawl/whisper.env (e.g. the language). */
const WHISPER = (() => {
  const v = { python: '3.12', package: 'mlx-whisper==0.4.3', model: 'mlx-community/whisper-large-v3-turbo', language: '' };
  const keys = { PYTHON: 'python', PACKAGE: 'package', MODEL: 'model', LANGUAGE: 'language' };
  for (const file of [path.join(__dirname, 'whisper.env'), path.join(DRAFTS_DIR, 'whisper.env')]) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^WHISPER_(PYTHON|PACKAGE|MODEL|LANGUAGE)=(.*)$/);
        if (!m) continue;
        const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (value || m[1] === 'LANGUAGE') v[keys[m[1]]] = value;   // only the language may be empty (= detect)
      }
    } catch { /* defaults */ }
  }
  return v;
})();

async function runTranscriptionsSQL(sql) {
  if (!fs.existsSync(TRANSCRIPTIONS_DB)) return [];
  const out = (await runWacrawl(['--db', TRANSCRIPTIONS_DB, '--sync', 'never', '--json', 'sql', sql])).trim();
  if (!out) return [];
  const p = JSON.parse(out);
  return (Array.isArray(p) ? p : [p]).filter((r) => r && typeof r === 'object');
}

/** Attaches the transcription (if there is one) to each audio row. "" = no speech detected. */
async function attachTranscriptions(rows) {
  const audios = rows.filter((r) => r.message_type === 'audio' && r.message_id);
  if (!audios.length) return rows;
  const ids = [...new Set(audios.map((r) => r.message_id))];
  let found;
  try {
    found = await runTranscriptionsSQL(`SELECT msg_id, chat_jid, texto FROM transcripciones WHERE msg_id IN (${ids.map(sqlString).join(', ')})`);
  } catch {
    return rows;   // without transcriptions, "(audio)" shows as always
  }
  const byKey = new Map(found.map((t) => [`${t.msg_id}|${t.chat_jid}`, t.texto ?? '']));
  for (const r of audios) {
    const k = `${r.message_id}|${r.chat_jid}`;
    if (byKey.has(k)) r.transcription = byKey.get(k);
  }
  return rows;
}

/** Searches what was SAID in voice notes. Returns null if there are no transcriptions. */
async function searchVoiceNotes({ terms, jid, since, until, fromMe, limit }) {
  if (!fs.existsSync(TRANSCRIPTIONS_DB)) return null;
  const w = ["texto <> ''"];
  for (const t of terms) w.push(`lower(texto) LIKE ${sqlString(`%${likeLiteral(t.toLowerCase())}%`)} ESCAPE '\\'`);
  if (jid) w.push(`chat_jid IN (${(await jidVariants(jid)).map(sqlString).join(', ')})`);
  if (since) w.push(`ts >= ${toEpoch(since, 'since')}`);
  if (until) w.push(`ts < ${toEpoch(until, 'until')}`);
  if (typeof fromMe === 'boolean') w.push(`from_me = ${fromMe ? 1 : 0}`);
  const clause = w.join(' AND ');
  let total, hits;
  try {
    const [c] = await runTranscriptionsSQL(`SELECT count(*) AS n FROM transcripciones WHERE ${clause}`);
    total = c?.n ?? 0;
    hits = total ? await runTranscriptionsSQL(`SELECT msg_id, chat_jid, texto FROM transcripciones WHERE ${clause} ORDER BY ts DESC LIMIT ${limit}`) : [];
  } catch {
    return null;
  }
  if (!hits.length) return { total, rows: [] };
  // What to display (who, where, when) comes from the archive, like everything else.
  const rows = await selectMessages(
    'messages m', `m.deleted_at IS NULL AND m.msg_id IN (${hits.map((h) => sqlString(h.msg_id)).join(', ')})`, 'DESC', limit * 2
  );
  const byKey = new Map(hits.map((h) => [`${h.msg_id}|${h.chat_jid}`, h.texto]));
  const withText = rows
    .filter((r) => byKey.has(`${r.message_id}|${r.chat_jid}`))
    .map((r) => ({ ...r, transcription: byKey.get(`${r.message_id}|${r.chat_jid}`) }));
  return { total, rows: withText.slice(0, limit) };
}

function voiceNotesSection(res) {
  if (!res || !res.total) return '';
  const shown = res.total > res.rows.length ? ` (showing ${res.rows.length})` : '';
  return `\n\nIn voice notes (transcribed): ${res.total}${shown}:\n\n${formatMessages(res.rows, { withChat: true })}`;
}

/** uv + downloaded model + script. If something is missing, an error that says how to fix it. */
function whisperReady() {
  const uv = [process.env.WACRAWL_UV, path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv',
    path.join(os.homedir(), '.cargo/bin/uv')].find((p) => p && fs.existsSync(p));
  const model = path.join(os.homedir(), '.cache/huggingface/hub', `models--${WHISPER.model.replace('/', '--')}`);
  const script = path.join(__dirname, 'transcribe.py');
  if (!uv || !fs.existsSync(model) || !fs.existsSync(script)) {
    throw new Error(
      "Voice note transcription isn't installed on this Mac. Run ./setup-whisper.sh once " +
      '(it downloads the model, ~1.6 GB; after that everything runs locally, offline).'
    );
  }
  return { uv, script };
}

/** Runs transcribe.py with the list on stdin; returns {key: text}. No network. */
function runTranscriber({ uv, script }, items) {
  return new Promise((resolve, reject) => {
    const child = spawn(uv, ['run', '--quiet', '--python', WHISPER.python, '--with', WHISPER.package, 'python', script, '--stdin'], {
      env: {
        HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        UV_OFFLINE: '1', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        WACRAWL_DIR: DRAFTS_DIR, WHISPER_MODEL: WHISPER.model, WHISPER_LANGUAGE: WHISPER.language,
      },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Transcription took too long; try fewer voice notes.')); }, 170000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const res = {};
      for (const l of out.split('\n').filter(Boolean)) {
        try { const j = JSON.parse(l); res[`${j.msg_id}|${j.chat_jid}`] = j.text; } catch { /* not ours */ }
      }
      if (code !== 0 && !Object.keys(res).length) {
        reject(new Error(`Couldn't transcribe: ${err.split('\n').filter((x) => x && !/Warning/.test(x)).slice(-2).join(' ').slice(0, 200)}`));
      } else resolve(res);
    });
    child.stdin.end(JSON.stringify(items));
  });
}

/* ------------------------------------------------------------------ */
/* attachments: the archive + WhatsApp live                            */
/* ------------------------------------------------------------------ */

/**
 * The archive is updated every 6 h: a document that arrived a while ago exists on the Mac
 * (WhatsApp downloads it on its own) but isn't in the archive yet. View/export used to look
 * only at the archive, so asking for "the docx they just sent me" returned the newest one
 * that WAS there — a different, older file. Now both sides are searched and joined by
 * message id.
 *
 * In the live database: ZMESSAGETYPE 1 image, 2 video, 3 audio, 8 document, 11 gif,
 * 15 sticker (7 are link thumbnails: ignored). For documents, ZTEXT is the file's ORIGINAL
 * NAME and ZTITLE the text that came with it. ZMEDIALOCALPATH is relative to <container>/Message/.
 */
const LIVE_TYPES = { 1: 'image', 2: 'video', 3: 'audio', 8: 'document', 11: 'gif', 15: 'sticker' };
const LIVE_CODES = Object.fromEntries(Object.entries(LIVE_TYPES).map(([k, v]) => [v, Number(k)]));

async function liveAttachments({ jid, chatText, types, contains, since, until, limit }) {
  const container = path.dirname(await sourcePath());
  // No filter on ZMEDIALOCALPATH: an attachment WhatsApp didn't download (large ones don't
  // download on their own) has to show up as such. Dropped silently, the model makes up a reason.
  const w = [];
  const codes = types.map((t) => LIVE_CODES[t]).filter(Boolean);
  w.push(`m.ZMESSAGETYPE IN (${codes.join(', ')})`);
  if (jid) {
    const list = (await jidVariants(jid)).map(sqlString).join(', ');
    w.push(`(s.ZCONTACTJID IN (${list}) OR s.ZCONTACTIDENTIFIER IN (${list}))`);
  }
  else if (chatText) w.push(`lower(s.ZPARTNERNAME) LIKE ${sqlString(`%${likeLiteral(chatText.toLowerCase())}%`)} ESCAPE '\\'`);
  if (contains) {
    w.push(`lower(coalesce(m.ZTEXT, '') || ' ' || coalesce(mi.ZTITLE, '')) LIKE ${sqlString(`%${likeLiteral(String(contains).toLowerCase())}%`)} ESCAPE '\\'`);
  }
  if (since) w.push(`m.ZMESSAGEDATE >= ${toEpoch(since, 'since') - APPLE_EPOCH}`);
  if (until) w.push(`m.ZMESSAGEDATE < ${toEpoch(until, 'until') - APPLE_EPOCH}`);
  const rows = await runLiveSQL(
    `SELECT m.ZSTANZAID AS message_id, CAST(m.ZMESSAGEDATE + ${APPLE_EPOCH} AS INTEGER) AS ts,` +
    ` strftime('%Y-%m-%d %H:%M', m.ZMESSAGEDATE + ${APPLE_EPOCH}, 'unixepoch', 'localtime') AS timestamp,` +
    ` m.ZISFROMME AS from_me, m.ZMESSAGETYPE AS code, m.ZTEXT AS text, mi.ZTITLE AS media_title,` +
    ` mi.ZMEDIALOCALPATH AS rel_path, s.ZPARTNERNAME AS chat_name, s.ZCONTACTJID AS chat_jid,` +
    ` gm.ZCONTACTNAME AS member_name, gm.ZMEMBERJID AS member_jid, mi.ZFILESIZE AS bytes` +
    ` FROM ZWAMESSAGE m JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM` +
    ` JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER` +
    ` WHERE ${w.join(' AND ')} ORDER BY m.ZMESSAGEDATE DESC LIMIT ${limit}`
  );
  return rows.map((f) => ({
    message_id: f.message_id, ts: f.ts, timestamp: f.timestamp, from_me: f.from_me,
    message_type: LIVE_TYPES[f.code], text: f.text, media_title: f.media_title,
    media_path: f.rel_path ? path.join(container, 'Message', f.rel_path) : null,
    downloaded: Boolean(f.rel_path), bytes: f.bytes,
    chat_name: f.chat_name, chat_jid: f.chat_jid,
    // senderLabel: in a group, the member; in a one-to-one chat, the other party
    sender_name: f.member_name || null, sender_jid: f.member_jid || f.chat_jid,
  }));
}

/** Attachments from the archive AND from WhatsApp live, joined, newest first. */
async function findAttachments({ chat, types, contains, since, until, limit }) {
  let jid = null;
  let chatText = null;
  if (chat) {
    try {
      jid = await resolveChatJID(chat);
    } catch (err) {
      // A brand-new chat may not be in the archive yet: look it up by name, live.
      if (err.code !== 'CHAT_NOT_FOUND') throw err;
      chatText = String(chat).trim();
    }
  }

  let archived = [];
  if (!chatText) {
    const where = await commonFilters({ chat: jid, since, until });
    where.push(`m.media_path IS NOT NULL AND m.media_path <> ''`);
    where.push(`m.message_type IN (${types.map(sqlString).join(', ')})`);
    if (contains) {
      const c = sqlString(`%${likeLiteral(String(contains).toLowerCase())}%`);
      where.push(`(lower(coalesce(m.text, '')) LIKE ${c} ESCAPE '\\' OR lower(coalesce(m.media_title, '')) LIKE ${c} ESCAPE '\\')`);
    }
    archived = await selectMessages('messages m', where.join(' AND '), 'DESC', limit);
  }

  let live = [];
  let liveWarning = null;
  try {
    live = await liveAttachments({ jid, chatText, types, contains, since, until, limit });
  } catch (err) {
    liveWarning = `Couldn't look at WhatsApp live (${err.message.slice(0, 100)}): anything that arrived in the last few hours may be missing.`;
  }

  // If the archive has its own copy on disk, use that one (it doesn't depend on macOS permissions).
  const byId = new Map(live.map((r) => [r.message_id, r]));
  for (const r of archived) {
    if (r.media_path && fs.existsSync(r.media_path)) byId.set(r.message_id, r);
    else if (!byId.has(r.message_id)) byId.set(r.message_id, r);
  }
  const rows = [...byId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { rows, liveWarning, chatNotFound: chatText && !rows.length ? chatText : null };
}

const formatSize = (b) => !b ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

/** Note for an attachment that exists in the chat but WhatsApp Desktop never downloaded. */
function notDownloadedNote(m) {
  const name = originalName(m) || m.text || TYPE_LABELS[m.message_type] || 'file';
  const size = m.bytes ? `, ${formatSize(m.bytes)}` : '';
  return `${m.timestamp} [${m.chat_name}] «${name}»${size}: WhatsApp Desktop did NOT download it` +
    `${m.bytes > 1e8 ? " (large files don't download on their own)" : ''}. It isn't a lag or sync problem:` +
    ' open that chat in WhatsApp Desktop and click the file to download it; as soon as it finishes, it can be read/exported.';
}

/** The original name of a document (WhatsApp stores it), or null if it isn't a file name. */
function originalName(m) {
  // For documents, that field is the file's title (the text that came with it goes in media_title).
  // Sometimes WhatsApp stores it WITHOUT an extension ("Quarterly report - final"): we add the real one.
  const t = String(m.text || '').trim();
  if (m.message_type !== 'document' || !t || looksLikeBlob(t) || t.length > 150 || /\n/.test(t)) return null;
  if (/\.[A-Za-z0-9]{2,5}$/.test(t)) return t;
  const ext = m.media_path && fs.existsSync(m.media_path) ? detectExtension(m.media_path) : '';
  return ext ? `${t}${ext}` : t;
}

/* ------------------------------------------------------------------ */
/* SQL helpers                                                         */
/* ------------------------------------------------------------------ */

/** A quoted SQL literal. Doubles single quotes. */
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Escapes LIKE wildcards so the search is literal (ESCAPE '\'). */
const likeLiteral = (value) => String(value).replace(/([\\%_])/g, '\\$1');

/** An FTS5 query as a literal phrase: in double quotes, doubling the inner ones. */
const ftsPhrase = (value) => `"${String(value).replace(/"/g, '""')}"`;

/** Converts YYYY-MM-DD or RFC3339 to epoch seconds. */
function toEpoch(value, label) {
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`\`${label}\` is not a valid date: "${value}". Use YYYY-MM-DD or RFC3339.`);
  }
  return Math.floor(ms / 1000);
}

function clampLimit(limit, fallback, max) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(n, 1), max);
}

/**
 * The archive stores the same conversation more than once (same msg_id with a different
 * source_pk), so we always group — and before the LIMIT, or counts come out ~3x inflated and
 * the limit returns too few.
 */
const GROUPING = 'GROUP BY m.msg_id, m.chat_jid, m.ts, m.text';

const MSG_COLUMNS =
  `m.msg_id AS message_id, m.chat_jid, m.chat_name, m.sender_name, m.sender_jid,` +
  ` m.from_me, m.text, m.message_type, m.media_title, m.media_path, m.ts,` +
  // This Mac's LOCAL time. In UTC, night-time messages fall on the next day and everything
  // reads shifted.
  ` strftime('%Y-%m-%d %H:%M', m.ts, 'unixepoch', 'localtime') AS timestamp`;

async function countDistinct(from, clause) {
  const parts = await Promise.all(inBoth((range) =>
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${from} WHERE (${clause})${range} ${GROUPING})`));
  return parts.reduce((total, [row]) => total + (row?.n ?? 0), 0);
}

async function selectMessages(from, clause, order, limit) {
  const parts = await Promise.all(inBoth((range) =>
    `SELECT ${MSG_COLUMNS} FROM ${from} WHERE (${clause})${range} ${GROUPING} ORDER BY m.ts ${order} LIMIT ${limit}`));
  if (parts.length === 1) return parts[0];
  const rows = parts.flat().sort((a, b) => (order === 'ASC' ? a.ts - b.ts : b.ts - a.ts));
  return rows.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* domain                                                              */
/* ------------------------------------------------------------------ */

// Careful with `chats.last_message_at`: some rows have corrupt dates (year 9026) that would top
// any date sort. We use max(m.ts) of the real messages, which can't lie.
const chatsSQL = (range) =>
  `SELECT c.jid, c.kind, c.name, c.unread_count,` +
  ` count(m.rowid) AS message_count,` +
  ` max(m.ts) AS last_ts` +
  ` FROM chats c LEFT JOIN messages m ON m.chat_jid = c.jid AND m.deleted_at IS NULL${range}` +
  ` WHERE c.deleted_at IS NULL`;

const ORDERS = {
  recent: (a, b) => (b.last_ts || 0) - (a.last_ts || 0),
  messages: (a, b) => b.message_count - a.message_count,
};

/**
 * The same person can have two JIDs: WhatsApp moved many contacts to the new "@lid" (Desktop
 * already stores them that way) while the iPhone or older chats have them by number. Without
 * joining them, a chat shows up twice and looking it up by name comes back "ambiguous". Each
 * archive's `contacts.lid` gives the pair.
 */
let aliasCache = null;

async function lidAliases() {
  if (aliasCache && Date.now() - aliasCache.t < 10 * 60 * 1000) return aliasCache.map;
  const sql = `SELECT jid, lid FROM contacts WHERE lid LIKE '%@lid' AND jid LIKE '%@s.whatsapp.net'`;
  const h = historyArchive();
  const rows = (await Promise.all([runSQL(sql), h ? runSQL(sql, h.db) : []])).flat();
  const map = new Map();
  for (const { jid, lid } of rows) { map.set(lid, jid); map.set(jid, lid); }
  aliasCache = { t: Date.now(), map };
  return map;
}

/** The JIDs a chat can appear under: the given one and, if there is one, its @lid ⇄ number pair. */
async function jidVariants(jid) {
  const pair = (await lidAliases()).get(jid);
  return pair ? [jid, pair] : [jid];
}

/**
 * Per-chat counts for the history archive are computed ONCE and kept in historico/chats.json:
 * it's a frozen snapshot and the query takes ~15 s, as long as the main one. Repeating it
 * doubled how long list_chats took, and warming it up at startup blocked each session's first
 * query. (The file's `corte` key is the on-disk name of the cutoff.)
 */
let historyChatsCache = null;

function historyChats(h) {
  if (historyChatsCache?.cutoff === h.cutoff) return historyChatsCache.promise;
  const file = path.join(HISTORY_DIR, 'chats.json');
  let promise;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.corte !== h.cutoff) throw new Error('it is from another import');
    promise = Promise.resolve(saved.chats);
  } catch {
    promise = runSQL(`${chatsSQL(` AND m.ts < ${h.cutoff}`)} GROUP BY c.jid`, h.db).then((chats) => {
      try { fs.writeFileSync(file, JSON.stringify({ corte: h.cutoff, chats })); } catch {}
      return chats;
    });
    promise.catch(() => { historyChatsCache = null; });
  }
  historyChatsCache = { cutoff: h.cutoff, promise };
  return promise;
}

/** Chats from both archives, joined per person. `nameFilter` (lowercase) filters by substring. */
async function queryChats(nameFilter = null) {
  const h = historyArchive();
  const filter = nameFilter ? ` AND lower(c.name) LIKE ${sqlString(`%${likeLiteral(nameFilter)}%`)} ESCAPE '\\'` : '';
  const [main, old, aliases] = await Promise.all([
    runSQL(`${chatsSQL(h ? ` AND m.ts >= ${h.cutoff}` : '')}${filter} GROUP BY c.jid`),
    h ? historyChats(h) : [],
    lidAliases(),
  ]);
  const parts = [main, nameFilter ? old.filter((c) => (c.name || '').toLowerCase().includes(nameFilter)) : old];
  const keyOf = (jid) => (jid.endsWith('@lid') && aliases.get(jid)) || jid;
  const byJid = new Map();
  parts.forEach((rows, i) => {
    for (const c of rows) {
      const prev = byJid.get(keyOf(c.jid));
      // Unread counts from the history archive are from the iPhone snapshot, not from today.
      if (!prev) { byJid.set(keyOf(c.jid), i === 0 ? { ...c } : { ...c, unread_count: 0 }); continue; }
      prev.unread_count += i === 0 ? c.unread_count : 0;
      prev.message_count += c.message_count;
      prev.last_ts = Math.max(prev.last_ts || 0, c.last_ts || 0) || null;
      prev.name ||= c.name;   // the main archive comes first and has the current name
    }
  });
  return [...byJid.values()].map((c) => ({
    ...c,
    last_message_at: c.last_ts ? new Date(c.last_ts * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null,
  }));
}

const listChats = async (order = 'recent') =>
  (await queryChats()).sort(ORDERS[order] || ORDERS.recent);

/** Resolves a chat name to its JID. If it already is a JID, returns it as is. */
async function resolveChatJID(chat) {
  const value = String(chat).trim();
  if (value.includes('@')) return value;

  const needle = value.toLowerCase();
  const rows = (await queryChats(needle)).sort(ORDERS.messages);

  if (rows.length === 0) {
    throw Object.assign(new Error(
      `No chat matches "${value}". They may be saved under a nickname or just a first name: ` +
      'try part of it (last name, first name), use list_chats with a filter, or ask the user how they have them saved. ' +
      "Don't guess which one it is: if in doubt, ask."
    ), { code: 'CHAT_NOT_FOUND' });
  }

  // Status chats (stories, *@*.status) have the same name as the person but aren't a
  // conversation: if there's another candidate, they don't count. Without this, looking up a
  // contact by name matched both their chat and their status feed, and came back "ambiguous".
  const conversations = rows.filter((c) => c.kind !== 'status' && !String(c.jid).endsWith('.status'));
  const pool = conversations.length ? conversations : rows;
  const exact = pool.filter((c) => (c.name || '').toLowerCase() === needle);
  const candidates = exact.length ? exact : pool;
  if (candidates.length === 1) return candidates[0].jid;

  const top = candidates.slice(0, 10).map((c) => `  • ${c.name} — ${c.jid} (${c.message_count} messages)`);
  throw new Error(
    `"${value}" matches ${candidates.length} chats. Call again with the exact JID:\n${top.join('\n')}` +
    (candidates.length > 10 ? `\n  … and ${candidates.length - 10} more` : '')
  );
}

/**
 * In ~21% of messages received in groups the sender wasn't resolved: `sender_jid` is the
 * group's JID and `sender_name` a base64 blob like "IAA=". There's nowhere to recover the
 * identity from (contacts.lid doesn't match), so we say so explicitly instead of showing the
 * blob as if it were a name.
 */
// Two ways internal identifiers leak through as if they were text: base64 with "=" padding
// (sender names, media hashes) and long uppercase hex (reactions). No real message looks like that.
const looksLikeBlob = (value) => {
  const v = String(value).trim();
  return /^[A-Za-z0-9+/]{2,}={1,2}$/.test(v) || /^[0-9A-F]{16,}$/.test(v);
};

function senderLabel(m) {
  if (m.from_me) return 'Me';
  const name = m.sender_name;
  if (name && !looksLikeBlob(name)) return name;

  // In a one-to-one chat the sender is, by definition, the other party: even if the name comes
  // as a blob, we know exactly who it is. The same goes for a status: the chat's owner posted it.
  if (isStatus(m)) return m.chat_name || 'someone';
  if (m.sender_jid && m.sender_jid === m.chat_jid) return m.chat_name || m.sender_jid;

  // In groups only the opaque @lid is left. We show it anyway because it's stable per person:
  // it lets you see that two messages came from the same unknown person.
  return m.sender_jid ? `(unidentified · ${m.sender_jid})` : '(unidentified sender)';
}

/** A readable label per type, for whatever isn't text. */
const TYPE_LABELS = {
  audio: 'audio', sticker: 'sticker', image: 'image', video: 'video',
  document: 'document', location: 'location', contact: 'contact',
  reaction: 'reaction', system: 'system message', group_event: 'group event',
};

/**
 * CAREFUL: for audio, stickers and images wacrawl puts the file's HASH in the `text` field.
 * Showing it as is made a voice note and a sticker look exactly the same — an
 * indistinguishable base64 blob. If the text is a blob, we show the type instead.
 */
function messageBody(m) {
  if (m.message_type === 'audio' && m.transcription !== undefined) {
    return m.transcription ? `(audio) «${m.transcription}»` : '(audio, no speech detected)';
  }
  const text = m.text ? String(m.text).trim() : '';
  if (text && !looksLikeBlob(text)) return text;

  const type = TYPE_LABELS[m.message_type] || m.message_type || 'no text';
  const title = m.media_title && !looksLikeBlob(m.media_title) ? `: ${m.media_title}` : '';
  return `(${type}${title})`;
}

/**
 * Statuses (24-hour stories) come mixed in with messages and look just like a one-to-one
 * message, even though nobody sent them to you: they're posted to all contacts. WhatsApp marks
 * them with the reserved address `status@broadcast`, so there's nothing to guess — just show it.
 */
const isStatus = (m) => String(m.sender_jid || '').includes('status@broadcast');

function formatMessages(rows, { withChat }) {
  if (rows.length === 0) return 'No results.';
  return rows
    .map((m) => {
      const where = withChat ? ` [${m.chat_name || m.chat_jid}]` : '';
      const mark = isStatus(m) ? ' [status]' : '';
      return `${m.timestamp || '?'}${where}${mark} ${senderLabel(m)}: ${messageBody(m)}`;
    })
    .join('\n');
}

/**
 * Compares the archive against WhatsApp Desktop LIVE and warns if it fell behind.
 *
 * `wacrawl doctor` reads the real source in ~1 s, so we can always tell how far behind we
 * are — even though catching up costs a full ~5 min sync, which is why it can't happen inside
 * a tool call.
 */
async function freshnessNote() {
  let archived;
  try {
    const [row] = await runSQL(`SELECT max(ts) AS t FROM messages WHERE deleted_at IS NULL`);
    archived = row?.t;
  } catch {
    return '';
  }
  if (!archived) return '';

  let source;
  try {
    const doc = JSON.parse(await runWacrawl(['--sync', 'never', 'doctor']));
    source = Date.parse(doc?.desktop?.newest_message) / 1000;
  } catch {
    return '';
  }
  if (!Number.isFinite(source)) return '';

  const minutes = Math.round((source - archived) / 60);
  if (minutes < 15) return '';

  const lag = minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return (
    `\n\n⚠️ The archive is ${lag} behind WhatsApp: there are newer messages that haven't been imported yet` +
    ' (the sync runs every 6 h and takes ~5 min, so it can\'t be done on the fly).' +
    ' For anything very recent, use recent_messages or look at WhatsApp directly.'
  );
}

/** Filters shared by the searches. */
async function commonFilters({ chat, since, until, fromMe }) {
  const where = ['m.deleted_at IS NULL'];
  if (chat) where.push(`m.chat_jid IN (${(await jidVariants(await resolveChatJID(chat))).map(sqlString).join(', ')})`);
  if (since) where.push(`m.ts >= ${toEpoch(since, 'since')}`);
  if (until) where.push(`m.ts < ${toEpoch(until, 'until')}`);
  if (typeof fromMe === 'boolean') where.push(`m.from_me = ${fromMe ? 1 : 0}`);
  return where;
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

/**
 * Server-level guidance (the `instructions` field of the MCP handshake). It's the formal place
 * for what doesn't fit in each tool's description: how to read the data and when NOT to trust
 * it. The figures come from measuring real archives, not from estimates.
 */
const SERVER_INSTRUCTIONS = `Access to the user's local WhatsApp: a read-only archive plus WhatsApp Desktop live. How to read the results:

DEPTH: __DEPTH__ If you can't find something old, say it isn't in the local archive — not that it doesn't exist.

FRESHNESS: the archive syncs every 6 h and a sync takes minutes, so it can NOT be refreshed during a query. Tools warn when they detect newer messages that haven't been imported yet. For "did they just reply?" use recent_messages, which reads WhatsApp live.

WHO SAID WHAT: in one-to-one chats attribution is reliable. In groups, many messages from people who aren't in the user's contacts show up as "(unidentified · <jid>@lid)": WhatsApp doesn't store their name. That lid is stable per person (it tells you two messages came from the same unknown person) but it does NOT give you a name. Never guess who sent such a message, and never attribute it to the chat's owner. "[status]" items are published stories, not messages sent to the user.

SEARCH: use search_messages first (full-text index, whole words). If it returns little or nothing, retry with deep_search, which matches substrings. Counts are exact over the whole archive; the messages shown are capped by 'limit', so a summary of a long period comes from a SAMPLE — say so instead of presenting it as complete. If a name doesn't show up, the person may be saved under a nickname: ask, don't guess.

ATTACHMENTS: images, PDFs and Word documents can be LOOKED AT/READ with view_attachments and COPIED to a normal folder with export_attachments. These two tools also look at WhatsApp LIVE: attachments do NOT have the archive's 6-hour lag — never use the lag to explain a missing attachment. If a tool says an attachment was NOT downloaded, tell the user exactly that: they have to open the chat in WhatsApp Desktop and click the file (large files don't download on their own); waiting won't fix it. __FILES__ VOICE NOTES: if local transcription is installed, voice notes appear as (audio) «text» and also show up in searches (section "In voice notes"). It's automatic transcription with Whisper: the gist is reliable, but proper names and foreign words can come out wrong — don't quote them as exact. When searching voice notes for a NAME and there are few results, also try how it might come out misspelled (e.g. a company name like "Viatik" can come out as "viatic"): transcription fails precisely on unusual names. If a voice note shows as "(audio)" with no text, it hasn't been transcribed yet: use transcribe_audio. "(audio, no speech detected)" is silence or noise.

WRITING: send_message really SENDS (if the user turned it on on this Mac). Use it only when the user explicitly asked to send, after showing them the exact recipient and text; if they say write, draft or prepare, use draft_message. Never retry a send that answered "Couldn't confirm". For drafts: draft_message (one) or draft_queue (several; it opens the next one when it detects the user sent the previous one). They open WhatsApp with the text typed in and the user decides whether to send it. For several messages ALWAYS use draft_queue, never several draft_message calls in a row: WhatsApp loses the previous draft when another chat opens. With draft_message and draft_queue never say you sent something: say it's ready for them to review and send. Only send_message answering "✓ Sent" is a send. If a safeguard blocks a draft (limit, repeated text, STOP), explain why; don't try to get around it by rewording the text or changing the recipient.`;

const DATE = 'YYYY-MM-DD or RFC3339';

const TOOLS = [
  {
    name: 'search_messages',
    description:
      "Searches the local WhatsApp message archive with the full-text index, including transcribed voice notes. Fast; it's the default search. It matches whole words — for fragments, or if what you expected doesn't show up, use deep_search.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (searched as a phrase).' },
        chat: { type: 'string', description: 'Optional: limit to one chat, by name or JID.' },
        since: { type: 'string', description: `Optional: only messages after this date. ${DATE}.` },
        until: { type: 'string', description: `Optional: only messages before this date. ${DATE}.` },
        from_me: { type: 'boolean', description: 'Optional: true = only mine, false = only received. Omit for both.' },
        limit: { type: 'integer', description: 'Maximum messages to show (default 50, max 500).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_chats',
    description:
      'Lists the archived chats (one-to-one and groups) with the date of the last message, the message count and unread messages. Sorted by most recent activity by default, so it answers "my latest conversations". With `filter`, only the chats whose name contains that text.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional: substring to look for in the chat name (case-insensitive).' },
        sort: {
          type: 'string',
          enum: ['recent', 'messages'],
          description: '`recent` (default) = most recent activity first. `messages` = most messages first.',
        },
        unread_only: { type: 'boolean', description: 'Optional: only chats with unread messages.' },
        limit: { type: 'integer', description: 'Maximum chats to return (default 100, max 2000).' },
      },
    },
  },
  {
    name: 'deep_search',
    description:
      'Exhaustive substring search over ALL messages, without the full-text index. Slower than search_messages but finds partial matches inside words. Use it when search_messages returns little, or to count or sweep everything.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for. By default it is matched as a literal phrase (case-insensitive).' },
        all_words: {
          type: 'boolean',
          description: 'If true, finds messages that contain ALL the words in `query`, in any order, instead of the exact phrase.',
        },
        chat: { type: 'string', description: 'Optional: limit to one chat, by name or JID.' },
        since: { type: 'string', description: `Optional: only messages after this date. ${DATE}.` },
        until: { type: 'string', description: `Optional: only messages before this date. ${DATE}.` },
        from_me: { type: 'boolean', description: 'Optional: true = only mine, false = only received. Omit for both.' },
        limit: { type: 'integer', description: 'Maximum messages to show (default 50, max 500). The total number of matches is reported anyway.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recent_messages',
    description:
      'Reads the NEWEST messages straight from WhatsApp Desktop, live (including what arrived seconds ago). Use it for "did they reply?", "what just came in", "latest messages in this chat". The other tools read the archive, which can be up to 6 h behind; this one is not. In exchange, it has no full-text search or deep history.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Optional: limit to one chat by name (substring, case-insensitive). Without it, returns the latest across all chats.' },
        minutes: { type: 'integer', description: 'Optional: only messages from the last N minutes.' },
        received_only: { type: 'boolean', description: 'Optional: true = only what others sent me, ignoring what I wrote.' },
        limit: { type: 'integer', description: 'Maximum messages (default 30, max 200).' },
      },
    },
  },
  {
    name: 'view_attachments',
    description:
      "Shows the images and documents sent in a chat so you can LOOK AT or READ them (not just know they exist). Word, RTF, OpenDocument and text files come back as full text. PDFs come back as an image of their first page. Includes what arrived minutes ago (it also looks at WhatsApp live, not just the archive). Only the files on this Mac exist: the ones WhatsApp Desktop downloaded since it was linked, plus the iPhone history's if it was imported.",
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Optional: limit to one chat, by name or JID.' },
        type: { type: 'string', enum: ['image', 'document', 'all'], description: 'What to fetch. Default: all.' },
        contains: { type: 'string', description: 'Optional: part of the file name or of the text that came with it.' },
        since: { type: 'string', description: `Optional: only newer ones. ${DATE}.` },
        until: { type: 'string', description: `Optional: only older ones. ${DATE}.` },
        limit: { type: 'integer', description: 'Maximum files (default 3, max 10). They are images: ask for few.' },
      },
    },
  },
  {
    name: 'export_attachments',
    description:
      "Copies a WhatsApp attachment to a normal folder (~/Downloads by default) — with its original name if it's a document — and returns the path, so it can be USED: uploaded, attached, handed to another tool. Includes what arrived minutes ago (it also looks at WhatsApp live). Unlike view_attachments, which only lets you look at it. Works for any file type, including ones that can't be shown (videos, audio, spreadsheets).",
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Optional: limit to one chat, by name or JID.' },
        contains: { type: 'string', description: 'Optional: part of the file NAME (e.g. "invoice") or of the text that came with it.' },
        type: {
          type: 'string',
          enum: ['image', 'document', 'audio', 'video', 'all'],
          description: 'Attachment type. Default: all.',
        },
        since: { type: 'string', description: `Optional: only newer ones. ${DATE}.` },
        until: { type: 'string', description: `Optional: only older ones. ${DATE}.` },
        destination: { type: 'string', description: 'Folder to copy it to. Default: ~/Downloads.' },
        limit: { type: 'integer', description: 'Maximum files to export (default 1, max 20).' },
      },
    },
  },
  {
    name: 'draft_message',
    description:
      "Opens WhatsApp Desktop on a one-to-one chat with a message ALREADY TYPED in the text box, ready for the user to review and send by pressing Enter. It SENDS NOTHING: it only leaves the draft. Use it when the user asks you to write or prepare a message for someone. Doesn't work for groups. Has hard limits (few per minute/hour, and never the same text to several chats).",
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Recipient: chat name, JID, or phone number with country code.' },
        text: { type: 'string', description: 'The message to leave typed. Max 2000 characters.' },
      },
      required: ['chat', 'text'],
    },
  },
  {
    name: 'send_message',
    description:
      'Really SENDS a WhatsApp message to a one-to-one chat, from the official Mac app, and verifies it went out. ' +
      'Use it ONLY if the user explicitly asked to SEND it (not "write" or "draft": that is draft_message) ' +
      "and after showing them the exact text and recipient. Doesn't work for groups. Off by default: the user turns it on per Mac. " +
      "If it says it couldn't confirm the send, do NOT call it again with the same message: it may have gone out anyway; ask the user to check WhatsApp.",
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Recipient: chat name, JID, or phone number with country code.' },
        text: { type: 'string', description: 'The exact message to send. Max 2000 characters.' },
      },
      required: ['chat', 'text'],
    },
  },
  {
    name: 'draft_queue',
    description:
      "For preparing SEVERAL messages in a row. Opens the first draft in WhatsApp and, each time it detects the user sent it, opens the next one by itself. It SENDS NOTHING: the user sends each message with Enter, at their own pace. If one isn't sent within 10 min, the queue pauses. Actions: create (with the list), status, skip (move on without sending the current one), resume, cancel. For a single message use draft_message.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'status', 'skip', 'resume', 'cancel'] },
        messages: {
          type: 'array',
          description: 'Only for create: a list of {chat, text}, in the order they will open.',
          items: {
            type: 'object',
            properties: { chat: { type: 'string' }, text: { type: 'string' } },
            required: ['chat', 'text'],
          },
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'transcribe_audio',
    description:
      'Transcribes voice notes that don\'t have text yet, with Whisper running on this Mac (nothing leaves the computer). Voice notes that are already transcribed show up on their own as (audio) «text» in read_chat and in searches: use this only if you see "(audio)" with no text and need to know what it says. Takes a few seconds per voice note (plus ~5 s the first time).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Optional: voice notes from one chat, by name or JID.' },
        since: { type: 'string', description: `Optional: only newer ones. ${DATE}.` },
        until: { type: 'string', description: `Optional: only older ones. ${DATE}.` },
        limit: { type: 'integer', description: 'Maximum voice notes (default 5, max 15), the most recent ones.' },
      },
    },
  },
  {
    name: 'read_chat',
    description:
      "Reads a chat's messages in chronological order (oldest to newest), with sender and date.",
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat name or JID.' },
        since: { type: 'string', description: `Optional: only messages after this date. ${DATE}.` },
        until: { type: 'string', description: `Optional: only messages before this date. ${DATE}.` },
        limit: { type: 'integer', description: 'Maximum messages (default 100, max 1000).' },
      },
      required: ['chat'],
    },
  },
];

const handlers = {
  async search_messages({ query, chat, since, until, from_me, limit }) {
    if (!query || !String(query).trim()) throw new Error('`query` is required.');
    const max = clampLimit(limit, 50, 500);

    const from = 'messages_fts f JOIN messages m ON m.rowid = f.rowid';
    const jid = chat ? await resolveChatJID(chat) : null;
    const where = await commonFilters({ chat: jid, since, until, fromMe: from_me });
    where.push(`messages_fts MATCH ${sqlString(ftsPhrase(String(query).trim()))}`);
    const clause = where.join(' AND ');

    const total = await countDistinct(from, clause);
    const rows = await attachTranscriptions(await selectMessages(from, clause, 'DESC', max));
    const voice = await searchVoiceNotes({ terms: [String(query).trim()], jid, since, until, fromMe: from_me, limit: Math.min(max, 20) });

    const scope = chat ? ` in ${chat}` : '';
    const shown = total > rows.length ? ` (showing ${rows.length})` : '';
    const hint = total === 0 && !voice?.total ? '\n\nTip: try deep_search, which matches substrings and usually finds more.' : '';
    return `${total} message(s) for "${query}"${scope}${shown}:\n\n${formatMessages(rows, { withChat: true })}${voiceNotesSection(voice)}${hint}${await freshnessNote()}`;
  },

  async list_chats({ filter, sort, unread_only, limit }) {
    const max = clampLimit(limit, 100, 2000);
    const mode = sort === 'messages' ? 'messages' : 'recent';

    let chats = await listChats(mode);
    if (filter) {
      const needle = String(filter).toLowerCase();
      chats = chats.filter((c) => (c.name || '').toLowerCase().includes(needle));
    }
    if (unread_only) chats = chats.filter((c) => c.unread_count > 0);

    const shown = chats.slice(0, max);
    if (shown.length === 0) return `No chats${filter ? ` matching "${filter}"` : ''}.`;

    const lines = shown.map((c) => {
      const kind = { group: 'group', dm: 'dm', status: 'status', newsletter: 'channel' }[c.kind] || c.kind;
      const unread = c.unread_count ? `, ${c.unread_count} unread` : '';
      const last = c.last_message_at ? `last ${c.last_message_at}` : 'no messages';
      return `• ${c.name || '(no name)'} — ${kind} — ${last} — ${c.message_count} messages${unread} — ${c.jid}`;
    });
    const order = mode === 'messages' ? 'most messages first' : 'most recent activity first';
    const more = chats.length > shown.length ? `\n… and ${chats.length - shown.length} more chats.` : '';
    return (
      `${shown.length} of ${chats.length} chat(s)${filter ? ` matching "${filter}"` : ''}` +
      ` — sorted by ${order}:\n\n${lines.join('\n')}${more}${await freshnessNote()}`
    );
  },

  async deep_search({ query, all_words, chat, since, until, from_me, limit }) {
    if (!query || !String(query).trim()) throw new Error('`query` is required.');
    const max = clampLimit(limit, 50, 500);

    const terms = all_words ? String(query).trim().split(/\s+/) : [String(query).trim()];
    const jid = chat ? await resolveChatJID(chat) : null;
    const where = await commonFilters({ chat: jid, since, until, fromMe: from_me });
    where.push('m.text IS NOT NULL');
    for (const t of terms) {
      where.push(`lower(m.text) LIKE ${sqlString(`%${likeLiteral(t.toLowerCase())}%`)} ESCAPE '\\'`);
    }
    const clause = where.join(' AND ');

    const total = await countDistinct('messages m', clause);
    const rows = await attachTranscriptions(await selectMessages('messages m', clause, 'DESC', max));
    const voice = await searchVoiceNotes({ terms, jid, since, until, fromMe: from_me, limit: Math.min(max, 20) });

    const mode = all_words ? 'all words' : 'literal phrase';
    const scope = chat ? ` in ${chat}` : '';
    const shown = total > rows.length ? ` (showing ${rows.length})` : '';
    return `${total} match(es) for "${query}"${scope} — ${mode}${shown}:\n\n${formatMessages(rows, { withChat: true })}${voiceNotesSection(voice)}${await freshnessNote()}`;
  },

  async recent_messages({ chat, minutes, received_only, limit }) {
    const max = clampLimit(limit, 30, 200);

    // Text, or attachments (image, video, audio, document) even without text.
    const where = ['(m.ZTEXT IS NOT NULL OR m.ZMESSAGETYPE IN (1, 2, 3, 8))'];
    if (chat) {
      where.push(`lower(cs.ZPARTNERNAME) LIKE ${sqlString(`%${likeLiteral(String(chat).toLowerCase())}%`)} ESCAPE '\\'`);
    }
    if (Number.isFinite(minutes)) {
      const since = Math.floor(Date.now() / 1000) - Math.floor(minutes) * 60 - APPLE_EPOCH;
      where.push(`m.ZMESSAGEDATE >= ${since}`);
    }
    if (received_only) where.push('m.ZISFROMME = 0');

    const rows = await runLiveSQL(
      `SELECT strftime('%Y-%m-%d %H:%M', m.ZMESSAGEDATE + ${APPLE_EPOCH}, 'unixepoch', 'localtime') AS timestamp,` +
      ` cs.ZPARTNERNAME AS chat_name, m.ZISFROMME AS from_me,` +
      ` gm.ZCONTACTNAME AS member_name, gm.ZMEMBERJID AS member_jid,` +
      ` m.ZPUSHNAME AS push_name, m.ZFROMJID AS sender_jid, m.ZTEXT AS text, m.ZMESSAGETYPE AS code, mi.ZMEDIALOCALPATH AS rel_path, mi.ZFILESIZE AS bytes` +
      ` FROM ZWAMESSAGE m` +
      ` LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION` +
      ` LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER` +
      ` LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM` +
      ` WHERE ${where.join(' AND ')} ORDER BY m.ZMESSAGEDATE DESC LIMIT ${max}`
    );

    if (rows.length === 0) {
      return `No messages${chat ? ` in chats matching "${chat}"` : ''}${Number.isFinite(minutes) ? ` in the last ${minutes} min` : ''}.`;
    }

    // Same rule as the archive: in a group, the member's ZCONTACTNAME/JID; in a one-to-one
    // chat, the sender is the other party.
    const lines = rows.map((m) => {
      const when = m.timestamp || '?';
      const chatName = m.chat_name || '(unnamed chat)';
      let who;
      if (m.from_me) who = 'Me';
      else if (m.member_name && !looksLikeBlob(m.member_name)) who = m.member_name;
      else if (m.member_jid) who = `(unidentified · ${m.member_jid})`;
      else if (m.push_name && !looksLikeBlob(m.push_name)) who = m.push_name;
      else who = chatName;
      const text = String(m.text || '').trim();
      const readable = text && !looksLikeBlob(text) ? text : '';
      // A document carries its name in ZTEXT: without this it looked like a text message.
      const type = { 1: 'image', 2: 'video', 3: 'audio', 8: 'document' }[m.code];
      const downloaded = m.rel_path ? 'can be viewed/exported' : `${m.bytes ? formatSize(m.bytes) + ', ' : ''}NOT downloaded in WhatsApp Desktop: click it there to download it`;
      const body = type === 'document' ? `(document: ${readable || 'no name'} — ${downloaded})`
        : type ? `(${type})${readable ? ' ' + readable : ''}` : (readable || '(attachment)');
      return `${when} [${chatName}] ${who}: ${body}`;
    });

    return (
      `${rows.length} message(s) LIVE from WhatsApp Desktop` +
      `${chat ? ` in "${chat}"` : ''}${Number.isFinite(minutes) ? ` (last ${minutes} min)` : ''},` +
      ` newest first:\n\n${lines.join('\n')}`
    );
  },

  async view_attachments({ chat, type, contains, since, until, limit }) {
    const max = clampLimit(limit, 3, 10);
    const types = type === 'image' ? ['image'] : type === 'document' ? ['document'] : ['image', 'document'];
    const { rows, liveWarning, chatNotFound } = await findAttachments({ chat, types, contains, since, until, limit: max * 3 });
    if (chatNotFound) throw new Error(`No chat matches "${chatNotFound}", neither in the archive nor in WhatsApp live.`);

    const content = [];
    let shown = 0;
    const problems = [];

    const notDownloaded = [];
    for (const m of rows) {
      if (shown >= max) break;
      if (m.downloaded === false) { notDownloaded.push(notDownloadedNote(m)); continue; }
      const file = m.media_path;
      if (!file || !fs.existsSync(file)) {
        problems.push(`${m.timestamp} ${m.chat_name}: the file is no longer on disk`);
        continue;
      }
      const ext = detectExtension(file);
      if (TEXT_EXTS.has(ext)) {
        try {
          const text = await documentText(file);
          const name = originalName(m) ? ` «${originalName(m)}»` : '';
          content.push({
            type: 'text',
            text: `${m.timestamp} [${m.chat_name || m.chat_jid}] ${senderLabel(m)} — document${name}, full text:\n\n${text || '(the document has no text)'}\n\n— end of document —`,
          });
          shown += 1;
        } catch (err) {
          problems.push(`${m.timestamp} ${m.chat_name}: couldn't read the ${ext} (${err.message.slice(0, 80)})`);
        }
        continue;
      }
      if (!RENDERABLE_EXTS.has(ext)) {
        problems.push(`${m.timestamp} ${m.chat_name}: ${ext || 'unknown format'} can't be shown (use export_attachments)`);
        continue;
      }
      try {
        const data = await renderToJpeg(file);
        const what = m.message_type === 'document' ? 'document (first page)' : 'image';
        const name = originalName(m) ? ` «${originalName(m)}»` : '';
        const title = m.media_title && !looksLikeBlob(m.media_title) ? ` — "${String(m.media_title).trim().slice(0, 120)}"` : '';
        content.push({
          type: 'text',
          text: `${m.timestamp} [${m.chat_name || m.chat_jid}] ${senderLabel(m)} — ${what}${name}${title}`,
        });
        content.push({ type: 'image', data, mimeType: 'image/jpeg' });
        shown += 1;
      } catch (err) {
        problems.push(`${m.timestamp} ${m.chat_name}: couldn't convert it (${err.message.slice(0, 80)})`);
      }
    }

    if (shown === 0) {
      const detail = (notDownloaded.length ? `\n\n${notDownloaded.join('\n')}` : '') +
        (problems.length ? `\n\n${problems.join('\n')}` : '') + (liveWarning ? `\n\n${liveWarning}` : '');
      return (
        `No files to show${chat ? ` in "${chat}"` : ''}.` +
        ` ${filesNote()}${detail}`
      );
    }

    content.unshift({
      type: 'text',
      text: (notDownloaded.length ? `⚠️ There are newer matching attachments that are NOT downloaded:\n${notDownloaded.join('\n')}\n\n` : '') +
        `${shown} file(s)${chat ? ` from "${chat}"` : ''}, newest first:`,
    });
    if (problems.length) {
      content.push({ type: 'text', text: `\nCouldn't show:\n${problems.join('\n')}` });
    }
    if (liveWarning) content.push({ type: 'text', text: `\n${liveWarning}` });
    return content;
  },

  async export_attachments({ chat, contains, type, since, until, destination, limit }) {
    const max = clampLimit(limit, 1, 20);
    const BY_TYPE = {
      image: ['image'], document: ['document'], audio: ['audio'], video: ['video'],
    };
    const types = BY_TYPE[type] || ['image', 'document', 'audio', 'video', 'sticker'];

    const dir = destination
      ? path.resolve(destination.replace(/^~(?=$|\/)/, os.homedir()))
      : path.join(os.homedir(), 'Downloads');
    if (!fs.existsSync(dir)) {
      throw new Error(`The destination folder doesn't exist: ${dir}`);
    }

    const { rows, liveWarning, chatNotFound } = await findAttachments({ chat, types, contains, since, until, limit: max * 3 });
    if (chatNotFound) throw new Error(`No chat matches "${chatNotFound}", neither in the archive nor in WhatsApp live.`);

    const done = [];
    const failed = [];

    const notDownloaded = [];
    for (const m of rows) {
      if (done.length >= max) break;
      if (m.downloaded === false) { notDownloaded.push(notDownloadedNote(m)); continue; }
      if (!m.media_path || !fs.existsSync(m.media_path)) {
        failed.push(`${m.timestamp} ${m.chat_name}: the file is not on disk`);
        continue;
      }
      // A readable name: the original file is a UUID, and media_title doesn't help
      // (sometimes it has the message text, sometimes a base64 blob).
      const clean = (s) => String(s || '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const base = [
        (m.timestamp || '').replace(/[: ]/g, '-'),
        clean(m.chat_name),
        clean(senderLabel(m)),
      ].filter(Boolean).join('_');

      // Documents keep their ORIGINAL name (WhatsApp stores it). Everything else: date_chat_sender.
      let ext = detectExtension(m.media_path);
      let stem = base;
      const original = originalName(m);
      if (original) {
        const cleanName = original.replace(/[\/:\0]/g, '-').trim();
        ext = path.extname(cleanName) || ext;
        stem = cleanName.slice(0, cleanName.length - path.extname(cleanName).length);
      }
      let out = path.join(dir, `${stem}${ext}`);
      for (let i = 2; fs.existsSync(out); i += 1) out = path.join(dir, `${stem} (${i})${ext}`);

      try {
        fs.copyFileSync(m.media_path, out);
        const kb = Math.round(fs.statSync(out).size / 1024);
        const caption = original ? m.media_title : m.text;
        const context = caption && !looksLikeBlob(caption) ? `\n   message: "${String(caption).trim().slice(0, 120)}"` : '';
        done.push(
          `• ${out}\n   ${kb} KB — ${m.timestamp} in "${m.chat_name}", from ${senderLabel(m)}${context}`
        );
      } catch (err) {
        failed.push(`${m.timestamp} ${m.chat_name}: ${err.message.slice(0, 80)}`);
      }
    }

    if (done.length === 0) {
      if (notDownloaded.length) return notDownloaded.join('\n');
      return (
        (liveWarning ? `${liveWarning}\n\n` : '') +
        `I didn't find any file to export${chat ? ` in "${chat}"` : ''}` +
        `${contains ? ` mentioning "${contains}"` : ''}.` +
        ` ${filesNote()}` +
        (failed.length ? `\n\n${failed.join('\n')}` : '')
      );
    }

    return (
      // If the newest match isn't downloaded, say so FIRST: otherwise the model uses the older
      // file that did get exported as if it were the one asked for.
      (notDownloaded.length ? `⚠️ The newest match(es) are NOT downloaded — what's exported below is a DIFFERENT, older file:\n${notDownloaded.join('\n')}\n\n` : '') +
      `${done.length} file(s) copied to ${dir}. Check that the date, chat and name are what the user asked for before using it:\n\n${done.join('\n')}` +
      (liveWarning ? `\n\n${liveWarning}` : '') +
      (failed.length ? `\n\nCouldn't copy:\n${failed.join('\n')}` : '')
    );
  },

  async draft_message({ chat, text }) {
    if (!chat || !String(chat).trim()) throw new Error('`chat` is required.');
    const body = String(text || '').trim();
    if (!body) throw new Error('`text` is empty.');
    if (body.length > LIMITS.maxLength) {
      throw new Error(`The text has ${body.length} characters; the maximum is ${LIMITS.maxLength}.`);
    }

    if (draftQueue && draftQueue.status === 'active') {
      throw new Error('A draft queue is running: opening another draft would overwrite the one the user is about to send. Wait for it to finish or cancel it with draft_queue.');
    }
    const recipient = await recipientFor(chat);

    const blocked = checkSafeguards(recipient.phone, body);
    if (blocked) throw new Error(blocked);

    await openDraft(recipient, body);

    const warning = recipient.known
      ? ''
      : '\n\n⚠️ You have never talked to this number. Check it is the right one before sending.';
    return (
      `Opened WhatsApp on the chat with "${recipient.name}" with the message typed in.\n` +
      `Nothing was sent: the user reviews it and presses Enter if it's right.${warning}`
    );
  },

  async send_message({ chat, text }) {
    const lim = loadLimits();
    if (!lim.allowSending) {
      throw new Error(
        'Sending is turned off on this Mac (it is by default). Meanwhile use draft_message, which leaves the message ' +
        'typed for the user to send. To turn sending on, the user runs ./enable-sending.sh from the wacrawl-mcp folder.'
      );
    }
    if (!chat || !String(chat).trim()) throw new Error('`chat` is required.');
    const body = String(text || '').trim();
    if (!body) throw new Error('`text` is empty.');
    if (body.length > lim.maxLength) throw new Error(`The text has ${body.length} characters; the maximum is ${lim.maxLength}.`);
    if (draftQueue && draftQueue.status === 'active') {
      throw new Error('A draft queue is running: sending now would overwrite the draft the user is about to send.');
    }

    const recipient = await recipientFor(chat);
    const blocked = checkSafeguards(recipient.phone, body, { mode: 'send' });
    if (blocked) throw new Error(blocked);

    const before = Date.now();
    await openDraft(recipient, body, { send: true });
    await sleep(1500);   // let WhatsApp open the chat and fill in the text

    // A second Enter is safe: if the first one sent it, the box is empty and nothing goes out.
    let sent = false;
    for (let attempt = 1; attempt <= 2 && !sent; attempt += 1) {
      await pressEnter();
      for (let i = 0; i < 12 && !sent; i += 1) {
        await sleep(500);
        sent = await detectSent(recipient, before);
      }
    }

    const note = recipient.known ? '' : ' (a number you had never talked to)';
    if (!sent) {
      return (
        `Couldn't confirm that the message to "${recipient.name}" went out: I pressed Enter but it didn't show up in WhatsApp. ` +
        "It's typed in the chat; have the user check it and send it. Do NOT retry: it could be sent twice."
      );
    }
    return `✓ Sent to "${recipient.name}"${note}, verified in WhatsApp:\n\n${body}`;
  },

  async draft_queue({ action, messages }) {
    if (action === 'status') return queueSummary();

    if (action === 'cancel') {
      if (!draftQueue) return 'There is no queue.';
      clearInterval(draftQueue.timer);
      draftQueue.status = 'cancelled';
      return `Queue cancelled. The draft that's open stays in WhatsApp; no more will open.\n\n${queueSummary()}`;
    }

    if (action === 'skip') {
      if (!draftQueue || !['active', 'paused'].includes(draftQueue.status)) return 'There is no queue running.';
      const current = draftQueue.items.find((x) => x.status === 'open');
      if (current) current.status = 'skipped';
      draftQueue.status = 'active';
      await openNext();
      return queueSummary();
    }

    if (action === 'resume') {
      if (!draftQueue || draftQueue.status !== 'paused') return 'There is no paused queue.';
      draftQueue.status = 'active';
      draftQueue.reason = null;
      const current = draftQueue.items.find((x) => x.status === 'open');
      // if it paused because of the wait, reopen that same draft (WhatsApp may have lost it)
      if (current) { current.status = 'pending'; }
      await openNext();
      return queueSummary();
    }

    if (action !== 'create') throw new Error(`Unknown action: ${action}`);

    if (draftQueue && ['active', 'paused'].includes(draftQueue.status)) {
      throw new Error('There is already a queue running. Cancel it or wait for it to finish before creating another one.');
    }
    if (fs.existsSync(KILL_SWITCH)) throw new Error(`Drafts are DISABLED: ${KILL_SWITCH} exists.`);
    const lim = loadLimits();
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('`messages` is empty.');
    if (messages.length > lim.queueMax) {
      throw new Error(`The queue has ${messages.length} messages; the maximum is ${lim.queueMax} (adjustable in ~/.wacrawl/limits.json).`);
    }

    // Validate EVERYTHING before opening the first one: better to fail here than halfway through.
    const items = [];
    const problems = [];
    const seen = new Map();
    for (const [n, m] of messages.entries()) {
      const text = String(m.text || '').trim();
      try {
        if (!text) throw new Error('empty text');
        if (text.length > lim.maxLength) throw new Error(`text has ${text.length} characters (max ${lim.maxLength})`);
        const r = await recipientFor(m.chat);
        if (seen.has(r.phone)) throw new Error(`same recipient as #${seen.get(r.phone)}`);
        seen.set(r.phone, n + 1);
        if (lim.antiBroadcast) {
          const same = items.find((i) => normalizeText(i.text) === normalizeText(text));
          if (same) throw new Error(`same text as the one for ${same.name} (anti-broadcast)`);
        }
        items.push({ ...r, text, status: 'pending' });
      } catch (err) {
        problems.push(`#${n + 1} ${m.chat}: ${err.message}`);
      }
    }
    if (problems.length) {
      throw new Error(`I didn't build the queue; fix this first:\n${problems.join('\n')}`);
    }
    if (items.length > lim.perHour) {
      throw new Error(`The queue has ${items.length} messages and the limit is ${lim.perHour} per hour (adjustable in ~/.wacrawl/limits.json).`);
    }

    draftQueue = { items, status: 'active', createdAt: Date.now() };
    draftQueue.timer = setInterval(watchQueue, POLL_MS);
    draftQueue.timer.unref?.();
    await openNext();

    return (
      `Queue ready with ${items.length} messages. I opened the first one in WhatsApp (${items[0].name}).\n` +
      'The user reviews it and presses Enter; when I detect it went out, I open the next one. ' +
      `Nothing is sent automatically.\n\n${queueSummary()}`
    );
  },

  async transcribe_audio({ chat, since, until, limit }) {
    const max = clampLimit(limit, 5, 15);
    const jid = chat ? await resolveChatJID(chat) : null;
    const where = await commonFilters({ chat: jid, since, until });
    where.push(`m.message_type = 'audio'`);
    const rows = await attachTranscriptions(await selectMessages('messages m', where.join(' AND '), 'DESC', max));
    if (!rows.length) return `No voice notes${chat ? ` in "${chat}"` : ''} in that period.`;

    const hasFile = (r) => r.media_path && fs.existsSync(r.media_path);
    const missing = rows.filter((r) => r.transcription === undefined && hasFile(r));
    const noFile = rows.filter((r) => r.transcription === undefined && !hasFile(r));
    const already = rows.length - missing.length - noFile.length;

    if (missing.length) {
      const res = await runTranscriber(whisperReady(), missing.map((r) => ({
        msg_id: r.message_id, chat_jid: r.chat_jid, chat_name: r.chat_name, sender_name: r.sender_name,
        from_me: r.from_me, ts: r.ts, media_path: r.media_path,
      })));
      for (const r of missing) {
        const k = `${r.message_id}|${r.chat_jid}`;
        if (k in res) r.transcription = res[k];
      }
    }

    const fresh = missing.filter((r) => r.transcription !== undefined).length;
    const failed = missing.length - fresh;
    const notes = [];
    if (already) notes.push(`${already} were already transcribed`);
    if (fresh) notes.push(`${fresh} transcribed now`);
    if (failed) notes.push(`${failed} couldn't be read (damaged or incomplete audio file; it can be played in WhatsApp)`);
    if (noFile.length) notes.push(`${noFile.length} have no file on this Mac (WhatsApp Desktop didn't download them; usually from before it was linked)`);
    rows.reverse();   // oldest to newest, the way you'd listen to them
    return `${rows.length} voice note(s)${chat ? ` in "${rows[0].chat_name || chat}"` : ''} — ${notes.join(', ')}.\n` +
      `Note: this is automatic transcription; proper names may come out wrong.\n\n${formatMessages(rows, { withChat: !chat })}`;
  },

  async read_chat({ chat, since, until, limit }) {
    if (!chat) throw new Error('`chat` is required.');
    const jid = await resolveChatJID(chat);
    const where = await commonFilters({ chat: jid, since, until });
    const clause = where.join(' AND ');

    const rows = await attachTranscriptions(await selectMessages('messages m', clause, 'ASC', clampLimit(limit, 100, 1000)));
    const name = rows[0]?.chat_name || chat;
    return `${rows.length} message(s) in "${name}" (${jid}), in chronological order:\n\n${formatMessages(rows, { withChat: false })}${await freshnessNote()}`;
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
        serverInfo: { name: 'wacrawl-mcp', version: '3.0.0' },
        instructions: SERVER_INSTRUCTIONS.replace('__DEPTH__', depthNote()).replace('__FILES__', filesNote()),
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args } = req.params || {};
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      // Tools return text, or an MCP content array when they send images along with their
      // context.
      // A tool failure (ambiguous chat, no number, limit reached) goes back as a result with
      // isError, NOT as a protocol error: Claude Desktop shows protocol errors as a bare "failed"
      // and the model never sees the reason. That's how it saw "failed" without knowing the
      // name matched 6 chats.
      try {
        const result = await handler(args || {});
        return { content: Array.isArray(result) ? result : [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err.message || String(err) }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Unsupported method: ${req.method}`), { code: -32601 });
  }
}

// Importable from check.sh to test the rendering without starting the server.
if (require.main !== module) {
  module.exports = { messageBody, senderLabel, formatMessages, looksLikeBlob, TYPE_LABELS, detectSent };
  return;
}

let buffer = '';
let pending = 0;
let stdinEnded = false;

function maybeExit() {
  // Do NOT use process.exit(): it truncates whatever hasn't been flushed to stdout yet, and a
  // base64 image doesn't fit in a single write. Release stdin and let node exit on its own once
  // nothing is pending.
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

    // Notifications (no id) get no response.
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
