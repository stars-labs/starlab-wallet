#!/usr/bin/env bash
# sandbox.sh — local fork chains for Starlab Wallet's sandbox-execution mode.
#
# Starts anvil (EVM, :8545) + surfpool (Solana surfnet, :8899) so the wallet can
# do a real create → sign → broadcast against SIMULATED chains — real signing,
# real blocks, no real funds. Point the wallet's network RPC at these and send
# transactions normally; reset by restarting this script.
#
# The browser extension can't spawn processes, so this script owns the nodes.
#
# Usage:
#   scripts/sandbox.sh [--fund-eth 0xADDR] [--fund-sol BASE58ADDR]
# Ctrl-C to stop (both nodes are torn down).
set -euo pipefail

EVM_PORT=8545
SOL_PORT=8899
FUND_ETH=""
FUND_SOL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fund-eth) FUND_ETH="$2"; shift 2 ;;
    --fund-sol) FUND_SOL="$2"; shift 2 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^#\s\?//'; exit 0 ;;
    *) echo "sandbox.sh: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

for bin in anvil surfpool cast; do
  command -v "$bin" >/dev/null || { echo "sandbox.sh: '$bin' not found (need Foundry + surfpool)" >&2; exit 1; }
done

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

wait_port() { for _ in $(seq 1 60); do (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }; sleep 1; done; return 1; }

echo "▸ anvil (EVM) → http://127.0.0.1:$EVM_PORT  (chainId 31337)"
anvil --host 127.0.0.1 --port "$EVM_PORT" >/tmp/sandbox-anvil.log 2>&1 &
PIDS+=("$!")
echo "▸ surfpool (Solana surfnet) → http://127.0.0.1:$SOL_PORT"
surfpool start --port "$SOL_PORT" >/tmp/sandbox-surfpool.log 2>&1 &
PIDS+=("$!")

wait_port "$EVM_PORT" && echo "  anvil up"      || echo "  ⚠ anvil didn't open $EVM_PORT (see /tmp/sandbox-anvil.log)"
wait_port "$SOL_PORT" && echo "  surfpool up"   || echo "  ⚠ surfpool didn't open $SOL_PORT (see /tmp/sandbox-surfpool.log)"

if [ -n "$FUND_ETH" ]; then
  # 10,000 ETH
  cast rpc anvil_setBalance "$FUND_ETH" 0x21e19e0c9bab2400000 --rpc-url "http://127.0.0.1:$EVM_PORT" >/dev/null \
    && echo "  funded $FUND_ETH with 10000 ETH"
fi
if [ -n "$FUND_SOL" ]; then
  # 100 SOL (lamports)
  curl -s -X POST -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$FUND_SOL\",100000000000]}" \
    "http://127.0.0.1:$SOL_PORT" >/dev/null && echo "  airdropped 100 SOL to $FUND_SOL"
fi

echo
echo "✅ sandbox up — point the wallet's networks at:"
echo "     EVM     http://127.0.0.1:$EVM_PORT   (chainId 31337)"
echo "     Solana  http://127.0.0.1:$SOL_PORT"
echo "   Ctrl-C to stop."
wait
