# DefinitelyNotPong — v1 protocol-first

Zero-dependency static browser game. Single-player works offline. Private multiplayer uses manual copy/paste WebRTC offer/answer signaling because GitHub Pages cannot provide peer discovery or signaling.

## Run

```sh
cd /home/hp/work/p2p-dnp/v1
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` via `file://` is not supported; browsers require a secure context or localhost for WebRTC.

## Test

```sh
npm test
```

Tests use Node's built-in runner; there are no dependencies to install.

## Private room handshake

1. Host creates a room and copies the invite link to a guest.
2. Host clicks **Create peer offer**, waits for ICE gathering, and sends the generated signal.
3. Guest pastes the offer, clicks **Apply remote signal**, and sends the generated answer back.
4. Host pastes the answer and clicks **Apply remote signal**.
5. Repeat the host offer flow separately for each additional guest, up to 12 total players.

STUN is used for NAT discovery. There is no bundled TURN relay, so restrictive networks may fail to connect.
