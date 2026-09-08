#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
swiftc -module-cache-path "$work/cache" ios/FoldRoute/DomainModels.swift ios/FoldRoute/PolylineDecoder.swift ios/FoldRoute/TransitousClient.swift ios/FoldRoute/BikeTransferSearch.swift ios/FoldRoute/TransitRefresh.swift ios/FoldRouteTests/TransitousFixtures.swift web/scripts/Parity.swift -o "$work/parity"
"$work/parity" > "$work/parity.json"
if [ "${1:-}" = "--update" ]; then
  cp "$work/parity.json" web/tests/fixtures/swift-parity.json
else
  diff -u web/tests/fixtures/swift-parity.json "$work/parity.json"
fi
