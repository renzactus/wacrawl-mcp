#!/bin/bash
# Arma una copia dedicada de node para ESTE server, en runtime/.
#
# Por qué: macOS le pide permiso al proceso responsable, que es node (Claude
# Desktop lo lanza vía Helpers/disclaimer, que corta la herencia de permisos).
# Si le damos acceso al node compartido, TODO lo que corra con node lo hereda
# — incluido `npx -y mongodb-mcp-server`, que se baja de npm en cada arranque.
#
# Con una copia propia, el permiso queda acotado a este server. Y como la ruta
# es estable, no se pierde cuando Homebrew actualice node.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/runtime"
SRC="$(readlink -f "$(command -v node)")"
[ -x "$SRC" ] || { echo "✗ No encuentro node"; exit 1; }

rm -rf "$DIR"; mkdir -p "$DIR/bin" "$DIR/lib"
cp "$SRC" "$DIR/bin/node"

# El node de Homebrew no es autocontenido: carga libnode por @rpath desde ../lib
PREFIX="$(dirname "$(dirname "$SRC")")"
for lib in "$PREFIX"/lib/libnode.*.dylib; do
  [ -f "$lib" ] && cp "$lib" "$DIR/lib/"
done

"$DIR/bin/node" --version >/dev/null || { echo "✗ La copia no arranca"; exit 1; }

echo "✓ Runtime dedicado listo: $("$DIR/bin/node" --version), $(du -sh "$DIR" | cut -f1)"
echo
echo "Dale Acceso completo al disco SÓLO a esta ruta"
echo "(Ajustes → Privacidad y Seguridad → Acceso completo al disco, ⌘⇧G para pegarla):"
echo
echo "  $DIR/bin/node"
