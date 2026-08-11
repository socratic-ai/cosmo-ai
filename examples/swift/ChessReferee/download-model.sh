#!/usr/bin/env bash
# Fetch the chess detector weights (YOLOv9-t, ~9MB) into App/Models/.
# The model is distributed as a GitHub Release asset rather than committed,
# so clones stay light; the sha256 pin below guarantees you got the exact
# checkpoint the example was validated against.
set -euo pipefail

RELEASE_URL="https://github.com/socratic-ai/cosmo-examples/releases/download/chess-referee-model-v1/yolo9t_chess.onnx"
SHA256="20d031ff51e5c87df9f48b0c4875d67f46f776eb5188993a95016ffa74bce25f"
DEST="$(cd "$(dirname "$0")" && pwd)/App/Models/yolo9t_chess.onnx"

if [ -f "$DEST" ] && echo "$SHA256  $DEST" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "model already present and verified: $DEST"
    exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "downloading yolo9t_chess.onnx (~9MB)..."
curl -fL --progress-bar -o "$DEST.tmp" "$RELEASE_URL"
echo "$SHA256  $DEST.tmp" | shasum -a 256 -c -
mv "$DEST.tmp" "$DEST"
echo "done: $DEST"
