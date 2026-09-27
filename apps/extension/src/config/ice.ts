/**
 * ICE servers for every peer connection. The same public Google STUN servers
 * as the CLI/TUI (starlab-mpc `STUN_SERVERS`), so all clients gather the same
 * server-reflexive candidates. STUN only — there is no public TURN; peers
 * behind strict/symmetric NATs still need a relay of our own.
 */
export const STUN_SERVERS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
];

export const ICE_SERVERS: RTCIceServer[] = [{ urls: STUN_SERVERS }];
