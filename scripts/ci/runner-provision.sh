#!/usr/bin/env bash
# VM startup script (runs as root on EVERY boot via the instance's startup-script metadata; idempotent).
# Installs Docker + build/browser deps, the hash-verified GitHub Actions runner, a no-sudo `runner` user,
# per-instance systemd units, a workspace-cleaning job hook and the idle-shutdown timer.
# Contains no secrets: runner registration is done separately by runner-register.sh over IAP SSH.
set -euo pipefail
exec > >(tee -a /var/log/mandalika-provision.log) 2>&1
echo "== provision $(date -u +%FT%TZ)"

IDLE_MINUTES=30
export DEBIAN_FRONTEND=noninteractive

# --- packages -------------------------------------------------------------
if [ ! -f /var/lib/mandalika-ci.pkgs ]; then
  apt-get update -qq
  apt-get install -y -qq docker.io git jq curl ca-certificates tar unzip util-linux build-essential \
    python3 python3-venv python-is-python3 iptables
  # OS libraries for headless Chromium (Ubuntu 24.04 names; host Node is not needed: setup-node supplies it).
  for p in libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2     libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6     libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 fonts-liberation fonts-noto-color-emoji fonts-freefont-ttf; do
    apt-get install -y -qq "$p" || echo "WARN: could not install $p"
  done
  touch /var/lib/mandalika-ci.pkgs
fi
systemctl enable --now docker

# --- user: no sudo, docker group (docker access is root-equivalent on this VM; the VM holds no secrets) ----
id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
usermod -aG docker runner
passwd -l runner >/dev/null

# --- kernel: keep gate fixture ports out of the ephemeral pool (the workflow's sudo step is a no-op here) ----
echo 'net.ipv4.ip_local_reserved_ports = 26439-26479' >/etc/sysctl.d/99-mandalika-ci.conf
sysctl --system >/dev/null

# --- jobs must not reach the metadata server (the service account has no roles anyway; defence in depth) ----
iptables -C OUTPUT -d 169.254.169.254 -m owner --uid-owner runner -j REJECT 2>/dev/null \
  || iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner runner -j REJECT

# --- jobs only see their own processes (a registration token may be briefly on argv during setup) ----------
mount -o remount,hidepid=2 /proc

# --- runner binaries (sha256 taken from the official release notes) ------------------------------------
TEMPLATE=/opt/mandalika-ci/runner-template
if [ ! -x "$TEMPLATE/run.sh" ]; then
  mkdir -p "$TEMPLATE"
  rel="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
  ver="$(jq -r .tag_name <<<"$rel" | sed 's/^v//')"
  want="$(jq -r .body <<<"$rel" | grep -o "actions-runner-linux-x64-${ver}.tar.gz.*" | grep -oE '[0-9a-f]{64}' | head -1)"
  [ -n "$want" ] || { echo "could not read the runner sha256 from the release notes" >&2; exit 1; }
  curl -fsSL -o /tmp/runner.tgz "https://github.com/actions/runner/releases/download/v${ver}/actions-runner-linux-x64-${ver}.tar.gz"
  echo "$want  /tmp/runner.tgz" | sha256sum -c -
  tar -xzf /tmp/runner.tgz -C "$TEMPLATE"; rm -f /tmp/runner.tgz
  "$TEMPLATE/bin/installdependencies.sh" >/dev/null
fi

# --- job hook: wipe the workspace before and after every job (runners are persistent, jobs are not) ------
cat >/opt/mandalika-ci/hook-clean.sh <<'HOOK'
#!/usr/bin/env bash
ws="${GITHUB_WORKSPACE:-}"
case "$ws" in /home/runner/*/_work/*/*) find "$ws" -mindepth 1 -delete 2>/dev/null || true ;; esac
rm -rf /home/runner/*/_work/_temp/* 2>/dev/null || true
exit 0
HOOK
chmod 755 /opt/mandalika-ci/hook-clean.sh

# --- registration helper (token on stdin, never argv) -----------------------------------------------------
cat >/opt/mandalika-ci/register.sh <<'REG'
#!/usr/bin/env bash
# Usage: printf '%s' "$TOKEN" | sudo /opt/mandalika-ci/register.sh <instance> <repo-url> <extra-label>
# Windows plink drops piped stdin, so a 4th argument (the token) is accepted as a fallback; it is then briefly in the
# process list of an idle VM and expires within an hour.
set -euo pipefail
inst="$1" url="$2" label="$3"
[[ "$inst" =~ ^[a-z]+-[0-9]+$ ]] || { echo "bad instance name" >&2; exit 2; }
if [ -n "${4:-}" ]; then token="$4"; else IFS= read -r token; fi
token="${token%$''}"
dir="/home/runner/$inst"
if [ ! -d "$dir" ]; then cp -a /opt/mandalika-ci/runner-template "$dir"; chown -R runner:runner "$dir"; fi
if [ ! -f "$dir/.runner" ]; then
  sudo -u runner bash -c "cd '$dir' && ./config.sh --unattended --replace --url '$url' --token \"\$0\" --name 'mandalika-ci-$inst' --labels '$label' --work _work" "$token"
fi
systemctl enable --now "mandalika-runner@$inst.service"
REG
chmod 755 /opt/mandalika-ci/register.sh

cat >/etc/systemd/system/mandalika-runner@.service <<'UNIT'
[Unit]
Description=GitHub Actions runner %i
After=network-online.target docker.service
Wants=network-online.target
ConditionPathExists=/home/runner/%i/.runner

[Service]
User=runner
WorkingDirectory=/home/runner/%i
Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/mandalika-ci/hook-clean.sh
Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/mandalika-ci/hook-clean.sh
ExecStart=/home/runner/%i/run.sh
Restart=always
RestartSec=10
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=multi-user.target
UNIT

# --- idle shutdown: poweroff after IDLE_MINUTES with no Runner.Worker (i.e. no job) ------------------------
cat >/usr/local/bin/mandalika-idle-check.sh <<IDLE
#!/usr/bin/env bash
state=/run/mandalika-last-busy
now=\$(date +%s)
if pgrep -f Runner.Worker >/dev/null || [ ! -f "\$state" ]; then echo "\$now" >"\$state"; exit 0; fi
last=\$(cat "\$state")
# Idle housekeeping: leftover gate containers and dangling images.
docker ps -aq --filter label=mandalika-ci | xargs -r docker rm -f >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
if [ \$((now - last)) -ge $((IDLE_MINUTES * 60)) ]; then logger "mandalika-idle: no job for ${IDLE_MINUTES} min, powering off"; systemctl poweroff; fi
IDLE
chmod 755 /usr/local/bin/mandalika-idle-check.sh
cat >/etc/systemd/system/mandalika-idle.service <<'UNIT'
[Unit]
Description=Power off the CI VM when idle

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mandalika-idle-check.sh
UNIT
cat >/etc/systemd/system/mandalika-idle.timer <<'UNIT'
[Unit]
Description=Idle check every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now mandalika-idle.timer
# Start every already-registered instance (units are condition-guarded on .runner).
for d in /home/runner/*-[0-9]*; do
  if [ -f "$d/.runner" ]; then systemctl enable --now "mandalika-runner@$(basename "$d").service" || true; fi
done
echo "== provision done"
