#!/usr/bin/env bash
# DynWorker Bootstrap Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/elevate-foundry/dynworker/master/bootstrap.sh | bash
set -e

REPO="https://github.com/elevate-foundry/dynworker.git"
INSTALL_DIR="${DYNWORKER_DIR:-$HOME/.dynworker-runtime}"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}==>${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }
die()     { echo -e "${RED}✗ Error:${NC} $*" >&2; exit 1; }

echo ""
echo -e "${CYAN}  ██████╗ ██╗   ██╗███╗   ██╗██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗███████╗██████╗ ${NC}"
echo -e "${CYAN}  ██╔══██╗╚██╗ ██╔╝████╗  ██║██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝██╔════╝██╔══██╗${NC}"
echo -e "${CYAN}  ██║  ██║ ╚████╔╝ ██╔██╗ ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝ █████╗  ██████╔╝${NC}"
echo -e "${CYAN}  ██║  ██║  ╚██╔╝  ██║╚██╗██║██║███╗██║██║   ██║██╔══██╗██╔═██╗ ██╔══╝  ██╔══██╗${NC}"
echo -e "${CYAN}  ██████╔╝   ██║   ██║ ╚████║╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗███████╗██║  ██║${NC}"
echo -e "${CYAN}  ╚═════╝    ╚═╝   ╚═╝  ╚═══╝ ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝${NC}"
echo ""
echo -e "  Self-hosted dynamic WebAssembly worker runtime"
echo -e "  ${CYAN}https://github.com/elevate-foundry/dynworker${NC}"
echo ""

# ── Dependency checks ─────────────────────────────────────────────────────────
info "Checking dependencies..."

check_cmd() {
  command -v "$1" &>/dev/null || die "'$1' is required but not installed. $2"
}

check_cmd git   "Install with: sudo apt install git"
check_cmd curl  "Install with: sudo apt install curl"
check_cmd node  "Install Node.js 22+: https://nodejs.org"
check_cmd pnpm  "Install with: npm install -g pnpm"

# Check Node version >= 18
NODE_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required (found $(node --version))"

# Check / install Rust
if ! command -v cargo &>/dev/null; then
  warn "Rust not found — installing via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  source "$HOME/.cargo/env"
fi
source "$HOME/.cargo/env" 2>/dev/null || true

# Check gcc (needed by Rust linker)
if ! command -v gcc &>/dev/null; then
  warn "gcc not found — attempting: sudo apt install -y gcc"
  sudo apt-get install -y gcc 2>/dev/null || die "Please install gcc: sudo apt install gcc"
fi

success "All dependencies satisfied"

# ── Clone ─────────────────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
  info "Updating existing installation at $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning DynWorker into $INSTALL_DIR ..."
  git clone "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── Build Rust engine ─────────────────────────────────────────────────────────
info "Building Rust engine (this takes ~2 min on first run)..."
cd engine
cargo build --release 2>&1 | grep -E "^error|Compiling dynworker|Finished" || true
[ -f "target/release/dynworker-engine" ] || die "Engine build failed"
success "Engine built: engine/target/release/dynworker-engine"
cd ..

# ── Install Node deps ─────────────────────────────────────────────────────────
info "Installing API server dependencies..."
(cd api && pnpm install --silent)

info "Installing SDK dependencies..."
(cd sdk && pnpm install --silent)

success "Dependencies installed"

# ── Create launcher script ────────────────────────────────────────────────────
LAUNCHER="$HOME/.local/bin/dynworker"
mkdir -p "$HOME/.local/bin"
cat > "$LAUNCHER" << EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR/api"
exec node src/index.js "\$@"
EOF
chmod +x "$LAUNCHER"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  DynWorker installed successfully!                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Start the server:"
echo -e "    ${CYAN}dynworker${NC}                          # if ~/.local/bin is in PATH"
echo -e "    ${CYAN}node $INSTALL_DIR/api/src/index.js${NC}"
echo ""
echo -e "  Execute a worker (once server is running):"
echo -e "    ${CYAN}WASM=\$(base64 -w0 path/to/module.wasm)${NC}"
echo -e "    ${CYAN}curl -X POST http://localhost:7777/v1/execute \\${NC}"
echo -e "    ${CYAN}  -H 'Content-Type: application/json' \\${NC}"
echo -e "    ${CYAN}  -d '{\"main_module\":\"m.wasm\",\"modules\":{\"m.wasm\":\"\$WASM\"}}'${NC}"
echo ""
echo -e "  Docs: ${CYAN}https://github.com/elevate-foundry/dynworker${NC}"
echo ""

# Remind user to add ~/.local/bin to PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  warn "Add ~/.local/bin to your PATH to use the 'dynworker' command:"
  echo -e "    ${CYAN}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc${NC}"
fi
