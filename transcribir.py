"""
Transcribe audios de WhatsApp con Whisper, 100% local (MLX en Apple Silicon).

Se corre con uv, que se baja Python y las librerías sin compilar nada:

    uv run --python 3.12 --with mlx-whisper==0.4.3 python transcribir.py --pendientes
    ... | uv run ... python transcribir.py --stdin      (lista JSON de audios por stdin)

Guarda los resultados en ~/.wacrawl/transcripciones.sqlite (una base aparte: el
archivo de wacrawl nunca se escribe desde acá). Lo que ya está transcripto no se
repite.

No toca la red: el modelo se baja una vez con setup-whisper.sh y después se
corre con HF_HUB_OFFLINE=1.
"""

import argparse
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import wave
import zlib

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

MODELO = os.environ.get("WHISPER_MODELO", "mlx-community/whisper-large-v3-turbo")
DIR = os.path.expanduser(os.environ.get("WACRAWL_DIR", "~/.wacrawl"))
ARCHIVO = os.path.join(DIR, "wacrawl.db")
TRANSCRIPCIONES = os.environ.get("WACRAWL_TRANSCRIPCIONES", os.path.join(DIR, "transcripciones.sqlite"))
VOCABULARIO = os.path.join(DIR, "vocabulario.txt")

# Whisper, ante silencio o música, a veces "completa" con frases de subtítulos
# de YouTube con las que fue entrenado. Si un segmento es sólo eso, es inventado.
ALUCINACIONES = (
    "subtítulos realizados por la comunidad de amara.org",
    "subtitulado por la comunidad de amara.org",
    "gracias por ver el video",
    "gracias por ver",
    "suscríbete al canal",
    "no olvides suscribirte",
    "¡suscríbete!",
)


def etiqueta():
    """Modelo + huella del vocabulario. Permite rehacer sólo lo transcripto con un vocabulario viejo."""
    import hashlib
    voc = "\n".join(vocabulario())
    return f"{MODELO}|voc:{hashlib.sha1(voc.encode()).hexdigest()[:8]}" if voc else MODELO


def abrir_transcripciones():
    os.makedirs(DIR, exist_ok=True)
    db = sqlite3.connect(TRANSCRIPCIONES, timeout=30)
    # WAL: el server puede leer transcripciones mientras esto escribe.
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        """CREATE TABLE IF NOT EXISTS transcripciones (
             msg_id TEXT NOT NULL, chat_jid TEXT NOT NULL,
             chat_name TEXT, sender_name TEXT, from_me INTEGER, ts INTEGER,
             duracion REAL, texto TEXT, modelo TEXT, creado INTEGER,
             PRIMARY KEY (msg_id, chat_jid))"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS transcripciones_chat_ts ON transcripciones (chat_jid, ts)")
    return db


def pendientes(db, limite, rehacer=False, antes=0, parte=""):
    """Audios con archivo en disco sin transcripción (o, con rehacer, transcriptos con otro
    vocabulario), el más nuevo primero. antes: sólo los anteriores a ese epoch. parte "K/N":
    sólo uno de cada N audios (por msg_id), para que N procesos se repartan el trabajo."""
    if not os.path.exists(ARCHIVO):
        sys.exit(f"No existe el archivo de wacrawl: {ARCHIVO}")
    if rehacer:
        hechos = {(m, c) for m, c in db.execute(
            "SELECT msg_id, chat_jid FROM transcripciones WHERE modelo = ?", (etiqueta(),))}
    else:
        hechos = {(m, c) for m, c in db.execute("SELECT msg_id, chat_jid FROM transcripciones")}
    # El archivo de wacrawl se abre ESTRICTAMENTE en sólo lectura.
    arch = sqlite3.connect(f"file:{ARCHIVO}?mode=ro", uri=True)
    filas = arch.execute(
        """SELECT msg_id, chat_jid, max(chat_name), max(sender_name), max(from_me), max(ts), max(media_path)
           FROM messages
           WHERE message_type = 'audio' AND media_path <> '' AND deleted_at IS NULL AND (? = 0 OR ts < ?)
           GROUP BY msg_id, chat_jid ORDER BY max(ts) DESC""", (antes, antes)
    ).fetchall()
    arch.close()
    k, n = (int(x) for x in parte.split("/")) if parte else (1, 1)
    salida = []
    for msg_id, chat_jid, chat_name, sender_name, from_me, ts, media_path in filas:
        if n > 1 and zlib.crc32(msg_id.encode()) % n != k - 1:
            continue
        if (msg_id, chat_jid) in hechos or not os.path.isfile(media_path):
            continue
        salida.append(dict(msg_id=msg_id, chat_jid=chat_jid, chat_name=chat_name, sender_name=sender_name,
                           from_me=from_me, ts=ts, media_path=media_path))
        if limite and len(salida) >= limite:
            break
    return salida


def a_wav(ruta, tmp):
    """Pasa el audio a WAV 16 kHz mono con afconvert (nativo de macOS, lee el Opus de WhatsApp).
    Se le da una extensión explícita porque wacrawl 0.4.x guarda la media sin extensión."""
    # La extensión tiene que coincidir con el contenido: afconvert no abre un MP4
    # que se llama .opus. wacrawl 0.4.x guarda sin extensión, así que se mira el archivo.
    with open(ruta, "rb") as f:
        cab = f.read(12)
    if cab[:4] == b"OggS":
        ext = ".opus"
    elif cab[4:8] == b"ftyp":
        ext = ".m4a"
    elif cab[:4] == b"RIFF" and cab[8:12] == b"WAVE":
        ext = ".wav"
    elif cab[:3] == b"ID3" or cab[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        ext = ".mp3"
    else:
        ext = os.path.splitext(ruta)[1] or ".opus"
    entrada = os.path.join(tmp, "in" + ext)
    salida = os.path.join(tmp, "out.wav")
    for viejo in os.listdir(tmp):
        os.remove(os.path.join(tmp, viejo))
    os.symlink(ruta, entrada)
    subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", entrada, salida],
                   check=True, capture_output=True)
    import numpy as np
    with wave.open(salida) as w:
        datos = w.readframes(w.getnframes())
        dur = w.getnframes() / w.getframerate()
    return np.frombuffer(datos, dtype=np.int16).astype(np.float32) / 32768.0, dur


def limpiar(resultado):
    partes = []
    for seg in resultado.get("segments", []):
        texto = seg.get("text", "").strip()
        if not texto:
            continue
        # Silencio con texto "inventado": Whisper mismo dice que probablemente no hay voz.
        if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0:
            continue
        if texto.lower().strip(" .!¡") in {a.strip(" .!¡") for a in ALUCINACIONES}:
            continue
        partes.append(texto)
    return " ".join(partes).strip()


# Whisper usa como pista como mucho ~223 tokens y, si se pasa, descarta el
# PRINCIPIO, que es justo donde va lo más importante. Por eso la pista se arma
# por prioridad y se corta por el final, con margen.
MAX_TOKENS_PISTA = 180

_vocabulario = None
_participantes = {}
_tokenizer = None


def vocabulario():
    """Términos del usuario, en orden de prioridad (uno por línea o separados por coma)."""
    global _vocabulario
    if _vocabulario is None:
        try:
            lineas = [l.strip() for l in open(VOCABULARIO, encoding="utf-8")]
        except FileNotFoundError:
            lineas = []
        _vocabulario = [p.strip() for l in lineas if l and not l.startswith("#") for p in l.split(",") if p.strip()]
    return _vocabulario


def participantes(chat_jid):
    """En un grupo, quiénes hablan más: así Whisper acierta los nombres de ESE grupo."""
    if not chat_jid or not chat_jid.endswith("@g.us") or not os.path.exists(ARCHIVO):
        return []
    if chat_jid not in _participantes:
        try:
            arch = sqlite3.connect(f"file:{ARCHIVO}?mode=ro", uri=True)
            filas = arch.execute(
                """SELECT sender_name, count(*) AS n FROM messages
                   WHERE chat_jid = ? AND from_me = 0 AND sender_name IS NOT NULL
                     AND sender_name NOT GLOB '*=' AND sender_name NOT GLOB '*[0-9][0-9][0-9]*'
                     AND ts >= strftime('%s','now','-120 days')
                   GROUP BY sender_name ORDER BY n DESC LIMIT 6""", (chat_jid,)).fetchall()
            arch.close()
            import re
            limpios = [re.sub(r"[^\w\s.\-]", "", n).strip() for n, _ in filas]   # sin emojis
            _participantes[chat_jid] = [n for n in limpios if n]
        except sqlite3.Error:
            _participantes[chat_jid] = []
    return _participantes[chat_jid]


def tokens(texto):
    global _tokenizer
    if _tokenizer is None:
        from mlx_whisper.tokenizer import get_tokenizer
        _tokenizer = get_tokenizer(multilingual=True, language="es", task="transcribe")
    return len(_tokenizer.encode(" " + texto))


def pista(chat_name, chat_jid=None):
    """Contexto para que Whisper acierte nombres: el chat, quién participa y el vocabulario."""
    base = f"Audio de WhatsApp en el chat «{chat_name}»." if chat_name else "Audio de WhatsApp."
    gente = participantes(chat_jid)
    if gente:
        base += " Participan " + ", ".join(gente) + "."
    elegidos = []
    for termino in vocabulario():
        prueba = base + " Vocabulario: " + ", ".join(elegidos + [termino]) + "."
        if tokens(prueba) > MAX_TOKENS_PISTA:
            break
        elegidos.append(termino)
    return base + (" Vocabulario: " + ", ".join(elegidos) + "." if elegidos else "")


def vocabulario_base():
    """Sugerencia de vocabulario desde lo que la persona ESCRIBE: los nombres propios que más usa
    en sus mensajes y los apodos de sus chats más activos. Excluye las transcripciones de bots
    (Zapia las publica en cursiva como mensajes propios, y con los mismos errores)."""
    import re, collections
    arch = sqlite3.connect(f"file:{ARCHIVO}?mode=ro", uri=True)
    textos = [t for (t,) in arch.execute(
        """SELECT max(text) FROM messages WHERE message_type='text' AND from_me=1 AND text IS NOT NULL
           AND ts >= strftime('%s','now','-150 days') GROUP BY msg_id""")
        if t and not t.lstrip().startswith("_") and "Zapia" not in t]
    chats = [n for (n,) in arch.execute(
        """SELECT c.name FROM chats c JOIN messages m ON m.chat_jid = c.jid
           WHERE c.kind = 'dm' AND c.name IS NOT NULL AND m.ts >= strftime('%s','now','-150 days')
           GROUP BY c.jid ORDER BY count(*) DESC LIMIT 25""")]
    arch.close()
    meses = {"ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "set", "oct", "nov", "dic",
             "jan", "apr", "aug", "dec"}
    cap, total = collections.Counter(), collections.Counter()
    for t in textos:
        for oracion in re.split(r"[.!?\n:;]+", t):
            palabras = re.findall(r"[A-Za-zÁÉÍÓÚÑáéíóúñü][\wÁÉÍÓÚÑáéíóúñü]+", oracion)
            for i, w in enumerate(palabras):
                total[w.lower()] += 1
                if i > 0 and w[0].isupper() and not w.isupper():
                    cap[w] += 1
    propios = [w for w, c in cap.most_common()
               if c >= 6 and len(w) >= 3 and c / total[w.lower()] >= 0.6 and w.lower() not in meses]
    apodos = []
    for n in chats:
        primero = re.sub(r"[^\wÁÉÍÓÚÑáéíóúñü]", "", n.split()[0]) if n.split() else ""
        if len(primero) >= 3 and not primero.isdigit():
            apodos.append(primero)
    vistos, salida = set(), []
    for w in apodos + propios:
        if w.lower() not in vistos:
            vistos.add(w.lower())
            salida.append(w)
    return ("# Vocabulario sugerido a partir de lo que escribís en WhatsApp. REVISALO:\n"
            "# va por prioridad (lo primero pesa más); borrá lo que sobre y agregá tu empresa,\n"
            "# equipo, clientes y términos de tu trabajo. Uno por línea.\n" + "\n".join(salida[:60]))


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--pendientes", action="store_true", help="transcribir lo que falte del archivo")
    g.add_argument("--stdin", action="store_true", help="lista JSON de audios por stdin")
    g.add_argument("--rehacer", action="store_true", help="re-transcribir lo hecho con otro vocabulario")
    g.add_argument("--vocabulario-base", action="store_true", help="imprimir un vocabulario sugerido")
    ap.add_argument("--limite", type=int, default=0, help="máximo de audios (0 = sin límite)")
    ap.add_argument("--minutos", type=float, default=0, help="cortar después de N minutos (0 = sin límite)")
    ap.add_argument("--archivo", help="otro archivo de wacrawl (ej. el histórico del iPhone) en vez del principal")
    ap.add_argument("--antes", type=int, default=0, help="sólo audios anteriores a este epoch")
    ap.add_argument("--parte", default="", help="K/N: la parte K de N, para correr N procesos en paralelo")
    args = ap.parse_args()
    m = re.fullmatch(r"([1-9]\d*)/([1-9]\d*)", args.parte) if args.parte else None
    if args.parte and not (m and int(m[1]) <= int(m[2])):
        sys.exit("--parte va como K/N, ej. 2/3")
    if args.archivo:
        global ARCHIVO
        ARCHIVO = os.path.expanduser(args.archivo)

    if args.vocabulario_base:
        print(vocabulario_base())
        return

    # Nunca dos pasadas en segundo plano a la vez (la inicial y el sync de las
    # 6h): duplicarían todo el trabajo. Un pedido puntual desde Claude (--stdin)
    # NO espera este candado: si la pasada inicial lo tiene una hora, Claude se
    # quedaría colgado. Puede correr en paralelo; la base está en WAL.
    os.makedirs(DIR, exist_ok=True)
    if args.pendientes or args.rehacer:
        # Cada archivo y cada parte con su candado: una pasada larga sobre el histórico no
        # frena la de los audios nuevos que corre después de cada sync.
        sufijo = ("-" + os.path.basename(os.path.dirname(ARCHIVO)) if args.archivo else "") + \
                 ("-" + args.parte.replace("/", "de") if args.parte else "")
        candado = open(os.path.join(DIR, f"transcribir{sufijo}.lock"), "w")
        try:
            fcntl.flock(candado, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("ya hay otra pasada de transcripción corriendo", file=sys.stderr)
            return

    db = abrir_transcripciones()
    if args.stdin:
        lista = json.load(sys.stdin)
        hechos = {(m, c) for m, c in db.execute("SELECT msg_id, chat_jid FROM transcripciones")}
        lista = [a for a in lista if (a["msg_id"], a["chat_jid"]) not in hechos]
    else:
        lista = pendientes(db, args.limite, rehacer=args.rehacer, antes=args.antes, parte=args.parte)

    if not lista:
        print("nada para transcribir", file=sys.stderr)
        return

    try:
        import mlx_whisper
    except ImportError:
        sys.exit("Falta mlx-whisper: corré ./setup-whisper.sh")

    inicio = time.time()
    hechos = errores = seguidos = 0
    seg_audio = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        for a in lista:
            if args.minutos and time.time() - inicio > args.minutos * 60:
                print(f"corte por tiempo ({args.minutos} min)", file=sys.stderr)
                break
            try:
                audio, dur = a_wav(a["media_path"], tmp)
                r = mlx_whisper.transcribe(audio, path_or_hf_repo=MODELO, language="es",
                                           condition_on_previous_text=False,
                                           initial_prompt=pista(a.get("chat_name"), a.get("chat_jid")))
                texto = limpiar(r)
            except Exception as e:  # un audio roto no frena al resto
                errores += 1
                seguidos += 1
                print(f"error en {a['msg_id']}: {str(e)[:120]}", file=sys.stderr)
                if seguidos >= 10:
                    # Diez seguidos no son audios rotos sino la Mac: sin memoria, afconvert dejó
                    # de abrir todo y una pasada quemó 45.000 audios en minutos. Se espera; lo que
                    # falló no se guarda, así que se reintenta en la próxima pasada.
                    print("10 errores seguidos: espero 2 min", file=sys.stderr)
                    time.sleep(120)
                    seguidos = 0
                continue
            seguidos = 0
            db.execute(
                "INSERT OR REPLACE INTO transcripciones VALUES (?,?,?,?,?,?,?,?,?,?)",
                (a["msg_id"], a["chat_jid"], a.get("chat_name"), a.get("sender_name"), a.get("from_me"),
                 a.get("ts"), round(dur, 1), texto, etiqueta(), int(time.time())),
            )
            db.commit()
            hechos += 1
            seg_audio += dur
            print(json.dumps({"msg_id": a["msg_id"], "chat_jid": a["chat_jid"], "duracion": round(dur, 1),
                              "texto": texto}, ensure_ascii=False), flush=True)

    total = time.time() - inicio
    print(f"transcriptos {hechos} ({seg_audio/60:.1f} min de audio) en {total:.0f}s, errores {errores}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
