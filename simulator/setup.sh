#!/usr/bin/env bash
# simulator/setup.sh
#
# Sets up IP aliases on the LAN interface so the simulator can bind to
# addresses reachable from the router. The script auto-detects which
# network interface carries the same subnet as the device IPs in devices.json.
#
# Usage:  sudo simulator/setup.sh $(which node)            ← add aliases
#         sudo simulator/setup.sh $(which node) remove      ← remove aliases

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVICES_JSON="${SCRIPT_DIR}/devices.json"

# ── Resolve node binary from first argument ───────────────────────────────────
NODE="$1"
ACTION="${2:-add}"

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "Usage: sudo $0 \$(which node) [add|remove]"
  echo ""
  echo "  The first argument must be the full path to the node binary."
  echo "  Resolve it BEFORE sudo so nvm paths are visible:"
  echo "    sudo $0 \$(which node)"
  exit 1
fi

# ── Parse IPs from devices.json using node (no python/jq dependency) ──────────
DEVICE_IPS=$("$NODE" -e "
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

OS="$(uname -s)"

# ── Auto-detect the correct network interface ────────────────────────────────
# Takes the first device IP, derives its /24 subnet prefix, and finds which
# interface already has an address on that subnet.
FIRST_IP=$(echo "$DEVICE_IPS" | head -1)
SUBNET_PREFIX=$(echo "$FIRST_IP" | cut -d. -f1-3)

if [ "$OS" = "Darwin" ]; then
  # macOS: scan ifconfig output for an existing IP on the same /24
  IFACE=$(ifconfig -a 2>/dev/null | awk -v prefix="$SUBNET_PREFIX" '
    /^[a-zA-Z]/ { iface=$1; sub(/:$/,"",iface) }
    /inet / { split($2,a,"."); pfx=a[1]"."a[2]"."a[3]; if (pfx==prefix) { print iface; exit } }
  ')
elif [ "$OS" = "Linux" ]; then
  IFACE=$(ip -o addr show 2>/dev/null | awk -v prefix="$SUBNET_PREFIX" '
    { split($4,a,"/"); split(a[1],b,"."); pfx=b[1]"."b[2]"."b[3];
      if (pfx==prefix) { print $2; exit } }
  ')
fi

if [ -z "$IFACE" ]; then
  echo "ERROR: Could not find a network interface on the ${SUBNET_PREFIX}.x subnet."
  echo "Make sure this machine has a LAN connection on that subnet before running setup."
  exit 1
fi

echo "=== NEC Simulator IP alias setup ($OS) ==="
echo "Action:    $ACTION"
echo "Interface: $IFACE  (detected from ${SUBNET_PREFIX}.x subnet)"
echo "Node:      $NODE"
echo "IPs from devices.json:"
echo "$DEVICE_IPS" | sed 's/^/  /'
echo ""

# ── Check for existing host address — don't alias our own IP ─────────────────
if [ "$OS" = "Darwin" ]; then
  HOST_IP=$(ifconfig "$IFACE" 2>/dev/null | awk '/inet / { print $2; exit }')
elif [ "$OS" = "Linux" ]; then
  HOST_IP=$(ip -4 addr show dev "$IFACE" 2>/dev/null | awk '/inet / { split($2,a,"/"); print a[1]; exit }')
fi

for IP in $DEVICE_IPS; do
  # Skip our own address
  if [ "$IP" = "$HOST_IP" ]; then
    echo "  Skipping $IP (host's own address on $IFACE)"
    continue
  fi

  if [ "$OS" = "Darwin" ]; then
    if [ "$ACTION" = "remove" ]; then
      echo "  Removing $IFACE alias $IP"
      ifconfig "$IFACE" -alias "$IP" 2>/dev/null || true
    else
      echo "  Adding $IFACE alias $IP"
      ifconfig "$IFACE" alias "$IP" netmask 255.255.255.0 up
    fi

  elif [ "$OS" = "Linux" ]; then
    if [ "$ACTION" = "remove" ]; then
      echo "  Removing $IFACE alias $IP/24"
      ip addr del "${IP}/24" dev "$IFACE" 2>/dev/null || true
    else
      echo "  Adding $IFACE alias $IP/24"
      ip addr add "${IP}/24" dev "$IFACE" 2>/dev/null || echo "    (already exists, skipping)"
    fi

  else
    echo "Unknown OS '$OS'. Add aliases manually:"
    echo "  ifconfig <iface> alias $IP netmask 255.255.255.0 up   (macOS)"
    echo "  ip addr add $IP/24 dev <iface>                         (Linux)"
  fi
done

echo ""
if [ "$ACTION" = "remove" ]; then
  echo "Aliases removed from $IFACE."
else
  echo "Aliases added to $IFACE. You can now start the simulator:"
  echo "  sudo $NODE simulator/server.js"
fi
