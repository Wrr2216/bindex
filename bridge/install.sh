#!/usr/bin/env bash
# Prerequisites for the reader bridge, on Raspberry Pi OS or Debian.
# This builds python-mercuryapi against the MercuryAPI it bundles, which is 1.35.
# That predates the M7e; if the reader is not recognised, rebuild against the
# 1.37 SDK as described in the README.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y \
  git unzip patch xsltproc gcc \
  libreadline-dev python3-dev python3-pip python3-setuptools

# Serial access without sudo (re-login afterwards for this to take effect).
sudo usermod -aG dialout "$USER" || true

# The `mercury` Python module (python-mercuryapi).
pip3 install --user --break-system-packages python-mercuryapi || pip3 install --user python-mercuryapi

echo
echo "Installed. Next:"
echo "  1) cp .env.example .env  and fill in SERVER_URL + DEVICE_TOKEN"
echo "  2) Re-login (for dialout group), then:  READ_TEST=1 ./run.sh   to verify reads"
echo "  3) ./run.sh   to stream to the app"
echo
echo "If step 2 reports an unsupported reader or region, the bundled MercuryAPI"
echo "predates the M7e. Rebuild against the 1.37 SDK; the README explains how."
