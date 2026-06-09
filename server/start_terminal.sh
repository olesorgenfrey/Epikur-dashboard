#!/usr/bin/env bash
# ============================================================
# Practio — ttyd Web-Terminal Setup (Ubuntu/Debian)
# ============================================================
# Stellt ein voll interaktives Terminal als Web-App bereit,
# in dem Claude Code, Codex, vim, nano usw. laufen.
# ============================================================

set -e

# ── 1. ttyd installieren (falls nicht vorhanden) ────────────
if ! command -v ttyd &> /dev/null; then
  echo "→ Installiere ttyd…"
  sudo apt update
  sudo apt install -y ttyd
fi

# ── 2. cloudflared prüfen ───────────────────────────────────
if ! command -v cloudflared &> /dev/null; then
  echo "⚠  cloudflared nicht gefunden. Installiere mit:"
  echo "   wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
  echo "   sudo dpkg -i cloudflared-linux-amd64.deb"
  exit 1
fi

# ── 3. Login-Daten setzen ───────────────────────────────────
# WICHTIG: Passwort ändern! Ohne Login hätte jeder mit der URL Root-Zugang.
TTYD_USER="admin"
TTYD_PASS="HIER_PASSWORT_AENDERN"

if [ "$TTYD_PASS" = "HIER_PASSWORT_AENDERN" ]; then
  echo "⚠  Bitte zuerst TTYD_PASS in diesem Skript ändern!"
  exit 1
fi

# ── 4. ttyd starten (Port 7681) ─────────────────────────────
# -W = beschreibbar (interaktiv)
# -c = Basic-Auth Login
# bash = die Shell die gestartet wird
echo "→ Starte ttyd auf http://localhost:7681 …"
ttyd -W -p 7681 -c "${TTYD_USER}:${TTYD_PASS}" bash &
TTYD_PID=$!
echo "  ttyd läuft (PID $TTYD_PID)"

sleep 2

# ── 5. Cloudflare Tunnel öffnen ─────────────────────────────
echo "→ Öffne Cloudflare Tunnel…"
echo "  Die ausgegebene URL (….trycloudflare.com) ins Dashboard"
echo "  unter TTYD_URL eintragen."
echo ""
cloudflared tunnel --url http://localhost:7681

# Beim Beenden ttyd mitstoppen
trap "kill $TTYD_PID 2>/dev/null" EXIT
