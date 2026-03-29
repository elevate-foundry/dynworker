#!/usr/bin/env bash
# DynWorker Bootstrap Installer
# Detects OS/environment and installs ALL dependencies automatically.
#
# Supported platforms:
#   - Termux (Android)
#   - Ubuntu / Debian / Raspberry Pi OS
#   - Fedora / RHEL / CentOS / Rocky / AlmaLinux
#   - Arch Linux / Manjaro
#   - openSUSE
#   - macOS (via Homebrew, auto-installed if missing)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/elevate-foundry/dynworker/master/bootstrap.sh | bash
set -e

REPO="https://github.com/elevate-foundry/dynworker.git"
INSTALL_DIR="${DYNWORKER_DIR:-$HOME/.dynworker-runtime}"
PORT="${DYNWORKER_PORT:-7777}"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}==>${NC} ${BOLD}$*${NC}"; }
success() { echo -e "${GREEN}  ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}  !${NC} $*"; }
die()     { echo -e "\n${RED}  ✗ Fatal:${NC} $*\n" >&2; exit 1; }
step()    { echo -e "\n${BOLD}[$1/$TOTAL_STEPS]${NC} $2"; }

TOTAL_STEPS=6

# ── Banner ────────────────────────────────────────────────────────────────────
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

# ── Step 1: Detect platform ───────────────────────────────────────────────────
step 1 "Detecting platform..."

PLATFORM=""
PKG_INSTALL=""
PKG_UPDATE=""

# Termux (Android) — check first, no /etc/os-release
if [ -n "$TERMUX_VERSION" ] || [ -d "/data/data/com.termux" ] || command -v termux-info &>/dev/null; then
  PLATFORM="termux"
  PKG_UPDATE="pkg update -y"
  PKG_INSTALL="pkg install -y"

elif [ "$(uname -s)" = "Darwin" ]; then
  PLATFORM="macos"

elif [ -f /etc/os-release ]; then
  . /etc/os-release
  case "$ID" in
    ubuntu|debian|raspbian|linuxmint|pop|elementary|kali|zorin)
      PLATFORM="debian"
      PKG_UPDATE="sudo apt-get update -qq"
      PKG_INSTALL="sudo apt-get install -y -qq"
      ;;
    fedora)
      PLATFORM="fedora"
      PKG_INSTALL="sudo dnf install -y"
      ;;
    rhel|centos|rocky|almalinux|ol)
      PLATFORM="rhel"
      PKG_INSTALL="sudo dnf install -y"
      ;;
    arch|manjaro|endeavouros|garuda)
      PLATFORM="arch"
      PKG_UPDATE="sudo pacman -Sy --noconfirm"
      PKG_INSTALL="sudo pacman -S --noconfirm --needed"
      ;;
    opensuse*|sles)
      PLATFORM="opensuse"
      PKG_INSTALL="sudo zypper install -y"
      ;;
    *)
      warn "Unknown distro '$ID' — attempting Debian-style install"
      PLATFORM="debian"
      PKG_UPDATE="sudo apt-get update -qq"
      PKG_INSTALL="sudo apt-get install -y -qq"
      ;;
  esac
else
  die "Cannot detect OS. Supported: Termux, Ubuntu/Debian, Fedora, RHEL, Arch, openSUSE, macOS"
fi

success "Platform: ${BOLD}$PLATFORM${NC}"

# ── Step 2: Install system dependencies ──────────────────────────────────────
step 2 "Installing system dependencies..."

install_sys_deps() {
  case "$PLATFORM" in
    termux)
      $PKG_UPDATE
      # clang + lld are the correct linker toolchain for Rust on Termux
      $PKG_INSTALL git curl nodejs clang lld binutils
      # pnpm via npm on Termux
      npm install -g pnpm 2>/dev/null || true
      ;;

    debian)
      $PKG_UPDATE
      $PKG_INSTALL git curl build-essential pkg-config libssl-dev
      # Install Node.js 22 via NodeSource if node is missing or < 18
      if ! command -v node &>/dev/null || [ "$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')" -lt 18 ]; then
        info "Installing Node.js 22 via NodeSource..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi
      # pnpm
      if ! command -v pnpm &>/dev/null; then
        npm install -g pnpm
      fi
      ;;

    fedora)
      $PKG_INSTALL git curl gcc make openssl-devel
      if ! command -v node &>/dev/null || [ "$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')" -lt 18 ]; then
        info "Installing Node.js 22 via NodeSource..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo dnf install -y nodejs
      fi
      if ! command -v pnpm &>/dev/null; then npm install -g pnpm; fi
      ;;

    rhel)
      sudo dnf install -y epel-release 2>/dev/null || true
      $PKG_INSTALL git curl gcc make openssl-devel
      if ! command -v node &>/dev/null || [ "$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')" -lt 18 ]; then
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo dnf install -y nodejs
      fi
      if ! command -v pnpm &>/dev/null; then npm install -g pnpm; fi
      ;;

    arch)
      $PKG_UPDATE
      $PKG_INSTALL git curl base-devel nodejs npm
      if ! command -v pnpm &>/dev/null; then npm install -g pnpm; fi
      ;;

    opensuse)
      $PKG_INSTALL git curl gcc make libopenssl-devel nodejs npm
      if ! command -v pnpm &>/dev/null; then npm install -g pnpm; fi
      ;;

    macos)
      # Install Homebrew if missing
      if ! command -v brew &>/dev/null; then
        info "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Add brew to PATH for Apple Silicon
        eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
      fi
      brew update --quiet
      brew install git curl node 2>/dev/null || brew upgrade node 2>/dev/null || true
      if ! command -v pnpm &>/dev/null; then npm install -g pnpm; fi
      ;;
  esac
}

install_sys_deps
success "System dependencies installed"

# ── Step 3: Install Rust (skipped on Termux — uses NodeEngine instead) ────────
step 3 "Setting up Rust toolchain..."

if [ "$PLATFORM" = "termux" ]; then
  # On Termux/Android, rustc crashes with SIGSEGV (stack overflow in the compiler)
  # when compiling wasmtime's macro-heavy code. This is a known Android limitation
  # (8MB stack vs 64MB on Linux). We use the pure Node.js WebAssembly engine instead.
  warn "Termux detected — skipping Rust build (using built-in Node.js WASM engine)"
  warn "The Node.js engine has full WASM + WASI support and requires zero compilation."
  SKIP_RUST_BUILD=true
else
  SKIP_RUST_BUILD=false
  if ! command -v cargo &>/dev/null; then
    info "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  fi
  # Source cargo env
  if [ -f "$HOME/.cargo/env" ]; then
    source "$HOME/.cargo/env"
  fi
  command -v cargo &>/dev/null || die "Rust/cargo not found after install. Please open a new shell and re-run."
  RUST_VER=$(rustc --version)
  success "Rust ready: $RUST_VER"
fi

# ── Step 4: Clone / update repo ───────────────────────────────────────────────
step 4 "Fetching DynWorker source..."

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation at $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning into $INSTALL_DIR ..."
  git clone "$REPO" "$INSTALL_DIR"
fi

success "Source ready at $INSTALL_DIR"

# ── Step 5: Build Rust engine (skipped on Termux) ─────────────────────────────
step 5 "Building Rust engine..."

if [ "$SKIP_RUST_BUILD" = "true" ]; then
  success "Skipped (Termux/Android: using pure Node.js WebAssembly engine)"
  ENGINE_BIN=""
else
  cd "$INSTALL_DIR/engine"
  source "$HOME/.cargo/env" 2>/dev/null || true

  # Build — stream output so user sees progress; capture exit code separately
  set +e
  cargo build --release 2>&1 | grep -E "^error|Compiling dynworker|Finished|warning\[E"
  BUILD_EXIT=${PIPESTATUS[0]}
  set -e

  if [ $BUILD_EXIT -ne 0 ]; then
    echo ""
    warn "Build failed. Running again with full output for diagnosis:"
    cargo build --release 2>&1 | tail -40
    die "Engine build failed. See output above."
  fi

  ENGINE_BIN="$INSTALL_DIR/engine/target/release/dynworker-engine"
  [ -f "$ENGINE_BIN" ] || die "Engine binary not found after build. Check logs above."
  success "Engine built: $ENGINE_BIN"
fi

# ── Step 6: Install Node deps + create launcher ───────────────────────────────
step 6 "Installing Node.js dependencies and creating launcher..."

cd "$INSTALL_DIR/api"
pnpm install --silent

cd "$INSTALL_DIR/sdk"
pnpm install --silent

# Create launcher
LAUNCHER_DIR="$HOME/.local/bin"
mkdir -p "$LAUNCHER_DIR"
LAUNCHER="$LAUNCHER_DIR/dynworker"

# On Termux, force the Node.js engine; on other platforms use Rust if available
if [ "$SKIP_RUST_BUILD" = "true" ]; then
  ENGINE_ENV="export DYNWORKER_ENGINE=node"
else
  ENGINE_ENV="export DYNWORKER_ENGINE_BIN=\"$ENGINE_BIN\""
fi

cat > "$LAUNCHER" << LAUNCHER_EOF
#!/usr/bin/env bash
# DynWorker launcher — auto-generated by bootstrap.sh
$ENGINE_ENV
export PORT="\${DYNWORKER_PORT:-$PORT}"
source "\$HOME/.cargo/env" 2>/dev/null || true
cd "$INSTALL_DIR/api"
exec node src/index.js "\$@"
LAUNCHER_EOF
chmod +x "$LAUNCHER"

# Add ~/.local/bin to PATH in shell rc files if not already there
add_to_path() {
  local RC="$1"
  if [ -f "$RC" ] && ! grep -q '\.local/bin' "$RC"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$RC"
    success "Added ~/.local/bin to PATH in $RC"
  fi
}
add_to_path "$HOME/.bashrc"
add_to_path "$HOME/.zshrc"
add_to_path "$HOME/.profile"
# Termux uses .bashrc but also check bash_profile
[ "$PLATFORM" = "termux" ] && add_to_path "$HOME/.bash_profile"

export PATH="$HOME/.local/bin:$PATH"

success "Launcher installed: $LAUNCHER"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  DynWorker installed successfully!  🎉                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Start the server:${NC}"
echo -e "    ${CYAN}dynworker${NC}"
echo -e "    ${CYAN}# Listening on http://0.0.0.0:$PORT${NC}"
echo ""
echo -e "  ${BOLD}Execute a worker:${NC}"
echo -e "    ${CYAN}WASM=\$(base64 \$([ \"\$(uname)\" = Darwin ] && echo '') -w0 path/to/module.wasm)${NC}"
echo -e "    ${CYAN}curl -X POST http://localhost:$PORT/v1/execute \\${NC}"
echo -e "    ${CYAN}  -H 'Content-Type: application/json' \\${NC}"
echo -e "    ${CYAN}  -d '{\"main_module\":\"m.wasm\",\"modules\":{\"m.wasm\":\"\$WASM\"}}'${NC}"
echo ""
echo -e "  ${BOLD}Docs & source:${NC}"
echo -e "    ${CYAN}https://github.com/elevate-foundry/dynworker${NC}"
echo ""

# Remind about new shell if PATH was just updated
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  warn "Run ${CYAN}source ~/.bashrc${NC} (or open a new terminal) to use the ${CYAN}dynworker${NC} command"
fi
