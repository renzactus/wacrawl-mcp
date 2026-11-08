#!/bin/bash
# Builds a dedicated copy of node for THIS server, in runtime/.
#
# Why: macOS asks the responsible process for permission, and that's node (Claude
# Desktop launches it through Helpers/disclaimer, which cuts off permission
# inheritance). If you give access to the shared node, EVERYTHING that runs with node
# inherits it — including, say, an `npx -y some-mcp-server` that downloads from npm on
# every start.
#
# With its own copy, the permission stays limited to this server. And since the path is
# stable, it isn't lost when Homebrew updates node.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/runtime"
SRC="$(readlink -f "$(command -v node)")"
[ -x "$SRC" ] || { echo "✗ Can't find node"; exit 1; }

rm -rf "$DIR"; mkdir -p "$DIR/bin" "$DIR/lib"
cp "$SRC" "$DIR/bin/node"

# Homebrew's node isn't self-contained: it loads libnode through @rpath from ../lib
PREFIX="$(dirname "$(dirname "$SRC")")"
for lib in "$PREFIX"/lib/libnode.*.dylib; do
  [ -f "$lib" ] && cp "$lib" "$DIR/lib/"
done

"$DIR/bin/node" --version >/dev/null || { echo "✗ The copy doesn't start"; exit 1; }

echo "✓ Dedicated runtime ready: $("$DIR/bin/node" --version), $(du -sh "$DIR" | cut -f1)"
echo
echo "Give Full Disk Access ONLY to this path"
echo "(System Settings → Privacy & Security → Full Disk Access, ⌘⇧G to paste it):"
echo
echo "  $DIR/bin/node"
