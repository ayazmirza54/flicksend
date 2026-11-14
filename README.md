# FlickSend

Flick a photo or video up off your phone and it flies onto your laptop screen.

```
 Android phone (Expo / React Native)                Windows laptop (React Native Windows)
┌────────────────────────────────┐   Wi-Fi (LAN)   ┌─────────────────────────────────────┐
│ pick media → card deck         │                 │ FlickServer native module (C++)     │
│ flick up (pan velocity)  ──────┼─ POST /flick ──▶│   tiny HTTP server on :47821        │
│   metadata + 480px thumbnail   │                 │   → JS: fly-in animation starts     │
│ stream full file  ─────────────┼─ PUT /content ─▶│   → saved to Pictures\FlickSend     │
│ progress + haptics             │                 │ full-screen, always-on-top "stage"  │
└────────────────────────────────┘                 └─────────────────────────────────────┘
          pairing: phone scans a QR code on the laptop (IPs + port + secret token)
```

Sending the thumbnail first is what makes it feel instant: the laptop starts the
fly-in animation from the preview while the full file (even a big video) is still
streaming in, then swaps in the full-resolution image.

## Layout

| Path | What |
|---|---|
| `shared/protocol.ts` | Wire protocol shared by both apps (types, routes, pairing QR format) |
| `apps/desktop` | React Native **Windows** app (new architecture, C++ / WinAppSDK) |
| `apps/desktop/windows/FlickSendDesktop/server/` | Portable C++ HTTP receiver (Winsock / BSD sockets) |
| `apps/desktop/windows/FlickSendDesktop/FlickServerModule.*` | Turbo module: server events → JS, overlay window, open/reveal file |
| `apps/desktop/src/` | Desktop UI: pairing QR, full-screen stage, recent flicks |
| `apps/desktop/native-tests/` | Self-test + end-to-end HTTP tests for the C++ server |
| `apps/mobile` | Expo (SDK 58) Android app: QR pairing, card deck, flick gesture, upload |

## Run it

### 1. Laptop (Windows 10/11)

Prerequisites: the [React Native Windows dev dependencies](https://microsoft.github.io/react-native-windows/docs/rnw-dependencies)
(Visual Studio 2022 with *Desktop development with C++* and *WinUI application development*, Windows SDK, Node 22+).

```bash
cd apps/desktop
npm install
npm run windows
```

On first launch Windows Firewall asks whether FlickSend may accept connections:
**allow it on Private networks**. Your Wi-Fi must be set as a *Private* network
(Settings → Network & internet → Wi-Fi → your network), otherwise the phone can't
reach the laptop.

The window shows a QR code. Received files are saved to `Pictures\FlickSend`.
The pairing token is stored in `%LOCALAPPDATA%\FlickSend\token.txt`; delete it to
revoke every paired phone.

### 2. Phone (Android)

```bash
cd apps/mobile
npm install
npx expo start
```

Open the QR code it prints with **Expo Go** (phone on the same Wi-Fi). If your Expo
Go doesn't support SDK 58 yet, build a dev client instead: `npx expo run:android`
(USB debugging) or `npx eas-cli build --profile development -p android`.

Then: scan the laptop's QR code → *Choose photos & videos* → **flick the card up**.
Flicking up-left or up-right tilts the incoming card that way on the laptop.

## Tests

```bash
npm test          # from the repo root
```

- `test:protocol`: pairing-code parsing, ID generation (must satisfy the C++ server's ID rules).
- `test:native`: compiles the C++ server core with your host compiler, runs its self-test,
  then 14 end-to-end tests over real sockets (auth, metadata, 5 MB streamed upload, chunked
  upload, `Expect: 100-continue`, path traversal, oversized/truncated uploads, loopback-only
  media). Set `SANITIZE=1` to build with ASan/UBSan.

Typecheck/lint: `npm run typecheck` / `npm run lint` in each app.

## Security model

- Everything stays on your LAN; no cloud.
- Every phone request needs the secret token from the QR code (constant-time compare).
- Uploaded file names are sanitized; files can only land in `Pictures\FlickSend`.
- `/media/:id` (used by the desktop UI to display files) only answers `127.0.0.1`.
- Traffic is plain HTTP on the LAN; anyone on the same network who has the token could
  send you files. TLS with a pinned certificate in the QR code is a natural next step.

## Known gaps / next steps

- Videos show their thumbnail on the stage with a Play button that opens your default
  player (RN Windows has no built-in video component yet).
- The stage is an opaque full-screen window, not a transparent overlay.
- No mDNS discovery yet; pairing is by QR code (the phone tries every laptop IP in it).
- Multi-monitor targeting by flick direction (the direction is already sent).
