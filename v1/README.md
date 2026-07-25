# DefinitelyNotPong — v1 protocol-first

Static browser game with local single-player and a verified manual-signaling WebRTC 1v1 mode. GitHub Pages cannot provide peer discovery or signaling, so players exchange the generated offer and answer through another communication channel.

## Run

```sh
cd /home/hp/work/p2p-dnp
python3 -m http.server 8080
# open http://localhost:8080/v1/
```

Opening `index.html` via `file://` is not supported; browsers require a secure context or localhost for WebRTC.

## Test

```sh
npm ci
npm test
npx playwright install firefox
npm run test:integration
```

The integration suite launches two isolated Firefox contexts, completes the UI-driven offer/answer exchange, verifies roster, score, ball and guest-input replication, and checks host cleanup after disconnect.

## Private 1v1 handshake

1. Host creates a room and shares the invite link.
2. Host clicks **Create peer offer** and sends the generated signal.
3. Guest pastes the offer, clicks **Apply remote signal**, and sends the generated answer back.
4. Host pastes the answer and clicks **Apply remote signal**.
5. Both players should show `P2P LIVE`; the host simulates the game and the guest sends paddle input.

## Protocol guarantees in this milestone

- Versioned `hello`, `room`, `input`, and authoritative `state` packets.
- 16 KiB inbound packet cap and bounded/sanitized fields.
- One validated peer identity per data channel.
- Duplicate and forged peer identities rejected.
- Monotonic guest-input and host-state sequence numbers.
- Per-channel input and snapshot rate limits.
- Guest accepts room/state only from its identity-bound host channel.
- Host removes a disconnected guest and rebroadcasts the roster.

This milestone intentionally supports **one host plus one guest**. Multi-peer host-star rooms for 3–12 players remain the next networking phase.

STUN is used for NAT discovery. There is no bundled TURN relay, so restrictive networks may fail to connect.
