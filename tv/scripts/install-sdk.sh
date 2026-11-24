#!/usr/bin/env bash
# One-time setup on the computer that builds the TV app: the Android SDK pieces it needs, in ~/Android/Sdk.
# Run it in a terminal. Installing the packages means accepting Google's Android SDK terms.
#
#   bash tv/scripts/install-sdk.sh
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
ZIP=commandlinetools-linux-16111833_latest.zip
SHA1=e025545c62a8e64c7559119566a569fb1dec5f60
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading the Android command-line tools…"
  curl -fL --progress-bar -o "$tmp/$ZIP" "https://dl.google.com/android/repository/$ZIP"
  echo "$SHA1  $tmp/$ZIP" | sha1sum -c -
  mkdir -p "$SDK/cmdline-tools"
  unzip -q "$tmp/$ZIP" -d "$tmp/x"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/x/cmdline-tools" "$SDK/cmdline-tools/latest"
fi

SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
echo
echo "Google’s Android SDK terms come next (https://developer.android.com/studio/terms)."
"$SDKMANAGER" --sdk_root="$SDK" "platform-tools" "platforms;android-36" "build-tools;36.0.0"

# Tells the build where the SDK is (this file stays out of git).
echo "sdk.dir=$SDK" > "$HERE/local.properties"
echo
echo "Done. The SDK is in $SDK."
