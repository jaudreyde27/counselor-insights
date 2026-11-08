#!/usr/bin/env bash
# Creates a sign-in profile (a counselor) in the deployed app's user pool. AWS emails the person a temporary
# password; the app makes them choose their own at first sign-in. Nobody can sign themselves up: this is the only way in.
#
#   scripts/add-user.sh name@example.com ["Full Name"]
#   scripts/add-user.sh --dry-run name@example.com
#
# Needs `aws login --region us-east-2` first. Each person's students and sessions are private to them.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
STACK="${STACK_NAME:-CounselorInsights}"

DRY=""
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
EMAIL="${1:-}"
NAME="${2:-}"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo "Usage: scripts/add-user.sh name@example.com [\"Full Name\"]" >&2; exit 1; }

if [ -n "$DRY" ]; then
  echo "[dry run] would create '$EMAIL' in the user pool of stack '$STACK' ($REGION) and email a temporary password. Nothing is changed."
  exit 0
fi

aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || { echo "Not signed in. Run: aws login --region $REGION" >&2; exit 1; }
POOL="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]" --output text)"

ATTRS=("Name=email,Value=$EMAIL" "Name=email_verified,Value=true")
[ -n "$NAME" ] && ATTRS+=("Name=name,Value=$NAME")

STATUS="$(aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" --user-attributes "${ATTRS[@]}" \
  --desired-delivery-mediums EMAIL --region "$REGION" --query "User.UserStatus" --output text)"
echo "Created $EMAIL ($STATUS). AWS is emailing a temporary password; they choose a new one at first sign-in."
