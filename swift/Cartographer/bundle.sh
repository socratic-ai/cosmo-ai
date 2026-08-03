#!/bin/bash
# Assemble the SwiftPM executable into a real .app bundle.
#
# A bare `swift build` binary has no Info.plist, so macOS TCC has nowhere to
# read NSMicrophoneUsageDescription from and the mic prompt never appears.
# The SDK captures audio through AVAudioEngine, so no bundle == no voice.
set -euo pipefail

CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/build/Cartographer.app"

swift build -c "$CONFIG"
BIN="$(swift build -c "$CONFIG" --show-bin-path)/Cartographer"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$BIN" "$APP/Contents/MacOS/Cartographer"

# The SDK depends on LiveKit's binary xcframeworks. SwiftPM links them but
# does NOT embed them, so a hand-rolled bundle dies at launch with
#   dyld: Library not loaded: @rpath/LiveKitWebRTC.framework/LiveKitWebRTC
# Copy the macOS slice of each in and add an @executable_path rpath.
for XC in $(find "$ROOT/.build/artifacts" -name '*.xcframework' -maxdepth 3); do
  SLICE="$(find "$XC" -maxdepth 1 -type d -name 'macos-*' | head -1)"
  [ -n "$SLICE" ] || { echo "no macOS slice in $XC" >&2; exit 1; }
  FW="$(find "$SLICE" -maxdepth 1 -type d -name '*.framework' | head -1)"
  cp -R "$FW" "$APP/Contents/Frameworks/"
  echo "  embedded $(basename "$FW")"
done

install_name_tool -add_rpath "@executable_path/../Frameworks" \
  "$APP/Contents/MacOS/Cartographer" 2>/dev/null || true

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>Cartographer</string>
  <key>CFBundleDisplayName</key>       <string>Cartographer</string>
  <key>CFBundleIdentifier</key>        <string>ai.askcosmo.dx.cartographer</string>
  <key>CFBundleExecutable</key>        <string>Cartographer</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key>           <string>1</string>
  <key>LSMinimumSystemVersion</key>    <string>14.0</string>
  <key>NSHighResolutionCapable</key>   <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Cartographer listens while you think out loud and draws your ideas as a map.</string>
</dict>
</plist>
PLIST

cat > "$ROOT/build/cartographer.entitlements" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.device.audio-input</key> <true/>
  <key>com.apple.security.network.client</key>     <true/>
  <!-- The SDK's LiveKit xcframeworks are signed by a different team, so a
       hardened-runtime build must opt out of library validation. -->
  <key>com.apple.security.cs.disable-library-validation</key> <true/>
</dict>
</plist>
ENT

# Ad-hoc sign. TCC keys the mic grant to the signing identity, so an
# unsigned binary re-prompts (or is silently denied) on every rebuild.
# Embedded frameworks must be signed before the bundle that contains them.
for FW in "$APP/Contents/Frameworks/"*.framework; do
  codesign --force --sign - "$FW" 2>&1 | sed 's/^/  codesign: /'
done
codesign --force --sign - \
  --entitlements "$ROOT/build/cartographer.entitlements" \
  "$APP" 2>&1 | sed 's/^/  codesign: /'

echo "built $APP"
