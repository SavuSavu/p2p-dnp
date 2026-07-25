# DefinitelyNotPong

Three independent vanilla HTML/CSS/JavaScript + Canvas experiments for a browser-first peer-to-peer Pong-like game:

- [`/v1/`](./v1/) — protocol-first room model and explicit manual WebRTC signaling
- [`/v2/`](./v2/) — gameplay-first neon arena, AI and multiplayer affordances
- [`/v3/`](./v3/) — resilience-first snapshots, message validation and host election

The repository is a static GitHub Pages artifact. No build step or custom application server is required.

## Run locally

From the repository root:

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/`.

## Tests

Each version has an independent Node test suite:

```sh
(cd v1 && npm test)
(cd v2 && npm test)
(cd v3 && npm test)
```

## Browser-only and P2P limitations

- Single-player runs locally in the browser.
- A room code is an invite/session hint, **not** a record in a server-side room database.
- GitHub Pages cannot discover strangers, maintain a global matchmaking queue or relay WebRTC offers and answers on its own.
- Private rooms can exchange WebRTC offer/answer text manually through another communication channel. Implementations differ in how fully they demonstrate this flow.
- Global random matchmaking requires optional public rendezvous/signaling infrastructure. The included static artifact does not operate such a service; demo/fallback opponents are labeled accordingly.
- Public STUN may assist NAT discovery, but no TURN relay is bundled. Direct connections can fail on restrictive networks.
- Peers should be treated as untrusted. The variants validate or bound key inputs, but these are experimental browser demos rather than a production anti-cheat or identity system.
- Browser support and clipboard, WebRTC, storage and `BroadcastChannel` availability vary. V3's same-origin `BroadcastChannel` room demonstration connects tabs on the same origin and is not internet-wide signaling.

## Static invite paths

GitHub Pages serves `404.html` as a fallback. Paths shaped like:

```text
/p2p-dnp/v1/join/ABC234
/p2p-dnp/v2/join/ABC234
/p2p-dnp/v3/join/ABC234
```

are redirected in the browser to the corresponding `?join=ABC234` route. Invalid codes remain a normal 404.
