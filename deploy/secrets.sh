#!/usr/bin/env bash
# Puts QuorumGuard's secrets into Secret Manager from the Windows user environment, without printing them,
# and lets Cloud Run's service account read them. Run once (re-running adds a new version).
set -u
G=/c/Users/ankit/tools/google-cloud-sdk/bin/gcloud
P=gen-lang-client-0589191977
env_of() { powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('$1','User')" | tr -d '\r\n'; }
mk() {
  if [ -z "$2" ]; then echo "$1: value missing, skipped"; return; fi
  if $G secrets describe "$1" --project $P >/dev/null 2>&1; then
    printf %s "$2" | $G secrets versions add "$1" --project $P --data-file=- >/dev/null 2>&1 && echo "$1 updated"
  else
    printf %s "$2" | $G secrets create "$1" --project $P --replication-policy=automatic --data-file=- >/dev/null 2>&1 && echo "$1 created"
  fi
}
mk quorumguard-near-ai-key "$(env_of NEAR_AI_API_KEY)"
mk quorumguard-telegram-token "$(env_of TELEGRAM_BOT_TOKEN)"
$G secrets describe quorumguard-tick-secret --project $P >/dev/null 2>&1 || mk quorumguard-tick-secret "$(python -c 'import secrets;print(secrets.token_hex(24))')"
PN=$($G projects describe $P --format="value(projectNumber)")
for s in quorumguard-near-ai-key quorumguard-telegram-token quorumguard-tick-secret; do
  $G secrets add-iam-policy-binding $s --project $P --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor >/dev/null 2>&1 && echo "$s: Cloud Run can read it"
done
echo "DONE"
