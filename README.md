# wacrawl-mcp

MCP server (stdio) que le da a Claude Desktop acceso de **sólo lectura** al WhatsApp local de esta Mac.

Todo local: sin dependencias npm, sin red, sin nube. Nunca escribe, mueve ni borra ninguna base.

## Las dos fuentes

La decisión de diseño central: hay **dos** bases, y cada tool sabe de cuál lee.

| | Archivo (wacrawl) | En vivo (WhatsApp) |
|---|---|---|
| Qué es | `~/.wacrawl/wacrawl.db` | `ChatStorage.sqlite` de WhatsApp Desktop |
| Frescura | hasta 6h atrás | **segundos** |
| Búsqueda | full-text (FTS5) + subcadena | sólo últimos N mensajes |
| Profundidad | ~935k mensajes | lo que tenga la app |
| Velocidad | 1-3 s | 0,05 s |

**Por qué no una sola tool "inteligente" que elija:** conviene saber cuál contestó. Si el esquema
CoreData de WhatsApp cambia en una actualización de Meta, se rompe sólo la tool en vivo y el
histórico sigue intacto.

## Tools

| Tool | Fuente | Para qué |
|---|---|---|
| `buscar_whatsapp` | archivo | búsqueda full-text, rápida. La opción por defecto |
| `busqueda_profunda` | archivo | barrido por subcadena, encuentra dentro de palabras. Más lenta, más completa |
| `listar_chats` | archivo | chats por actividad reciente o por volumen, con no leídos |
| `leer_chat` | archivo | un hilo en orden cronológico |
| `mensajes_recientes` | **en vivo** | "¿me contestó?", lo de hace segundos |
| `ver_archivos` | archivo + disco | mirar imágenes y PDFs de verdad, no sólo saber que existen |
| `exportar_archivo` | archivo + disco | sacar un adjunto a ~/Downloads para usarlo: subirlo, adjuntarlo, pasarlo a otra herramienta |
| `preparar_mensaje` | abre WhatsApp | deja un mensaje **escrito pero sin enviar** en un chat; lo manda la persona con Enter |
| `cola_mensajes` | abre WhatsApp + en vivo | varios borradores: abre el siguiente **cuando detecta que mandaste el actual** |

Las tools del archivo avisan solas cuando quedó atrás, comparando contra WhatsApp en vivo
(`wacrawl doctor`, ~1 s):

> ⚠️ El archivo está 2 h atrás de WhatsApp: hay mensajes más nuevos que todavía no entraron.

## Borradores, no envíos

`preparar_mensaje` **no envía nada**: abre WhatsApp Desktop vía `whatsapp://send` con el texto en la
caja, y la persona aprieta Enter. Lo manda la app oficial, así que no hay riesgo de ban por cliente
no oficial. Verificado contra la base viva: el conteo de mensajes del chat no cambia al abrir un
borrador.

Las barreras están en código, no en el prompt (un modelo desbocado ignora instrucciones, no un `if`),
y los contadores se persisten en `~/.wacrawl/borradores.jsonl` para que reiniciar no los resetee:

- máximo 3 borradores por minuto y 15 por hora
- **anti-difusión**: el mismo texto (ignorando mayúsculas y espacios) a otro chat en la última hora → bloqueado
- sólo chats individuales: WhatsApp no permite abrir grupos por enlace
- aviso si el número nunca tuvo conversación
- interruptor de emergencia: `touch ~/.wacrawl/STOP` desactiva todo; borrarlo lo reactiva

### Varios mensajes: `cola_mensajes`

WhatsApp **no conserva** el texto de un borrador si se abre otro chat. Por eso nunca se abren dos
seguidos, ni con un timer (un timer pisa el borrador si la persona tarda en leer o corregir): el
server vigila la base viva cada 2,5 s y abre el siguiente **recién cuando detecta un mensaje tuyo
en ese chat**. Cuenta aunque hayas corregido el texto antes de mandarlo.

- valida toda la lista antes de abrir el primero (grupos, números sin resolver, destinatarios o textos repetidos)
- si no mandás uno en 10 min, se pausa; `reanudar` reabre ese mismo borrador, `saltar` pasa al siguiente
- mientras hay una cola activa, `preparar_mensaje` se niega a abrir otro borrador
- la detección necesita leer WhatsApp en vivo (permiso de macOS al runtime dedicado); sin él, la cola se pausa en vez de seguir a ciegas

### Límites ajustables

En `~/.wacrawl/limites.json`, por ejemplo `{"porHora": 40, "antiDifusion": false}`. Claves:
`porMinuto` (3), `porHora` (15), `largoMax` (2000), `antiDifusion` (true), `colaMax` (30),
`colaEsperaMin` (10). El riesgo de que WhatsApp restrinja la cuenta por conducta es de quien envía;
lo que no es ajustable es que **nunca se envía nada solo**.

Limitación: hace falta el número de teléfono. Los chats `@lid` se resuelven por la agenda; los de
gente no agendada (~250) no tienen número visible — WhatsApp lo oculta a propósito.

## Instalación

```bash
# 1. wacrawl (la fórmula sólo extrae un binario; no compila)
brew install openclaw/tap/wacrawl
wacrawl doctor && wacrawl import --copy-media

# 2. copia dedicada de node (ver "Permisos de macOS")
./setup-runtime.sh

# 3. el agente de sync cada 6h
./install.sh

# 4. registrar el server en Claude Desktop (con la app CERRADA)
./register.sh
```

## Permisos de macOS

Claude Desktop lanza los MCP servers vía `Contents/Helpers/disclaimer`, que corta la herencia de
permisos: el proceso responsable ante macOS pasa a ser **node**, no Claude. Por eso aparece
*"node would like to access data from other apps"* al leer el container de WhatsApp — y por eso
darle el permiso a Claude no sirve. Tampoco sirve leer vía wacrawl: macOS mira el proceso
responsable, no el binario que abre el archivo.

Dos defensas, y conviene tener las dos:

1. **`--copy-media` en el sync** deja los adjuntos en `~/.wacrawl/media`, fuera de la zona
   protegida. `ver_archivos` no necesita ningún permiso. Cuesta ~780 MB duplicados.
2. **`./setup-runtime.sh`** arma una copia de node en `runtime/`, usada sólo por este server. Se le
   da Acceso completo al disco a **esa** ruta, así `npx -y mongodb-mcp-server` y cualquier otro
   script de node NO lo heredan. Además la ruta es estable: el node de Homebrew está firmado
   ad-hoc, así que cada update le cambia la identidad y el permiso se pierde.

Sólo `mensajes_recientes` (que lee la base viva) depende de ese permiso. Sin él, las otras cuatro
tools siguen funcionando.

> **`register.sh` exige que Claude Desktop esté cerrado, y no es capricho.** La app lee
> `claude_desktop_config.json` al arrancar y **lo reescribe desde memoria al salir**: si se edita con
> la app abierta, el ⌘Q borra la entrada. Cerrar → editar → abrir.

Si `brew install` falla con *"Command Line Tools are too outdated"*, la fórmula igual sólo hace
`bin.install` de un tarball de release: bajalo de la URL que declara, verificá su `sha256` e
instalalo en `~/.local/bin`.

## Limitaciones reales (medidas, no estimadas)

1. **El histórico es de ~19 meses, no de 10 años.** El 99,93% del archivo es 2025-2026; antes de
   2025 hay 625 registros y prácticamente sin texto. WhatsApp Desktop no guarda esa historia local.
2. **Ventana ciega de hasta 6h en las tools del archivo.** El sync tarda ~5,4 min aunque entren 181
   mensajes (`import` no tiene incremental: re-mergea los 935k). No entra en un tool call — Claude
   Desktop corta a los 4 min. Para eso está `mensajes_recientes`.
3. **En grupos, ~103k mensajes no tienen remitente identificable.** No es un bug de acá: WhatsApp
   guarda el nombre vacío y un `@lid` opaco, y esos remitentes no están en la agenda. Verificado
   contra la base viva. Se muestra el `@lid`, que al menos es estable por persona. **Los DMs no
   están afectados.**
4. **La media local arranca el 2026-08-06.** Ese día WhatsApp Desktop empezó a
   descargarla (la política ya estaba en `image/audio/video/document = 1`); de antes
   no hay un solo archivo en esta Mac, aunque el mensaje figure. De ahí en adelante la
   cobertura es ~70% y crece sola. Las miniaturas `.thumb` no sirven: son JPEG de 72x72.
5. **Los audios no se transcriben**: se sabe que existen y cuándo, no qué dicen.
6. Los conteos son exactos (se cuentan sobre el total), pero cualquier síntesis de un período largo
   sale de una muestra acotada por `limit`.

## Notas de implementación

Cosas que cuesta caro volver a descubrir:

- **Nunca usar los subcomandos `chats` / `messages` / `search` de wacrawl.** Hacen un "backfill" que
  escribe y tarda **minutos** (medido: `chats --limit 2000` colgado 2m40s). Todo va por `wacrawl sql`,
  que es sólo lectura y tarda 1-3 s. Este fue el bug de los timeouts.
- **`wacrawl search` está roto de cobertura**, no el índice: por FTS via SQL, "error" en un grupo da
  69 resultados; el subcomando daba 1.
- **La tabla `messages` guarda cada conversación repetida** (mismo `msg_id`, distinto `source_pk`).
  Hay que agrupar por `msg_id, chat_jid, ts, text` **antes** del LIMIT, o los conteos salen ~3x
  inflados y el limit devuelve de menos.
- **`chats.last_message_at` tiene filas corruptas** (año 9026) que encabezarían cualquier orden por
  fecha. Se ordena por `max(ts)` de los mensajes reales.
- **Las llamadas al CLI van serializadas.** Dos en paralelo dan `SQLITE_BUSY` porque el auto-sync
  escribe. Hay reintento con backoff por si el agente de launchd está corriendo.
- **La base viva se abre con `mode=ro` + `-readonly`.** Nunca se escribe ni se crea WAL.
- Claude Desktop no hereda el PATH del shell: todas las rutas en la config son absolutas.
- **Los PDF se renderizan a imagen con `sips`, no se les extrae el texto.** macOS no trae nada
  nativo para extraerlo (Spotlight no indexa el container de WhatsApp, PyObjC no está), y
  renderizar funciona igual con PDFs escaneados. Sale sólo la primera página.
- **Nunca `process.exit()` con contenido pendiente en stdout**: trunca la respuesta, y una imagen
  en base64 no se vacía de una sola pasada.

## Verificar que anda

```bash
launchctl print gui/$(id -u)/com.openclaw.wacrawl.sync | grep -E "state|last exit"
tail ~/.wacrawl/sync.log
grep -i wacrawl ~/Library/Logs/Claude/mcp.log | tail -20
```
