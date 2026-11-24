# nexttupp for Android TV / Google TV

The TV app. It finds nexttupp on the home network, pairs once with a code from the computer, then shows
nexttupp full screen. The computer still does the searching, torrenting and converting; the TV's WebView
plays the video, and the remote's arrow keys move focus (Android WebView navigates by D-pad on screens
without touch). One APK covers Google TV, Android TV and Fire TV. Plan: `.scratch/tv-app/PLAN.md`.

## How it works

- **Finding the computer:** the app asks `GET http://<address>:4545/tv/hello` on every address of the TV's own
  /24, about two seconds, plus the last-used address first. No mDNS: some home Wi-Fi drops multicast.
- **Pairing:** on the computer, Account → **Add a TV** shows a 4-digit code (10 minutes, once, five wrong tries
  use it up). The app sends it to `POST /tv/pair` and gets the same kind of credential a phone gets (the
  `nexttupp_lan` cookie), listed and removable under "Connected phones and TVs". Needs "Let phones play from
  this computer" on, which needs the computer signed in. Server side: `server/lan/`.
- **Watching:** a WebView on `http://<computer>:4545/` with that cookie. The page calls
  `window.NexttuppTV.keepAwake()` while a film plays (`web/src/tv.ts`), so the screensaver stays away.
- **Back** goes back in the page, then leaves the app. If the computer forgets the TV (removed under Account),
  the app asks for a new code; if it can't reach the computer, it says so and looks again.

## Build

Once, on the build computer: `bash tv/scripts/install-sdk.sh` (Android command-line tools, platform 36,
build-tools; you accept Google's SDK license). Java 17 or newer is needed; Gradle comes with `./gradlew`.

```bash
cd tv
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

## Install on a TV (testing)

1. On the TV: Settings → System → About → press OK on **Android TV OS build** 7 times ("You are now a
   developer"). Then Settings → System → Developer options → turn on **USB debugging** (and **Network
   debugging** or **Wireless debugging** if the TV has it).
2. On the computer: `adb connect <tv address>` and accept the prompt on the TV, then
   `adb install -r tv/app/build/outputs/apk/debug/app-debug.apk`.
3. The app is in the TV's apps row. Debug builds can be inspected from Chrome at `chrome://inspect`.

For friends, the plan is the Downloader app and `nexttupp.com/tv`, with a release-signed APK (not built yet).
