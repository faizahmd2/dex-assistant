#!/bin/bash
echo "Stopping FaizBot..."
[ -f .dex.pid ] && kill "$(cat .dex.pid)" 2>/dev/null && rm .dex.pid
docker compose down
echo "Stopped."