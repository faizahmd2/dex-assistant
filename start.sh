#!/bin/bash
set -e
mkdir -p logs
echo "Starting FaizBot..."
docker compose up -d
echo "Qdrant + Embeddings started"

if ! curl -s http://localhost:11434/api/tags > /dev/null; then
  echo "ERROR: Ollama not running. Start it with: ollama serve"
  exit 1
fi
echo "Ollama running"

nohup node app/index.js >> logs/dex.log 2>&1 &
echo $! > .dex.pid
echo "FaizBot API started (pid $(cat .dex.pid)) — tail logs: npm run logs"