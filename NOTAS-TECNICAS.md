# Notas técnicas

Para quien vaya a tocar el código. La guía de uso está en el [README](README.md).

MCP server (stdio) en un solo archivo, `server.js`, sin dependencias npm ni red. Se apoya en
[wacrawl](https://github.com/openclaw/wacrawl), que arma un archivo SQLite a partir de la base de
WhatsApp Desktop para Mac.

## Las dos fuentes

La decisión central: hay **dos** bases, y cada tool sabe de cuál lee.

| | Archivo (wacrawl) | En vivo (WhatsApp) |
|---|---|---|
| Qué es | `~/.wacrawl/wacrawl.db` | `ChatStorage.sqlite` de WhatsApp Desktop |
| Frescura | hasta 6 h atrás | segundos |
| Búsqueda | full-text (FTS5) + subcadena | sólo últimos N mensajes |
| Velocidad | 1-3 s | ~40 ms por consulta |
| Permiso de macOS | ninguno | Acceso total al disco para el runtime |

No hay una sola tool "inteligente" que elija: conviene saber cuál contestó. Si Meta cambia el
esquema CoreData de WhatsApp, se rompe sólo lo que lee en vivo y el histórico sigue intacto.

## Tools

| Tool | Fuente | Para qué |
|---|---|---|
| `buscar_whatsapp` | archivo | full-text, rápida; la opción por defecto |
| `busqueda_profunda` | archivo | subcadena (`LIKE`), encuentra dentro de palabras |
| `listar_chats` | archivo | por actividad reciente o por volumen, con no leídos |
| `leer_chat` | archivo | un hilo en orden cronológico |
| `mensajes_recientes` | en vivo | lo de hace segundos |
| `ver_archivos` | archivo + `~/.wacrawl/media` | devuelve imágenes y PDFs como imagen MCP |
| `exportar_archivo` | archivo + `~/.wacrawl/media` | copia un adjunto a una carpeta normal |
| `preparar_mensaje` | abre WhatsApp | un borrador sin enviar |
| `cola_mensajes` | abre WhatsApp + en vivo | varios borradores, de a uno, a medida que se mandan |
| `transcribir_audios` | archivo + Whisper local | transcribe en el momento audios que todavía no tienen texto |

Las tools del archivo comparan contra WhatsApp en vivo (`wacrawl doctor`, ~1 s) y avisan si el
archivo quedó atrás.

## Piezas

| Archivo | Qué hace |
|---|---|
| `server.js` | el MCP server |
| `instalar.sh` | instalación de punta a punta, idempotente |
| `setup-runtime.sh` | copia dedicada de node en `runtime/` (no versionada) |
| `install.sh` | renderiza la plantilla del plist y carga el agente de launchd |
| `sync-wrapper.sh` | lo que corre launchd cada 6 h: sync + auto-recuperación + avisos |
| `register.sh` | agrega el server a la config de Claude Desktop |
| `check.sh` | diagnóstico de fidelidad |
| `transcribir.py` | transcripción con Whisper/MLX (`--pendientes` o lista por `--stdin`) |
| `setup-whisper.sh` | instala uv, Python gestionado y el modelo; prueba y arranca la pasada inicial |
| `rehacer-transcripciones.sh` | re-transcribe en segundo plano lo hecho con otro vocabulario |
| `whisper.env` | versiones de Python, librería y modelo: única fuente de verdad |

## Permisos de macOS

Claude Desktop lanza los MCP servers vía `Contents/Helpers/disclaimer --pgroup`, que **corta la
herencia de permisos**: el proceso responsable ante macOS pasa a ser node, no Claude. Por eso
aparece *"node would like to access data from other apps"* al tocar el container de WhatsApp, y
por eso darle el permiso a Claude no sirve. Tampoco sirve que lo lea `wacrawl` (que tiene permiso
cuando lo lanza launchd): macOS mira el proceso responsable, no el binario que abre el archivo.
Esa hipótesis se probó y falló.

Dos defensas:

1. **`--copy-media` en el sync** deja los adjuntos en `~/.wacrawl/media`, fuera de la zona
   protegida. `ver_archivos` y `exportar_archivo` no necesitan permiso. Cuesta duplicar la media.
2. **Runtime dedicado** (`setup-runtime.sh`): una copia de node usada sólo por este server, que es
   la que recibe Acceso total al disco. Así no lo hereda todo lo que corre con node (por ejemplo un
   `npx -y paquete` que se baja de npm en cada arranque). Además la ruta y el binario quedan
   estables: el node de Homebrew está firmado ad-hoc, así que cada update le cambia la identidad y
   macOS invalida el permiso. El node de Homebrew no es autocontenido — carga `libnode.*.dylib` por
   `@rpath` desde `../lib`, que se copia también. `instalar.sh` no rehace el runtime si ya existe,
   para no invalidar el permiso.

## Lo que cuesta caro volver a descubrir

**wacrawl**

- **Nunca usar los subcomandos `chats` / `messages` / `search`.** Hacen un "backfill" que escribe y
  tarda minutos (medido: `chats --limit 2000` colgado 2m40s). Claude Desktop corta a los 4 min. Todo
  va por `wacrawl sql`, que es sólo lectura (rechaza todo lo que no sea un único SELECT) y tarda 1-3 s.
- **`wacrawl search` es incompleto; el índice no.** Por FTS vía SQL, "error" en un grupo da 69
  resultados; el subcomando daba 1.
- **No hay import incremental.** Cada sync re-mergea todo: ~5 min sobre ~1M de mensajes aunque
  entren 200. Por eso va en launchd y no al vuelo.
- **Cuando WhatsApp Desktop se re-vincula o se actualiza puede renumerar sus `source_pk`**, y
  wacrawl aborta con *"belongs to a different event"*. Se arregla con `import --restore`;
  `sync-wrapper.sh` lo hace solo, con backup previo, y revierte si el archivo se achica más de 5%.
- **`--db <ruta>` + `sql` sirve para consultar cualquier SQLite**, incluida la base viva de WhatsApp.
  Verificado en 0.3.7 y 0.4.2 que no la modifica (mismo md5, mismos archivos). `--db` no acepta URIs
  (`file:...?mode=ro`).
- **0.4.x guarda la media copiada por hash y sin extensión** (`media/46/4637a2f5…`); 0.3.x conservaba
  el nombre (`…/uuid.jpg`). Ninguna registra el tipo. `extensionDe()` lo deduce de los primeros bytes
  (y de la cola en los zip, donde está el índice que distingue `.docx`/`.xlsx`).
- `instalar.sh` instala una **versión fija** (hoy 0.4.2, probada con import de cero + todas las tools).
  Antes de subirla, repetir esa prueba.
- Dos llamadas en paralelo dan `SQLITE_BUSY` (el auto-sync escribe): todas las llamadas van por una
  cola, con reintento y backoff por si el agente de launchd está corriendo.

**Datos del archivo**

- **`messages` guarda cada conversación repetida** (mismo `msg_id`, distinto `source_pk`). Agrupar
  por `msg_id, chat_jid, ts, text` **antes** del LIMIT, o los conteos salen ~3x inflados y el limit
  devuelve de menos.
- **`chats.last_message_at` tiene filas corruptas** (año 9026). Ordenar por `max(ts)` real.
- `ts` es epoch Unix; en la base viva (CoreData) es desde 2001: sumar `978307200`.
- **En audios, stickers e imágenes, `text` tiene el hash del archivo**, no texto; en reacciones, un
  hex. Mostrarlo tal cual hacía que un audio y un sticker se vieran idénticos.
- **Los estados (historias) vienen mezclados con los mensajes**, marcados con
  `sender_jid = status@broadcast` y `chats.kind = 'status'`.
- **Remitentes en grupos**: para gente no agendada WhatsApp guarda el nombre vacío (un blob base64
  tipo `IAA=`) y un `@lid` opaco. No se recupera ni por `contacts.lid` ni por `group_participants`
  (la fila existe, sin nombre). En DMs el remitente es la contraparte del chat.
- Horarios en hora local de la Mac. En UTC, lo de la noche caía al día siguiente.

**Base viva de WhatsApp**

- `ZWAMESSAGE`, `ZWACHATSESSION`, `ZWAGROUPMEMBER`, `ZWAMEDIAITEM`. `ZTITLE` es el texto que
  acompaña al archivo, **no** su nombre; el nombre original no se guarda.
- **Un chat nuevo se crea con `ZCONTACTJID = <x>@lid` y el teléfono en `ZCONTACTIDENTIFIER`.**
  Buscar sólo por `ZCONTACTJID` hacía que la cola nunca detectara el envío a números nuevos.
- `LID.sqlite` (`ZWAPHONENUMBERLIDPAIR`) estaba vacía: para los `@lid` de gente no agendada no hay
  forma de saber el teléfono.
- La media local existe sólo desde que se vinculó WhatsApp Desktop (la política de descarga ya
  viene en `image/audio/video/document = 1`). Las miniaturas `.thumb` son JPEG de 72×72: no sirven.

**Claude Desktop**

- **Reescribe `claude_desktop_config.json` desde memoria al salir.** Editar con la app abierta = la
  entrada se pierde al cerrarla. `register.sh` se niega a correr si la app está abierta. `pgrep -x`
  no sirve para detectarla (macOS trunca el nombre a 16 caracteres).
- **Los fallos de una tool van como resultado con `isError: true`, no como error JSON-RPC.** Claude
  Desktop muestra los errores de protocolo como un "failed" pelado y el modelo nunca ve el motivo.
- No hereda el PATH del shell: rutas absolutas en la config.
- **Nunca `process.exit()` con stdout pendiente**: trunca la respuesta (una imagen en base64 no se
  vacía de una pasada).

**Borradores**

- `whatsapp://send?phone=…&text=…` abre el chat con el texto en la caja, sin enviar. Necesita
  teléfono: no sirve para grupos ni para `@lid` sin agenda.
- **WhatsApp no conserva un borrador si se abre otro chat.** Por eso la cola abre el siguiente sólo
  cuando detecta un mensaje propio en ese chat (polling cada 2,5 s a la base viva, ~40 ms por
  consulta), y no con un timer.
- Las barreras viven en código y sus contadores en disco (`~/.wacrawl/borradores.jsonl`): un modelo
  desbocado ignora instrucciones pero no un `if`, y reiniciar no las resetea.

**Transcripción de audios**

- Whisper `large-v3-turbo` sobre MLX (`mlx-whisper`), corrido con `uv run --with` para no compilar
  nada. Medido en un M4: 13-17x tiempo real; ~5 s de carga del modelo por proceso.
- Las transcripciones van a una base **aparte** (`~/.wacrawl/transcripciones.sqlite`, clave
  `msg_id + chat_jid`): el archivo de wacrawl nunca se escribe. El server las lee con
  `wacrawl --db … sql`, así funciona con cualquier versión de Node (sin `node:sqlite`).
- **Sin red al transcribir**: `HF_HUB_OFFLINE=1`, `UV_OFFLINE=1`, telemetría apagada. La red se usa
  sólo en `setup-whisper.sh` para bajar el modelo.
- **Python gestionado por uv** (`uv python install`), no el del sistema: Claude Desktop y launchd
  corren con un PATH mínimo, y con el Python de Homebrew `uv` no encontraba intérprete.
- El audio se pasa a WAV con `afconvert` (nativo, lee el Opus de WhatsApp: no hace falta ffmpeg) y
  se carga con `wave`. Se le pone extensión por symlink porque wacrawl 0.4.x guarda sin extensión.
- Base en **WAL** para que el server lea mientras se escribe. Las pasadas en segundo plano
  (`--pendientes`) tienen candado (`flock`) entre sí; un pedido desde Claude (`--stdin`) **no** lo
  espera — si la pasada inicial lo tiene una hora, Claude se colgaría hasta el timeout. Pueden correr
  en paralelo; en el peor caso se transcribe dos veces lo mismo (`INSERT OR REPLACE`).
- Anti-alucinaciones: se descartan segmentos con `no_speech_prob > 0.6` y `avg_logprob < -1`, y las
  frases de subtítulos de YouTube que Whisper inventa ante silencio ("Subtítulos realizados por la
  comunidad de Amara.org"). `condition_on_previous_text=False` evita que un error se arrastre.
- **Vocabulario** (`initial_prompt`): nombre del chat + en grupos, los 6 que más hablan (desde el
  archivo, sin emojis) + `~/.wacrawl/vocabulario.txt` por prioridad. **Whisper usa como mucho ~223
  tokens de pista y, si se pasa, descarta el PRINCIPIO**: por eso se arma término a término contando
  tokens con el tokenizer de Whisper y se corta en 180, por el final.
- Medido (A/B sobre los mismos audios): nombre de la empresa bien 0 → 11 de 20; apodo 1 → 7 de 8;
  12 audios al azar sin nombres inventados; velocidad igual (15,3x). El riesgo conocido del prompt
  es que induzca palabras en silencios: no apareció, y el filtro de `no_speech_prob` ayuda.
- Cada transcripción guarda `modelo = <modelo>|voc:<sha1 del vocabulario>`. `--rehacer` sólo vuelve
  a hacer las que tienen otra huella: se puede cortar y retomar, y editar el vocabulario no obliga a
  rehacer lo que ya estaba al día.
- `--vocabulario-base` sugiere uno desde los mensajes de **texto propios** (nombres en mayúscula a
  mitad de oración + apodos de los chats más activos). Excluye lo que empieza con `_`: **Zapia publica
  sus transcripciones como mensajes propios en cursiva**, con los mismos errores ("Viatic"), y sin ese
  filtro el error entraba al vocabulario.

**Los PDF se renderizan a imagen con `sips`**, no se les extrae el texto: macOS no trae nada nativo
para extraerlo (Spotlight no indexa el container de WhatsApp, PyObjC no está), y renderizar sirve
también para escaneados. Sale sólo la primera página.

## Tests

No hay suite; `check.sh` cubre la fidelidad del renderizado. Para probar sin efectos:

- `WACRAWL_OPEN_BIN=<script>` reemplaza al `open` que abre WhatsApp.
- `WACRAWL_DRAFTS_DIR=<dir>` aísla el log de borradores, `STOP` y `limites.json`.
- `WACRAWL_FAKE_SENT_FILE=<archivo>` simula envíos para la cola (ojo: saltea la consulta real a la
  base — así se escapó el bug de `ZCONTACTIDENTIFIER`; probá la detección real aparte).
- `WACRAWL_COLA_POLL_MS` acelera el polling.
- `WACRAWL_TEST_CONFIG=<archivo>` hace que `register.sh` escriba ahí y no chequee si Claude está abierto.
