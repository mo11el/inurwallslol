#!/bin/bash
# Move to the directory where this script is located
cd "$(dirname "$0")"

echo "=========================================="
echo "    Starting Aria iMessage Assistant      "
echo "=========================================="
echo ""

echo "[1/2] Starting Aria Finclaw Python Poller in the background..."
python3 aria-finclaw-poller.py &
POLLER_PID=$!

echo "[2/2] Starting Aria Core Engine (TypeScript)..."
echo "Aria is now running! Keep this window open."
echo "Press Ctrl+C to stop Aria."
echo "------------------------------------------"

# Run the main TS bot
npx tsx src/index.ts

# If the bot is stopped (Ctrl+C), clean up the background python poller
echo "Stopping background processes..."
kill $POLLER_PID
echo "Aria shut down gracefully."
