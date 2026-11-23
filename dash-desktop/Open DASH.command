#!/bin/zsh
set -eu
cd -- "${0:A:h}"
exec "./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" .
