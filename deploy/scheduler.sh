#!/usr/bin/env bash
# Cloud Scheduler job: POST /api/tick every minute with the tick secret (read from Secret Manager, never printed).
set -u
G=/c/Users/ankit/tools/google-cloud-sdk/bin/gcloud
P=gen-lang-client-0589191977
U=https://quorumguard-1037019152152.asia-south1.run.app
$G services enable cloudscheduler.googleapis.com --project $P >/dev/null 2>&1
T=$($G secrets versions access latest --secret quorumguard-tick-secret --project $P)
ARGS=(--project $P --location asia-south1 --schedule "* * * * *" --uri "$U/api/tick" --http-method POST --attempt-deadline 280s)
if $G scheduler jobs describe quorumguard-tick --project $P --location asia-south1 >/dev/null 2>&1; then
  $G scheduler jobs update http quorumguard-tick "${ARGS[@]}" --update-headers "x-tick-secret=$T" >/dev/null 2>&1 && echo "scheduler updated"
else
  $G scheduler jobs create http quorumguard-tick "${ARGS[@]}" --headers "x-tick-secret=$T" >/dev/null 2>&1 && echo "scheduler created"
fi
$G scheduler jobs run quorumguard-tick --project $P --location asia-south1 >/dev/null 2>&1 && echo "first tick sent"
echo "DONE"
