#!/usr/bin/env bash
# Prints the two DNS records to add by hand in Cloudflare (docs/AWS_SETUP.md, step 9). It only READS from
# AWS (the stack's outputs and the certificate); it changes nothing anywhere, and needs no DNS access.
#
#   scripts/dns-records.sh            after `cdk deploy` has started (the certificate exists)
#   scripts/dns-records.sh --dry-run  shows what it would look up, without calling AWS
#
# Uses your AWS_PROFILE and AWS_REGION (default us-east-2). Stack name: CounselorInsights.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
STACK="${STACK_NAME:-CounselorInsights}"

if [ "${1:-}" = "--dry-run" ]; then
  echo "[dry run] would read the stack outputs Hostname, CertificateArn and LoadBalancerDnsName from '$STACK' in $REGION,"
  echo "[dry run] then read the certificate's DNS validation record, and print both records. Nothing is changed."
  exit 0
fi

command -v aws >/dev/null || { echo "The AWS CLI is not installed. See docs/AWS_SETUP.md, step 4." >&2; exit 1; }
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || {
  echo "The AWS CLI is not signed in. Run: aws login --region us-east-2   (see docs/AWS_SETUP.md, step 4)" >&2
  exit 1
}

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>/dev/null || true
}

HOST="$(out Hostname)"
CERT="$(out CertificateArn)"
LB="$(out LoadBalancerDnsName)"
[ -n "$HOST" ] && [ "$HOST" != "None" ] || { echo "Could not read the stack '$STACK'. Has 'cdk deploy' been started?" >&2; exit 1; }

echo "Add these two records for persimmon-care.com in Cloudflare (or in Vercel if that is where the DNS is managed)."
echo "Set BOTH to 'DNS only' (grey cloud), not proxied. Do not touch any other record, especially 'tracker'."
echo

# Record 1: the certificate validation CNAME. It may take a minute to appear after the deploy starts.
if [ -n "$CERT" ] && [ "$CERT" != "None" ]; then
  REC="$(aws acm describe-certificate --certificate-arn "$CERT" --region "$REGION" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]' --output text 2>/dev/null || true)"
  if [ -n "$REC" ] && [ "$REC" != "None" ]; then
    NAME="$(printf '%s' "$REC" | awk '{print $1}')"
    VALUE="$(printf '%s' "$REC" | awk '{print $2}')"
    echo "1. Certificate validation"
    echo "   Type:   CNAME"
    echo "   Name:   $NAME"
    echo "   Target: $VALUE"
  else
    echo "1. Certificate validation: not ready yet. Wait a minute and run this again."
  fi
else
  echo "1. Certificate validation: the stack has no certificate output yet."
fi
echo

# Record 2: the app's address, pointing at the load balancer.
if [ -n "$LB" ] && [ "$LB" != "None" ]; then
  echo "2. The app's address"
  echo "   Type:   CNAME"
  echo "   Name:   ${HOST%%.*}   (that is: $HOST)"
  echo "   Target: $LB"
else
  echo "2. The app's address: the load balancer is not created yet. Run this again later."
fi
