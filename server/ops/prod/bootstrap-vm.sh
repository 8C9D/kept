#!/usr/bin/env bash
# One-time bootstrap of the production VM (Ubuntu 24.04) for the Kept API
# origin. Run once, as the VM's default user, over ssh:
#
#   ssh <user>@<vm> bash -s < server/ops/prod/bootstrap-vm.sh
#
# Creates a 2 GB swapfile (the VM has 1 GiB of RAM; the compose file's
# memswap_limit relies on it), installs Docker (Docker's repository:
# Ubuntu's docker.io lags and ships no compose plugin), cloudflared
# (Cloudflare's repository), and unattended security upgrades; clones the
# repository to /opt/kept; creates /etc/kept for the env file. Idempotent:
# safe to re-run.
#
# Two things it deliberately does NOT do, because both need a value only the
# operator holds:
#   1. `sudo cloudflared service install <tunnel token>` - the token for the
#      tunnel `kept-api`, from the Cloudflare account.
#   2. /etc/kept/kept.env - copy kept.env.example there, fill it, chmod 0600.
# The API cannot boot until (2) is done: the boot probes refuse to serve
# without a reachable database and bucket.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Swap
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile > /dev/null
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab > /dev/null
fi
sudo swapon --show | grep -q /swapfile || sudo swapon /swapfile

sudo apt-get update -q
sudo apt-get install -y -q ca-certificates curl git unattended-upgrades

# Docker
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# cloudflared
sudo curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list > /dev/null

sudo apt-get update -q
sudo apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin cloudflared
sudo usermod -aG docker "$USER"

# Unattended security upgrades (Ubuntu's default configuration, enabled).
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

# The repository and the configuration directory.
if [ ! -d /opt/kept/.git ]; then
  sudo git clone --quiet https://github.com/8C9D/kept.git /opt/kept
  sudo chown -R "$USER":"$USER" /opt/kept
fi
sudo install -d -m 0700 -o "$USER" -g "$USER" /etc/kept
if [ ! -f /etc/kept/kept.env ]; then
  install -m 0600 /opt/kept/server/ops/prod/kept.env.example /etc/kept/kept.env
  echo "/etc/kept/kept.env is the unfilled template - fill it before deploying"
fi

echo
echo "Bootstrap complete. Versions:"
docker --version
docker compose version
cloudflared --version
echo
echo "Next, by hand:"
echo "  sudo cloudflared service install <tunnel token>     # tunnel kept-api"
echo "  \$EDITOR /etc/kept/kept.env                          # then: chmod 0600"
echo "Then log out and back in so the docker group applies, and deploy with server/ops/prod/deploy.sh."
