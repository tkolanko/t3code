#!/usr/bin/env bash
# Build a Release app signed with an Xcode Personal Team and install it on a
# connected iPhone, optionally merging upstream first. Requests a fresh signing
# profile each time; free signing expires 7 days from issuance. See apps/mobile/README.md.
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
  # devicectl also lists paired phones that are out of reach; those have no transport.
  # Prefer a cable over Wi-Fi when both are available.
  selected="$(python3 - "$devices_json" <<'EOF'
import json, sys
rank = {"wired": 0, "localNetwork": 1}
phones = [
    (rank[d["connectionProperties"]["transportType"]], d["hardwareProperties"]["udid"],
     d["connectionProperties"]["transportType"])
    for d in json.load(open(sys.argv[1]))["result"]["devices"]
    if d.get("hardwareProperties", {}).get("platform") == "iOS"
    and d["hardwareProperties"].get("reality") == "physical"
    and d.get("connectionProperties", {}).get("transportType") in rank
]
if phones:
    print(*min(phones)[1:])
EOF
)"
  read -r DEVICE_ID DEVICE_TRANSPORT <<<"$selected" || true
  rm -f "$devices_json"
fi
[[ -n "$DEVICE_ID" ]] || fail "No reachable iPhone. Connect it by cable (or join the same Wi-Fi), unlock it, and run again."
echo "Device $DEVICE_ID (${DEVICE_TRANSPORT:-set by T3_IOS_DEVICE_ID}), team $TEAM_ID"

# The device list can report a stale Wi-Fi connection, and a phone that sleeps during the
# build drops it. Listing apps needs a live connection, so it both checks and reopens one.
wait_for_phone() {
  xcrun devicectl device info apps --device "$DEVICE_ID" --timeout 60 --quiet >/dev/null 2>&1 \
    || fail "The iPhone did not respond. Connect it by cable (or wake it on the same Wi-Fi), unlock it, and run again."
}
wait_for_phone

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

# Use the same environment resolution as app.config.ts, including the repo .env.
BUNDLE_ID="$(node --input-type=module -e '
  import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
  process.stdout.write(loadRepoEnv().T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID.trim());
')"

step "Requesting a fresh provisioning profile for $BUNDLE_ID"
# Automatic signing requests a new profile when no eligible cached profile exists.
# Match the team and exact app ID so other apps' signing profiles stay intact.
python3 - "$TEAM_ID" "$BUNDLE_ID" <<'EOF'
import pathlib, plistlib, subprocess, sys

team, bundle = sys.argv[1:]
for directory in (
    pathlib.Path.home() / "Library/MobileDevice/Provisioning Profiles",
    pathlib.Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
):
    for path in directory.glob("*.mobileprovision"):
        result = subprocess.run(
            ["openssl", "cms", "-verify", "-inform", "DER", "-in", str(path), "-noverify"],
            capture_output=True,
        )
        if result.returncode:
            sys.exit(f"Could not decode cached provisioning profile: {path}")
        profile = plistlib.loads(result.stdout)
        app_id = profile.get("Entitlements", {}).get("application-identifier")
        prefixes = profile.get("ApplicationIdentifierPrefix", [])
        if team in profile.get("TeamIdentifier", []) and any(
            app_id == f"{prefix}.{bundle}" for prefix in prefixes
        ):
            path.unlink()
            print(f"Removed cached profile {path.name}")
EOF

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
step "Checking signing expiration"
python3 - "$APP/embedded.mobileprovision" <<'EOF'
import datetime, plistlib, subprocess, sys

result = subprocess.run(
    ["openssl", "cms", "-verify", "-inform", "DER", "-in", sys.argv[1], "-noverify"],
    capture_output=True, check=True,
)
profile = plistlib.loads(result.stdout)
expiration = profile["ExpirationDate"].replace(tzinfo=datetime.timezone.utc)
remaining = expiration - datetime.datetime.now(datetime.timezone.utc)
print(f"Signing expires: {expiration.astimezone():%Y-%m-%d %H:%M:%S %Z}")
if remaining.total_seconds() <= 0:
    sys.exit("Xcode used an expired provisioning profile. The app was not installed.")
print(f"Time remaining: {remaining.days} days, {remaining.seconds // 3600} hours")
if remaining < datetime.timedelta(days=6):
    print("Warning: Xcode did not provide a full new week of signing validity.", file=sys.stderr)
EOF

step "Installing $(basename "$APP") on the iPhone"
wait_for_phone
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"

step "Done. Reinstall before the signing expiration shown above."
