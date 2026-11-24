#!/bin/zsh
set -eu
cd -- "${0:A:h}"
npm run package:mac
exec open "$HOME/Applications/DASH.app"
