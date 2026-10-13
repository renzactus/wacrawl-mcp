# WhatsApp para Claude (wacrawl-mcp)

Le da a **Claude Desktop** acceso a tu WhatsApp, desde tu Mac: buscar en todas tus conversaciones,
leer hilos, ver imágenes y PDFs que te mandaron, y dejarte mensajes **escritos pero sin enviar**
para que los mandes vos.

Todo corre en tu computadora. Tus chats no se suben a ningún servidor (ver [Privacidad](#privacidad)).

## Qué le podés pedir

- *"¿Qué me dijo Juan sobre la propuesta la semana pasada?"*
- *"Buscá en todos mis chats dónde se habló de la factura de marzo."*
- *"¿Cuáles son mis últimos 5 chats? ¿Me contestó Ana?"*
- *"Mostrame el PDF que me mandó Laura ayer"* — y lo lee de verdad.
- *"Pasame a Descargas la foto del contrato que mandaron en el grupo."*
- *"¿Qué me dijo Martín en el audio de ayer?"* — si instalás la [transcripción local](#notas-de-voz-opcional).
- *"Prepará un follow-up para Pedro con lo que hablamos"* — te abre WhatsApp con el mensaje escrito; lo mandás vos.
- *"Armá mensajes personalizados para estas 6 personas"* — te los va abriendo de a uno, a medida que mandás.

## Requisitos

| | |
|---|---|
| **Mac** con macOS 13 o más nuevo | no anda en Windows/Linux ([ver alternativa](#windows-o-linux)) |
| **WhatsApp Desktop** (la app de Mac, no WhatsApp Web), vinculada con tu teléfono | [whatsapp.com/download](https://www.whatsapp.com/download) o App Store |
| **Claude Desktop** | [claude.ai/download](https://claude.ai/download) |
| **Node.js 18+** | [nodejs.org](https://nodejs.org) o `brew install node` |

No necesita skills, plugins ni configuración extra en Claude: el server le explica a Claude cómo
usar cada herramienta y cómo interpretar los resultados.

## Instalación

**1. Bajá el repo y corré el instalador** (en Terminal):

```bash
git clone https://github.com/renzactus/wacrawl-mcp.git ~/wacrawl-mcp
cd ~/wacrawl-mcp
./instalar.sh
```

(El repo es privado: necesitás que te den acceso en GitHub, y tener `git` autenticado — por ejemplo
con `gh auth login`.)

Chequea los requisitos, instala `wacrawl` (verificando su checksum), arma tu archivo local, deja un
sync automático cada 6 horas, y te dice lo que falta. La primera importación tarda varios minutos.

Si macOS pregunta si **Terminal** puede acceder a datos de otras apps, aceptá: es para leer WhatsApp.

**2. Dale el permiso de disco** (macOS no deja hacerlo por script):

Ajustes del Sistema → **Privacidad y seguridad** → **Acceso total al disco** → botón **+** →
**⌘⇧G** → pegá la ruta que te mostró el instalador (termina en `/runtime/bin/node`) → **Abrir** → activalo.

> Ese permiso es sólo para una copia de node que usa **únicamente** este server — no para el node
> de tu sistema. Así ningún otro programa lo hereda. Sin él igual funciona casi todo; sólo no
> podés ver lo que llegó hace segundos ni usar la cola de mensajes.

**3. Registralo en Claude, con Claude cerrado:**

Cerrá Claude Desktop con **⌘Q** (cerrar la ventana no alcanza) y corré:

```bash
~/wacrawl-mcp/register.sh
```

Abrí Claude Desktop. Listo.

> **Por qué hay que cerrarlo:** Claude Desktop lee su configuración al abrir y **la reescribe al
> cerrarse**. Si la editás con la app abierta, al cerrarla se borra lo que agregaste. El script se
> niega a correr si detecta Claude abierto, para protegerte de eso. Si el instalador vio Claude
> cerrado, ya hizo este paso por vos.

## Probar que anda

Preguntale a Claude: *"¿cuáles son mis últimos 3 chats de WhatsApp?"*

Si algo no anda, corré el diagnóstico — muestra cómo se ve cada tipo de mensaje, si los horarios
están bien, cuánto atraso tiene el archivo y si el sync automático está funcionando:

```bash
~/wacrawl-mcp/check.sh
```

(usa `python3`; si macOS ofrece instalar las herramientas de desarrollador, aceptá.)

## Privacidad

**Qué queda en tu Mac:** todo tu WhatsApp. El archivo (`~/.wacrawl/`), las imágenes y documentos, y
el server mismo. Nada de eso se sube a ningún lado.

**Qué sale de tu Mac:** sólo lo que Claude *lee* para contestarte. Si le preguntás por un chat, los
mensajes que consulta pasan a esa conversación de Claude, igual que si los hubieras pegado vos. Eso
queda en tu historial de Claude como cualquier otro chat.

**Cuentas de Claude compartidas:** el acceso a tu WhatsApp es de **tu Mac**, no de la cuenta. Otra
persona que entre a la misma cuenta desde otra computadora **no** puede consultar tu WhatsApp. Pero
**sí puede ver tus conversaciones de Claude**, incluidos los mensajes de WhatsApp que Claude leyó en
ellas. Si varias personas usan la misma cuenta, cada una tiene que asumir que las demás ven lo que
consultó. Lo recomendable es una cuenta por persona (un plan Team, por ejemplo).

**Nunca envía nada.** Puede dejarte un mensaje escrito en WhatsApp, pero el que aprieta Enter sos
vos. No hay forma de que mande algo solo.

## Notas de voz (opcional)

Transcribe tus audios **en tu Mac, sin mandarlos a nadie**, con Whisper (el mismo tipo de modelo que
usan los servicios pagos). Después Claude los lee como texto y **los encuentra en las búsquedas**:
*"¿en qué audio me hablaron del precio?"* funciona.

```bash
~/wacrawl-mcp/setup-whisper.sh
```

- Necesita una Mac con **chip Apple** (M1 o posterior). Baja el modelo una vez (~1,6 GB).
- Transcribe todos los audios que tengas en disco en segundo plano (≈2 s por audio, sin frenar la
  Mac: trabaja el chip gráfico), y después los nuevos en cada sync automático.
- Si pedís un audio que todavía no se procesó, Claude lo transcribe en el momento.
- Transcribe de a ~13-17 veces la duración real: un audio de 1 minuto, unos 4 segundos.

**Calidad:** muy buena con español rioplatense. El punto débil son los **nombres propios poco
comunes** — sobre todo el de tu empresa, si no es una palabra del diccionario. Medido sin ayuda, un
nombre de empresa salió bien sólo 1 de cada 4 veces (y Zapia comete el mismo error). Eso importa más
para **buscar** que para entender: Claude deduce que "Lucio" es Lucho al leer, pero una búsqueda
por "Lucho" nunca encuentra ese audio.

Para eso está el **vocabulario** (`~/.wacrawl/vocabulario.txt`): una lista, por prioridad, de los
nombres que usás. No entrena nada — es una pista que se le da a Whisper en cada audio. El instalador
te arma uno sugerido a partir de lo que escribís en WhatsApp; **revisalo y poné arriba tu empresa,
equipo y clientes**. En los grupos, además, se suman solos los nombres de quienes más hablan ahí.

Medido con vocabulario, en 20 audios donde el nombre de la empresa salía mal: **de 0 a 11 bien**, y en
otros 8, un apodo **de 1 a 7**; sin inventar nombres en audios donde no se dijeron, y sin ser más lento.

Si editás el vocabulario, re-transcribí lo viejo (en segundo plano, retoma si se corta):

```bash
~/wacrawl-mcp/rehacer-transcripciones.sh
```

Sólo transcribe audios que estén en tu Mac (los que WhatsApp Desktop descargó desde que lo vinculaste).

## Mandar mensajes (borradores)

Claude no envía: **abre WhatsApp en el chat con el mensaje escrito** y vos lo revisás y mandás.

- **Uno:** *"prepará un mensaje para Ana diciendo…"*
- **Varios:** *"armá mensajes para estas personas y abrímelos en cola"*. Abre el primero; **cuando
  detecta que lo mandaste, abre el siguiente** (tarda ~3 s). Si te tomás tu tiempo con uno, espera.
  Si no mandás uno en 10 minutos, se pausa. Le podés decir *saltar*, *reanudar* o *cancelar*.

Barreras que vienen activadas, por si un modelo se desboca:

- máximo 3 borradores por minuto y 15 por hora
- no deja preparar **el mismo texto para varias personas** (patrón de difusión, que WhatsApp castiga)
- sólo chats individuales: WhatsApp no permite abrir grupos así
- avisa si es un número con el que nunca hablaste
- **botón de emergencia:** `touch ~/.wacrawl/STOP` frena todo; borrás ese archivo y vuelve

Las podés ajustar en `~/.wacrawl/limites.json`, por ejemplo `{"porHora": 40, "antiDifusion": false}`.
Claves: `porMinuto`, `porHora`, `largoMax`, `antiDifusion`, `colaMax`, `colaEsperaMin`.

> **Ojo con los mensajes en frío.** Que lo mandes vos a mano evita el riesgo de usar un cliente no
> oficial, pero WhatsApp igual puede restringir un número si muchos desconocidos lo bloquean o lo
> reportan. Poco volumen y mensajes realmente personalizados.

## Lo que no hace (y conviene saber)

- **No tiene todo tu historial.** Tiene lo que WhatsApp Desktop recibió del teléfono al vincularse
  (suelen ser meses, no años) más todo lo que llegó desde entonces. Si algo viejo no aparece, no
  está en tu Mac.
- **El archivo va hasta 6 horas atrás.** Actualizarlo tarda minutos, así que se hace en segundo
  plano. Para lo de último momento, Claude lee WhatsApp en vivo (necesita el permiso del paso 2).
- **En grupos grandes, muchos mensajes no tienen nombre de quién los mandó**: WhatsApp no guarda el
  nombre de la gente que no tenés agendada. Los chats individuales no tienen este problema.
- **Sólo hay archivos (fotos, PDFs) desde que vinculaste WhatsApp Desktop.** Los de antes nunca se
  bajaron a la Mac.
- **Los audios se transcriben sólo si instalás la [transcripción local](#notas-de-voz-opcional)**; si no, sabe que existen pero no qué dicen.
- **Para preparar un mensaje necesita el número de teléfono.** Funciona con tus contactos agendados;
  para gente no agendada WhatsApp oculta el número, y tenés que pasárselo vos.
- Si alguien está agendado con un apodo, buscalo por cómo lo tenés agendado.

## Problemas comunes

| Síntoma | Qué hacer |
|---|---|
| No aparece en Claude | Cerrá con **⌘Q**, corré `register.sh`, abrí. Si lo registraste con Claude abierto, se borró al cerrar. |
| macOS pregunta *"node would like to access data from other apps"* cada vez | Falta el paso 2 (o se le dio el permiso a otro node). Tiene que ser la ruta que termina en `/runtime/bin/node`. |
| Un audio aparece como "(audio)" sin texto | Todavía no se transcribió (la primera pasada tarda horas) o no está instalada: `check.sh audios`. Pedile a Claude que lo transcriba. |
| La cola no pasa al siguiente | Necesita el permiso del paso 2 para detectar que mandaste. Pedile *"estado de la cola"*: te dice por qué se pausó. |
| Las respuestas parecen viejas | `check.sh` → sección "Salud del sync". El sync se repara solo si WhatsApp renumeró su base; si no, te avisa con una notificación. |
| "No encontré ningún chat" con alguien que sí tenés | Está agendado con otro nombre o un apodo. Decile cómo lo tenés agendado. |

Registro del sync automático: `~/.wacrawl/wrapper.log`.

## Actualizar

```bash
cd ~/wacrawl-mcp && git pull
```

Cerrá y abrí Claude Desktop (⌘Q). No hace falta volver a registrar ni a dar permisos.

## Desinstalar

```bash
launchctl bootout gui/$(id -u)/com.openclaw.wacrawl.sync
rm ~/Library/LaunchAgents/com.openclaw.wacrawl.sync.plist
```

Con Claude cerrado, sacá el bloque `"wacrawl"` de
`~/Library/Application Support/Claude/claude_desktop_config.json`, y quitá la entrada de node en
Acceso total al disco. Tu archivo de WhatsApp queda en `~/.wacrawl/`: borralo sólo si estás seguro,
porque puede tener mensajes que tu WhatsApp ya no tiene.

## Windows o Linux

Esto depende de leer los archivos de WhatsApp Desktop para Mac. Para Windows/Linux, el mismo autor
de wacrawl tiene [wacli](https://github.com/openclaw/wacli): se vincula como dispositivo por QR,
guarda todo en SQLite local y tiene binarios para Windows. Encima se puede montar un server como este.

---

Cómo está hecho, por qué de cada decisión, y lo que cuesta caro volver a descubrir:
[NOTAS-TECNICAS.md](NOTAS-TECNICAS.md).
