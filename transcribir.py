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
import sqlite3
import subprocess
import sys
import tempfile
import time
import wave

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

MODELO = os.environ.get("WHISPER_MODELO", "mlx-community/whisper-large-v3-turbo")
DIR = os.path.expanduser(os.environ.get("WACRAWL_DIR", "~/.wacrawl"))
ARCHIVO = os.path.join(DIR, "wacrawl.db")
TRANSCRIPCIONES = os.path.join(DIR, "transcripciones.sqlite")
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


def pendientes(db, limite):
    """Audios con archivo en disco que todavía no tienen transcripción, el más nuevo primero."""
    if not os.path.exists(ARCHIVO):
        sys.exit(f"No existe el archivo de wacrawl: {ARCHIVO}")
    hechos = {(m, c) for m, c in db.execute("SELECT msg_id, chat_jid FROM transcripciones")}
    # El archivo de wacrawl se abre ESTRICTAMENTE en sólo lectura.
    arch = sqlite3.connect(f"file:{ARCHIVO}?mode=ro", uri=True)
    filas = arch.execute(
        """SELECT msg_id, chat_jid, max(chat_name), max(sender_name), max(from_me), max(ts), max(media_path)
           FROM messages
           WHERE message_type = 'audio' AND media_path <> '' AND deleted_at IS NULL
           GROUP BY msg_id, chat_jid ORDER BY max(ts) DESC"""
    ).fetchall()
    arch.close()
    salida = []
    for msg_id, chat_jid, chat_name, sender_name, from_me, ts, media_path in filas:
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
    entrada = os.path.join(tmp, "in.opus")
    salida = os.path.join(tmp, "out.wav")
    for f in (entrada, salida):
        if os.path.lexists(f):
            os.remove(f)
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


def pista(chat_name):
    """Contexto para que Whisper acierte nombres: el chat y un vocabulario opcional del usuario."""
    p = f"Audio de WhatsApp, chat: {chat_name}." if chat_name else "Audio de WhatsApp."
    try:
        voc = open(VOCABULARIO, encoding="utf-8").read().replace("\n", ", ").strip(", ")
        if voc:
            p += f" Palabras que pueden aparecer: {voc[:400]}."
    except FileNotFoundError:
        pass
    return p


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--pendientes", action="store_true", help="transcribir lo que falte del archivo")
    g.add_argument("--stdin", action="store_true", help="lista JSON de audios por stdin")
    ap.add_argument("--limite", type=int, default=0, help="máximo de audios (0 = sin límite)")
    ap.add_argument("--minutos", type=float, default=0, help="cortar después de N minutos (0 = sin límite)")
    args = ap.parse_args()

    # Nunca dos pasadas en segundo plano a la vez (la inicial y el sync de las
    # 6h): duplicarían todo el trabajo. Un pedido puntual desde Claude (--stdin)
    # NO espera este candado: si la pasada inicial lo tiene una hora, Claude se
    # quedaría colgado. Puede correr en paralelo; la base está en WAL.
    os.makedirs(DIR, exist_ok=True)
    if args.pendientes:
        candado = open(os.path.join(DIR, "transcribir.lock"), "w")
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
        lista = pendientes(db, args.limite)

    if not lista:
        print("nada para transcribir", file=sys.stderr)
        return

    try:
        import mlx_whisper
    except ImportError:
        sys.exit("Falta mlx-whisper: corré ./setup-whisper.sh")

    inicio = time.time()
    hechos = errores = 0
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
                                           initial_prompt=pista(a.get("chat_name")))
                texto = limpiar(r)
            except Exception as e:  # un audio roto no frena al resto
                errores += 1
                print(f"error en {a['msg_id']}: {str(e)[:120]}", file=sys.stderr)
                continue
            db.execute(
                "INSERT OR REPLACE INTO transcripciones VALUES (?,?,?,?,?,?,?,?,?,?)",
                (a["msg_id"], a["chat_jid"], a.get("chat_name"), a.get("sender_name"), a.get("from_me"),
                 a.get("ts"), round(dur, 1), texto, MODELO, int(time.time())),
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
