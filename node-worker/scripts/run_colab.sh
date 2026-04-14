#!/usr/bin/env bash
set -euo pipefail

python -m pip install --upgrade pip
pip install -r requirements.txt pyngrok

cat > /tmp/colab_worker.py <<'PY'
import os
from pyngrok import ngrok

port = int(os.environ.get("NODE_PORT", "8090"))
public = ngrok.connect(port, "http")
print(f"NGROK_URL={public.public_url}")
PY

python /tmp/colab_worker.py
uvicorn app:app --host 0.0.0.0 --port "${NODE_PORT:-8090}"
