#!/usr/bin/env bash
# simulator/setup.sh
#
# Sets up loopback IP aliases so the simulator can bind to 127.0.0.x addresses.
# Run this once before starting the simulator (needs sudo).
#
# Usage:  sudo bash simulator/setup.sh
#         sudo bash simulator/setup.sh remove   ← remove aliases

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVICES_JSON="${SCRIPT_DIR}/devices.json"

# ── Parse IPs from devices.json using node (no python/jq dependency) ──────────
DEVICE_IPS=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('${DEVICES_JSON}','utf8'));
  const ips = new Set();
  for (const dev of (d.devices || [])) {
    if (dev.tvIP)     ips.add(dev.tvIP);
    if (dev.playerIP) ips.add(dev.playerIP);
  }
  console.log([...ips].join('\n'));
")

if [ -z "$DEVICE_IPS" ]; then
  echo "No device IPs found in devices.json — nothing to do."
  exit 0
fi

ACTION="${1:-add}"
OS="$(uname -s)"

echo "=== NEC Simulator IP alias setup ($OS) — action: $ACTION ==="
echo "IPs from devices.json:"
echo "$DEVICE_IPS" | sed 's/^/  /'
echo ""

for IP in $DEVICE_IPS; do
  # Skip 127.0.0.1 — already exists
  [ "$IP" = "127.0.0.1" ] && continue

  if [ "$OS" = "Darwin" ]; then
    # macOS: ifconfig lo0 alias / -alias
    if [ "$ACTION" = "remove" ]; then
      echo "  Removing lo0 alias $IP"
      sudo ifconfig lo0 -alias "$IP" 2>/dev/null || true
    else
      echo "  Adding lo0 alias $IP"
      sudo ifconfig lo0 alias "$IP" up
    fi

  elif [ "$OS" = "Linux" ]; then
    # Linux: ip addr add/del on lo
    if [ "$ACTION" = "remove" ]; then
      echo "  Removing lo alias $IP/8"
      sudo ip addr del "${IP}/8" dev lo 2>/dev/null || true
    else
      echo "  Adding lo alias $IP/8"
      sudo ip addr add "${IP}/8" dev lo 2>/dev/null || echo "    (already exists, skipping)"
    fi

  else
    echo "Unknown OS '$OS'. Add aliases manually:"
    echo "  ifconfig lo0 alias $IP up   (macOS)"
    echo "  ip addr add $IP/8 dev lo     (Linux)"
  fi
done

echo ""
if [ "$ACTION" = "remove" ]; then
  echo "Aliases removed."
else
  echo "Aliases added. You can now start the simulator:"
  echo "  sudo node simulator/server.js   (port 80 requires root)"
  echo "  — or set tvHttpPort/playerHttpPort to 7580/7581 in devices.json for non-root"
fi
