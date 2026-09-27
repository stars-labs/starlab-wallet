// Network-fault injection for the weak-network specs. Only works when the
// whole run is inside a user network namespace (we're root there; no sudo):
//
//   unshare --user --map-root-user --net bash -c '
//     ip link set lo up
//     ip link add d0 type dummy && ip addr add 10.99.0.1/24 dev d0 && ip link set d0 up
//     ip route add default dev d0
//     INTEROP_NETNS=1 INTEROP_SIGNAL=local xvfb-run -a bun run test:interop'
//
// The dummy interface + default route matter: webrtc-rs (CLI) ignores
// loopback and its mDNS multicast join fails with ENODEV without a route.
//
// Dropping UDP kills every WebRTC path while the signal server's TCP
// WebSocket stays up — exactly "the P2P link died, signaling didn't".
import { execSync } from "node:child_process";

export const inNetns = process.env.INTEROP_NETNS === "1";

export function blockUdp(): void {
  execSync(
    `nft add table inet interop && nft add chain inet interop out '{ type filter hook output priority 0; }' && nft add rule inet interop out meta l4proto udp drop`,
  );
}

// Idempotent so a `finally` can call it after the test already unblocked.
export function unblockUdp(): void {
  execSync("nft list table inet interop >/dev/null 2>&1 && nft delete table inet interop || true");
}
