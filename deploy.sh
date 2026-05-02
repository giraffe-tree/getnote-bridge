#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="getnote-bridge"
VAULT_PLUGIN_DIR="$HOME/Documents/giraffetree/project/code/ideas/thinking-flomo/.obsidian/plugins/$PLUGIN_ID"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building..."
npm --prefix "$SCRIPT_DIR" run build

mkdir -p "$VAULT_PLUGIN_DIR"

cp "$SCRIPT_DIR/main.js"       "$VAULT_PLUGIN_DIR/main.js"
cp "$SCRIPT_DIR/styles.css"    "$VAULT_PLUGIN_DIR/styles.css"
cp "$SCRIPT_DIR/manifest.json" "$VAULT_PLUGIN_DIR/manifest.json"

echo "Deployed to $VAULT_PLUGIN_DIR"
