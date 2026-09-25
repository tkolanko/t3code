#!/usr/bin/env bash
# Build a Release app signed with an Xcode Personal Team and install it on a
# connected iPhone, optionally merging upstream first. Free signing expires after
# 7 days, so rerun this before then. See apps/mobile/README.md.
#
#   scripts/ios-personal-device.sh              merge upstream/main, build, install
#   scripts/ios-personal-device.sh --no-update  build and install the current checkout
#
# Requires T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID in the environment or the repo .env.
# Optional: T3_UPSTREAM_REMOTE (default upstream), T3_IOS_TEAM_ID, T3_IOS_DEVICE_ID.
set -euo pipefail

UPDATE=1
[[ "${1:-}" == "--no-update" ]] && UPDATE=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# Show the full log through xcbeautify when installed, otherwise only errors and the result.
build_output() {
  if command -v xcbeautify >/dev/null; then xcbeautify
  else grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true; fi
}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
VP="$(command -v vp || echo "$REPO/node_modules/.bin/vp")"
UPSTREAM="${T3_UPSTREAM_REMOTE:-upstream}"

TEAM_ID="${T3_IOS_TEAM_ID:-$(security find-certificate -c "Apple Development" -p 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU=\([A-Z0-9]*\).*/\1/p')}"
[[ -n "$TEAM_ID" ]] || fail "No Apple Development certificate found. Sign in under Xcode → Settings → Accounts."

step "Finding a connected iPhone"
DEVICE_ID="${T3_IOS_DEVICE_ID:-}"
if [[ -z "$DEVICE_ID" ]]; then
  devices_json="$(mktemp)"
  xcrun devicectl list devices --json-output "$devices_json" >/dev/null
  DEVICE_ID="$(python3 - "$devices_json" <<'EOF'
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    hw = d.get("hardwareProperties", {})
    if hw.get("platform") == "iOS" and hw.get("reality") == "physical" and hw.get("udid"):
        print(hw["udid"])
        break
EOF
)"
  rm -f "$devices_json"
fi
[[ -n "$DEVICE_ID" ]] || fail "No iPhone found. Connect and unlock it, then run again."
echo "Device $DEVICE_ID, team $TEAM_ID"

if [[ "$UPDATE" == 1 ]]; then
  git remote get-url "$UPSTREAM" >/dev/null 2>&1 \
    || fail "No '$UPSTREAM' remote. Add it or set T3_UPSTREAM_REMOTE, or pass --no-update."
  [[ -z "$(git status --porcelain)" ]] || fail "Uncommitted changes. Commit or stash them first."
  step "Merging $UPSTREAM/main into $(git branch --show-current)"
  git fetch "$UPSTREAM"
  git merge --no-edit "$UPSTREAM/main" || fail "Merge conflicts. Resolve them, commit, and run this again."
fi

step "Installing dependencies"
"$VP" i

cd apps/mobile
export APP_VARIANT=production T3CODE_IOS_PERSONAL_TEAM=1 EXPO_NO_GIT_STATUS=1

step "Generating the iOS project"
npx expo prebuild --clean --platform ios

step "Building Release (this takes a while)"
if ! xcodebuild \
  -workspace ios/T3Code.xcworkspace \
  -scheme T3Code \
  -configuration Release \
  -destination "id=$DEVICE_ID" \
  -derivedDataPath ios/build \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build \
  | build_output; then
  fail "Build failed. Full logs are under apps/mobile/ios/build/Logs."
fi

APP="$(ls -d ios/build/Build/Products/Release-iphoneos/*.app | head -1)"
step "Installing $(basename "$APP") on the iPhone"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"

step "Done. Personal Team signing expires in 7 days."
