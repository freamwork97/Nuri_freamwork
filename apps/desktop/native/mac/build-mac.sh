#!/bin/bash
# Builds anb-desktop-mac (the macOS computer-use helper) — run ON A MAC with Xcode command line
# tools (xcode-select --install). macOS 14+ (ScreenCaptureKit screenshots).
# After the first run, allow the app (or Terminal while testing) in System Settings >
# Privacy & Security > Accessibility and > Screen Recording.
# Quick test: echo '{"id":1,"cmd":"windows"}' | ./anb-desktop-mac
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos14.0" \
  -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit \
  -o anb-desktop-mac DesktopHelperMac.swift
echo "built $(pwd)/anb-desktop-mac"
