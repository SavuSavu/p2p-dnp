# DefinitelyNotPong — V2

Independent gameplay-first static Canvas implementation.

## Run

```bash
cd /home/hp/work/p2p-dnp/v2
npm test
python3 -m http.server 8082
```

Open <http://localhost:8082/>.

## Controls

- Side paddle: `W/S`, arrow keys, or touch buttons/canvas halves.
- Top/bottom paddle: `A/D`, arrow keys, or touch buttons.
- Space pauses; the on-screen pause control works on touch.

## Browser-only multiplayer

Create or join a six-character room, then exchange the generated WebRTC offer/answer text through any chat. After signaling, game data travels directly between browsers. GitHub Pages cannot provide global room-code discovery or random matchmaking by itself, so Random 1v1 clearly falls back to the manual peer lobby. STUN is configured; TURN is intentionally not bundled.
