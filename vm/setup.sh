#!/usr/bin/env bash
# Turns a fresh exe.dev VM (exeuntu: Ubuntu, systemd, passwordless sudo) into a T3 Code
# environment, then prints one line "T3EXE_RESULT <json>" with what t3exe needs to link it.
#
# Inputs (environment):
#   T3_VERSION  T3 Code version to install, the same as the local one
#   PORT        port for `t3 serve`; exe.dev's HTTPS proxy forwards to it
#   REPO, REF   git repository to clone and the ref to check out (both optional)
#   SCOPES      space-separated scopes for the pairing code
#   LABEL       label for the pairing code
#   ENV_B64     base64 systemd EnvironmentFile for the T3 Code service (optional)
set -euo pipefail
trap 'echo "[t3exe] setup failed at line $LINENO" >&2' ERR
log() { echo "[t3exe] $*"; }

export PATH="$HOME/.local/bin:$HOME/.t3exe/node/bin:$PATH"
T3="$HOME/.local/bin/t3"
BASE="$HOME/.t3"
mkdir -p "$HOME/.t3exe" "$HOME/.local/bin" "$BASE/userdata"

# T3 Code, from its official installer, which checks the release checksums.
if [ "$("$T3" --version 2>/dev/null)" != "t3 v$T3_VERSION" ]; then
  log "installing T3 Code $T3_VERSION"
  curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION="$T3_VERSION" T3CODE_INSTALL_BIN_DIR="$HOME/.local/bin" sh >/dev/null
fi

# The agent CLIs T3 Code drives are npm packages.
if ! command -v node >/dev/null; then
  log "installing Node.js"
  case "$(uname -m)" in aarch64 | arm64) arch=arm64 ;; *) arch=x64 ;; esac
  dist=https://nodejs.org/dist/latest-v24.x
  sums=$(curl -fsSL "$dist/SHASUMS256.txt")
  file=$(awk -v f="linux-$arch.tar.xz" '$2 ~ f"$" { print $2 }' <<<"$sums")
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$dist/$file"
  (cd "$tmp" && grep " $file\$" <<<"$sums" | sha256sum -c --quiet)
  mkdir -p "$HOME/.t3exe/node"
  tar -xJf "$tmp/$file" -C "$HOME/.t3exe/node" --strip-components=1
  rm -rf "$tmp"
fi
for pkg in claude:@anthropic-ai/claude-code codex:@openai/codex; do
  if ! command -v "${pkg%%:*}" >/dev/null; then
    log "installing ${pkg#*:}"
    npm install -g --prefix "$HOME/.local" --no-fund --no-audit --loglevel=error "${pkg#*:}" >/dev/null || log "could not install ${pkg#*:}"
  fi
done

# Secrets forwarded from the local machine, for the service only.
umask 077
printf %s "${ENV_B64:-}" | base64 -d >"$HOME/.t3exe/env"
umask 022

# Without forwarded API keys, agents use exe.dev's LLM integration if the VM has one.
if curl -fsS -m 10 -o /dev/null https://llm.int.exe.xyz/v1/models 2>/dev/null; then
  if ! grep -qE '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=' "$HOME/.t3exe/env"; then
    log "Claude Code uses exe.dev's LLM integration"
    mkdir -p "$HOME/.claude"
    f="$HOME/.claude/settings.json"
    [ -s "$f" ] || echo '{}' >"$f"
    jq '.apiKeyHelper = "printf exe" | .env.ANTHROPIC_BASE_URL = "https://llm.int.exe.xyz"' "$f" >"$f.new" && mv "$f.new" "$f"
  fi
  if ! grep -qE '^(OPENAI_API_KEY|CODEX_API_KEY)=' "$HOME/.t3exe/env" && ! grep -qs exe-llm "$HOME/.codex/config.toml"; then
    log "Codex uses exe.dev's LLM integration"
    mkdir -p "$HOME/.codex"
    printf '%s\n' 'model_provider = "exe-llm"' '' '[model_providers.exe-llm]' 'name = "exe.dev"' \
      'base_url = "https://llm.int.exe.xyz/v1"' 'requires_openai_auth = false' >>"$HOME/.codex/config.toml"
  fi
fi

# The VM's T3 Code accepts links from other environments.
f="$BASE/userdata/settings.json"
[ -s "$f" ] || echo '{}' >"$f"
jq '.linkedEnvironmentsEnabled = true' "$f" >"$f.new" && mv "$f.new" "$f"

# systemd keeps the server up across crashes, reboots and pause/resume.
sudo tee /etc/systemd/system/t3exe.service >/dev/null <<EOF
[Unit]
Description=T3 Code server (t3exe)
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$HOME
Environment=PATH=$PATH:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$HOME/.t3exe/env
ExecStart=$T3 serve --host 0.0.0.0 --port $PORT --base-dir $BASE --no-browser
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable t3exe.service >/dev/null 2>&1
sudo systemctl restart t3exe.service

# The workspace: a clone of REPO, or an empty git repository.
if [ -n "${REPO:-}" ]; then
  dir="$HOME/$(basename "${REPO%.git}")"
  if [ ! -d "$dir/.git" ]; then
    # A github.com repository goes through exe.dev's GitHub integration when one attached to
    # this VM covers it (`t3exe repo add`): private repositories clone and pushes work, with no
    # token here. origin keeps its github.com URL, which T3 Code knows the repository by; a
    # rewrite in the clone's git config sends git to the integration.
    gh=$(printf '%s\n' "$REPO" | sed -nE 's#^https://github(\.int\.exe\.xyz|\.com)/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/?$#\2#p')
    gh=${gh%.git}
    via=()
    if [ -n "$gh" ] && GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote "https://github.int.exe.xyz/$gh.git" HEAD >/dev/null 2>&1; then
      REPO="https://github.com/$gh.git"
      via=(-c "url.https://github.int.exe.xyz/$gh.git.insteadOf=$REPO")
      log "cloning $REPO through exe.dev's GitHub integration"
    else
      log "cloning $REPO"
    fi
    GIT_TERMINAL_PROMPT=0 git "${via[@]}" clone --quiet "$REPO" "$dir" || {
      if [ -n "$gh" ]; then
        echo "[t3exe] git clone failed: if $gh is private, run \`t3exe repo add $gh\` on your computer so VMs can reach it" >&2
      else
        echo "[t3exe] git clone failed: a private repository needs credentials on the VM" >&2
      fi
      exit 1
    }
    [ ${#via[@]} -eq 0 ] || git -C "$dir" config "url.https://github.int.exe.xyz/$gh.git.insteadOf" "$REPO"
  fi
  [ -z "${REF:-}" ] || git -C "$dir" checkout --quiet "$REF"
else
  dir="$HOME/workspace"
  mkdir -p "$dir"
  [ -d "$dir/.git" ] || git -C "$dir" init --quiet
fi

log "starting T3 Code"
for _ in $(seq 90); do
  curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/.well-known/t3/environment" && break
  sleep 1
done
curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PORT/.well-known/t3/environment" ||
  { journalctl -u t3exe.service -n 30 --no-pager >&2; exit 1; }

# "Added project <id> (<title>) at <path>."
project=$("$T3" project add "$dir" --base-dir "$BASE" | sed -n 's/^Added project \([^ ]*\) .*/\1/p')
[ -n "$project" ] || { echo "[t3exe] t3 project add printed no project id" >&2; exit 1; }

scopes=()
for s in $SCOPES; do scopes+=(--scope "$s"); done
code=$("$T3" auth pairing create --base-dir "$BASE" --json --ttl 5m --label "$LABEL" "${scopes[@]}" | jq -r .credential)

echo "T3EXE_RESULT $(jq -cn --arg project "$project" --arg workspace "$dir" --arg code "$code" \
  '{projectId: $project, workspace: $workspace, pairingCode: $code}')"
