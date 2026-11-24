#!/usr/bin/env bash
# Builds the release-signed TV app at nexttupp's version (root package.json) and puts it where nexttupp.com/tv.apk
# is served from: site/public/tv.apk (not in git). Deploy the site afterwards (site/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."
./gradlew -q assembleRelease
apk=app/build/outputs/apk/release/app-release.apk
if [ ! -f "$apk" ]; then
  echo "No signed APK: the release key's properties file is missing (see app/build.gradle.kts)." >&2
  exit 1
fi
sdk=$(sed -n 's/^sdk.dir=//p' local.properties)
tools=$(ls -d "$sdk"/build-tools/* | sort -V | tail -1)
"$tools/apksigner" verify --print-certs "$apk" | grep -m1 'SHA-256'
cp "$apk" ../site/public/tv.apk
echo "site/public/tv.apk: $("$tools/aapt2" dump badging "$apk" | head -1)"
