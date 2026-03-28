#!/usr/bin/env bash
# DynWorker install script
set -e

echo "==> Building Rust engine..."
cd engine
source "$HOME/.cargo/env"
cargo build --release
cd ..

echo "==> Installing API server dependencies..."
cd api
pnpm install
cd ..

echo "==> Installing SDK dependencies..."
cd sdk
pnpm install
cd ..

echo ""
echo "✓ DynWorker installed successfully."
echo ""
echo "  Start the server:"
echo "    cd api && node src/index.js"
echo ""
echo "  Run the example:"
echo "    cd examples/hello-worker && node run.js"
