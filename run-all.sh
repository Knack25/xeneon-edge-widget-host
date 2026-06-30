#!/bin/bash

cd "$(dirname "$0")"

NODE_CMD=node
if ! command -v "$NODE_CMD" > /dev/null 2>&1; then
    if command -v nodejs > /dev/null 2>&1; then
        NODE_CMD=nodejs
    fi
fi

# Define functions first
start_vu_bridge() {
    cd "widgets/VU Meter Onkyo - Manny"
    "$NODE_CMD" audio-server.js &
    cd - > /dev/null
}

start_spectrum_bridge() {
    cd "widgets/SpectrumAnalyzer-v1.0.1 1"
    "$NODE_CMD" "spectrum-server 2.js" &
    cd - > /dev/null
}

start_web() {
    start_electron_app
}

start_web_server() {
    "$NODE_CMD" web-server.js &
    sleep 1
}

start_electron_app() {
    if [ -f "node_modules/electron/dist/electron" ] && [ -f "scripts/start-electron.js" ]; then
        node scripts/start-electron.js "$(pwd)" &
    else
        echo "Electron was not found under node_modules."
        echo "To enable Electron mode, run 'npm install' from the app folder."
        echo "Falling back to browser app mode."
        start_web_server
        start_browser_app
    fi
}

start_browser_app() {
    # Try different browsers for app mode
    if command -v chromium-browser > /dev/null 2>&1; then
        chromium-browser --app="http://127.0.0.1:8080/" &
    elif command -v chromium > /dev/null 2>&1; then
        chromium --app="http://127.0.0.1:8080/" &
    elif command -v google-chrome > /dev/null 2>&1; then
        google-chrome --app="http://127.0.0.1:8080/" &
    else
        echo "No compatible browser found for app mode. Install Chromium: sudo apt update && sudo apt install chromium-browser"
        echo "Falling back to opening in default browser."
        xdg-open "http://127.0.0.1:8080/" &
    fi
}

start_demo() {
    "$NODE_CMD" levels-server.js &
}

usage() {
    echo "Usage: ./run-all.sh [both|vu|spectrum|web|browser|demo]"
    echo
    echo "  both      Start VU bridge on 3748, Spectrum bridge on 3749, and Electron UI."
    echo "  vu        Start only the VU bridge and Electron UI."
    echo "  spectrum  Start only the Spectrum bridge and Electron UI."
    echo "  web       Start only the Electron UI."
    echo "  browser   Start the web UI in browser app mode."
    echo "  demo      Start the Node dummy levels server on 3748 and Electron UI."
    echo
}

# Main logic
MODE="$1"
if [ -z "$MODE" ]; then MODE="both"; fi

if [ "$MODE" = "help" ]; then
    usage
    exit 0
fi
if [ "$MODE" = "all" ]; then MODE="both"; fi

if ! command -v "$NODE_CMD" > /dev/null 2>&1; then
    echo "Node.js was not found. Install Node.js, then run this again."
    echo "On Raspberry Pi, install Node.js globally via apt:"
    echo "  sudo apt update && sudo apt install -y nodejs npm"
    echo "If you already have nodejs but not node, create a symlink:"
    echo "  sudo ln -s $(command -v nodejs) /usr/local/bin/node"
    read -p "Press enter to continue"
    exit 1
fi

case "$MODE" in
    both)
        start_vu_bridge
        start_spectrum_bridge
        start_web
        ;;
    vu)
        start_vu_bridge
        start_web
        ;;
    spectrum)
        start_spectrum_bridge
        start_web
        ;;
    web)
        start_web
        ;;
    browser)
        start_web_server
        start_browser_app
        ;;
    demo)
        start_demo
        start_web
        ;;
    *)
        usage
        exit 1
        ;;
esac