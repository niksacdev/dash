#!/bin/zsh
set -eu
cd -- "${0:A:h}"
npm run package:mac
exec open "../dist/macos/DASH.app"
