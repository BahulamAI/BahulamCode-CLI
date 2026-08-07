#!/usr/bin/env bash
# Publish the CLI under BOTH npm names:
#   @bahulam/code    (canonical, matches the new command name)
#   @bahulamai/code  (legacy — kept installable for existing users)
#
# Same source tree, same version, published twice. The script edits
# package.json's `name` field, publishes, then restores. Non-destructive
# on failure (restores in a trap).
#
# Usage:
#   bash scripts/publish-dual.sh                # publishes current version
#   OTP=123456 bash scripts/publish-dual.sh     # with 2FA one-time code

set -euo pipefail

cd "$(dirname "$0")/.."

PKG=package.json
CANONICAL_NAME='@bahulam/code'
LEGACY_NAME='@bahulamai/code'

restore() {
  # Always leave package.json on the canonical name.
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
    p.name = '$CANONICAL_NAME';
    fs.writeFileSync('$PKG', JSON.stringify(p, null, 2) + '\n');
  "
}
trap restore EXIT

current_name=$(node -p "require('./$PKG').name")
version=$(node -p "require('./$PKG').version")

if [[ "$current_name" != "$CANONICAL_NAME" ]]; then
  echo "package.json name is '$current_name' — expected '$CANONICAL_NAME'. Fix before publishing." >&2
  exit 1
fi

publish_as() {
  local name="$1"
  echo "── publishing $name@$version ──"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
    p.name = '$name';
    fs.writeFileSync('$PKG', JSON.stringify(p, null, 2) + '\n');
  "
  if [[ -n "${OTP:-}" ]]; then
    npm publish --access public --otp="$OTP"
  else
    npm publish --access public
  fi
}

publish_as "$CANONICAL_NAME"
publish_as "$LEGACY_NAME"

echo ""
echo "── published ──"
echo "  npm i -g $CANONICAL_NAME@$version   # primary"
echo "  npm i -g $LEGACY_NAME@$version      # legacy alias"
