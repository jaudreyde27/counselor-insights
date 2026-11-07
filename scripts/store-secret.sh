#!/usr/bin/env bash
# Stores a secret in AWS Secrets Manager WITHOUT the value ever appearing in chat, a file, your shell
# history or the list of running programs. Run it yourself, in your own terminal, after the AWS CLI is
# set up (docs/AWS_SETUP.md, step 4). Claude Code never sees what you type.
#
#   scripts/store-secret.sh assemblyai-key     asks you to paste the AssemblyAI API key (hidden as you type)
#   scripts/store-secret.sh webhook-secret     makes up a long random webhook secret and stores it
#
# Add --dry-run to see what would be run without touching AWS.
# Uses your AWS_PROFILE and AWS_REGION (default us-east-2). If the secret already exists it is updated.
set -euo pipefail

KIND="${1:-}"
DRY="${2:-}"
REGION="${AWS_REGION:-us-east-2}"
PREFIX="counselor-insights"

case "$KIND" in
  assemblyai-key)
    NAME="$PREFIX/assemblyai-api-key"
    DESC="AssemblyAI API key for the Counselor Insights prototype"
    ;;
  webhook-secret)
    NAME="$PREFIX/assemblyai-webhook-secret"
    DESC="Secret header AssemblyAI sends on its webhook call"
    ;;
  *)
    echo "Usage: scripts/store-secret.sh assemblyai-key|webhook-secret [--dry-run]" >&2
    exit 1
    ;;
esac

if [ "$DRY" = "--dry-run" ]; then
  echo "[dry run] would ask for (or generate) the value, then store it as '$NAME' in region $REGION."
  echo "[dry run] aws secretsmanager create-secret (or put-secret-value if it already exists) --name $NAME"
  exit 0
fi

command -v aws >/dev/null || { echo "The AWS CLI is not installed. See docs/AWS_SETUP.md, step 4." >&2; exit 1; }
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || {
  echo "The AWS CLI is not signed in. Run: aws login --region us-east-2   (see docs/AWS_SETUP.md, step 4)" >&2
  exit 1
}

if [ "$KIND" = "assemblyai-key" ]; then
  printf "Paste the AssemblyAI API key (nothing will show as you type), then press Enter: " >&2
  read -r -s VALUE
  printf "\n" >&2
  [ -n "$VALUE" ] || { echo "Nothing was entered. Nothing was stored." >&2; exit 1; }
else
  VALUE="$(openssl rand -hex 32)"
fi

# The value is sent on standard input (file:///dev/stdin), never as a command-line argument.
if aws secretsmanager describe-secret --secret-id "$NAME" --region "$REGION" >/dev/null 2>&1; then
  printf %s "$VALUE" | aws secretsmanager put-secret-value --secret-id "$NAME" --secret-string file:///dev/stdin --region "$REGION" >/dev/null
  echo "Updated '$NAME'."
else
  printf %s "$VALUE" | aws secretsmanager create-secret --name "$NAME" --description "$DESC" --secret-string file:///dev/stdin --region "$REGION" >/dev/null
  echo "Stored '$NAME'."
fi
unset VALUE
