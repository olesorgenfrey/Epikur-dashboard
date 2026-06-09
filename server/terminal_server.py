#!/usr/bin/env python3
"""
Practio Terminal Server
=======================
Nimmt Befehle vom Dashboard-Code-Tab entgegen und führt sie aus.
Läuft auf deinem Server, exponiert über den Cloudflare Tunnel.

Start:
    pip install fastapi uvicorn
    python3 terminal_server.py
    # dann: cloudflared tunnel --url http://localhost:8765

WARNUNG: Dieser Server führt beliebige Shell-Befehle aus. Nur in einem
vertrauenswürdigen, privaten Kontext betreiben. Setze ein Token (unten).
"""
import subprocess
import os
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── CONFIG ────────────────────────────────────────────────
PORT = 8765
WORKDIR = os.path.expanduser("~")          # Startverzeichnis
ACCESS_TOKEN = ""                           # optional: hier ein Geheimnis setzen, dann im Frontend mitschicken
TIMEOUT = 30                                # max. Sekunden pro Befehl

app = FastAPI(title="Practio Terminal Server")

# CORS — erlaubt dem Dashboard (GitHub Pages) den Zugriff
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],                    # ggf. auf deine GitHub-Pages-URL einschränken
    allow_methods=["*"],
    allow_headers=["*"],
)

# aktuelles Arbeitsverzeichnis (für cd-Persistenz)
state = {"cwd": WORKDIR}


class Cmd(BaseModel):
    command: str


@app.get("/health")
def health():
    return {"status": "ok", "cwd": state["cwd"]}


@app.post("/exec")
def execute(cmd: Cmd, x_token: str = Header(default="")):
    if ACCESS_TOKEN and x_token != ACCESS_TOKEN:
        raise HTTPException(status_code=401, detail="Ungültiges Token")

    command = cmd.command.strip()

    # cd separat behandeln (subprocess.cwd ist nicht persistent)
    if command.startswith("cd "):
        target = command[3:].strip()
        new_path = os.path.abspath(os.path.join(state["cwd"], os.path.expanduser(target)))
        if os.path.isdir(new_path):
            state["cwd"] = new_path
            return {"stdout": "", "stderr": "", "cwd": state["cwd"]}
        return {"stdout": "", "stderr": f"cd: {target}: Verzeichnis nicht gefunden"}

    try:
        result = subprocess.run(
            command, shell=True, cwd=state["cwd"],
            capture_output=True, text=True, timeout=TIMEOUT,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "code": result.returncode,
            "cwd": state["cwd"],
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"Timeout nach {TIMEOUT}s"}
    except Exception as e:
        return {"stdout": "", "stderr": str(e)}


if __name__ == "__main__":
    import uvicorn
    print(f"Practio Terminal Server → http://localhost:{PORT}")
    print(f"Arbeitsverzeichnis: {WORKDIR}")
    print("Danach: cloudflared tunnel --url http://localhost:" + str(PORT))
    uvicorn.run(app, host="0.0.0.0", port=PORT)
