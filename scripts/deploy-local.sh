#!/usr/bin/env bash
# Builds the app image on THIS computer, pushes it to AWS, runs the database migration, and starts/updates the app.
# Use this because GitHub cannot deploy to this free-plan AWS account (an account-level policy blocks the GitHub
# connection). Needs: Docker running, and `aws login --region us-east-2` done. Run it on a FAST network: the image
# upload is the slow part (about 94 MB).
#
#   scripts/deploy-local.sh            full deploy
#   scripts/deploy-local.sh --dry-run  shows the steps, changes nothing
#
# Uses AWS_REGION (default us-east-2) and the stack CounselorInsights. The image is built for linux/amd64 because the
# app server runs on x86 (infra/lib/app.ts).
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
STACK="${STACK_NAME:-CounselorInsights}"
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

if [ "${1:-}" = "--dry-run" ]; then
  echo "[dry run] would: read the stack outputs from '$STACK' in $REGION; build the image (linux/amd64); log in to the registry;"
  echo "[dry run] push it; run the migration task and wait for it; then point the app service at the new image and wait until it is stable."
  exit 0
fi

command -v docker >/dev/null || { echo "Docker was not found. Install and start Docker Desktop." >&2; exit 1; }
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || { echo "Not signed in. Run: aws login --region $REGION" >&2; exit 1; }

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }
REPO_URI="$(out RepositoryUri)"; CLUSTER="$(out ClusterName)"; SERVICE="$(out ServiceName)"
MIGRATE_FAMILY="$(out MigrateTaskFamily)"; APP_FAMILY="$(out AppTaskFamily)"
SUBNETS="$(out PublicSubnetIds)"; SG="$(out AppSecurityGroupId)"
TAG="$(date +%Y%m%d-%H%M%S)"

echo "1/5 Building the image (this is slow on an Apple chip: it builds for the Intel server)..."
docker build --platform linux/amd64 -t "$REPO_URI:$TAG" -t "$REPO_URI:latest" .

echo "2/5 Pushing the image (retries if the network drops a layer)..."
for i in 1 2 3 4 5; do
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPO_URI%%/*}" >/dev/null
  if docker push "$REPO_URI:$TAG" && docker push "$REPO_URI:latest"; then break; fi
  [ "$i" = 5 ] && { echo "The upload failed 5 times. Try a faster network." >&2; exit 1; }
  echo "Upload attempt $i failed, retrying..."
done

echo "3/5 Running the database migration..."
TASKDEF="$(aws ecs describe-task-definition --task-definition "$MIGRATE_FAMILY" --region "$REGION" --query 'taskDefinition.taskDefinitionArn' --output text)"
TASK="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$TASKDEF" --region "$REGION" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK" --region "$REGION"
CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --region "$REGION" --query 'tasks[0].containers[0].exitCode' --output text)"
[ "$CODE" = "0" ] || { echo "The migration failed (exit code $CODE). See the /counselor-insights/app log group, stream prefix 'migrate'." >&2; exit 1; }

echo "4/5 Starting the app on the new image..."
APP_TASKDEF="$(aws ecs describe-task-definition --task-definition "$APP_FAMILY" --region "$REGION" --query 'taskDefinition.taskDefinitionArn' --output text)"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$APP_TASKDEF" --desired-count 1 --force-new-deployment --region "$REGION" >/dev/null

echo "5/5 Waiting for the app to be healthy..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"
echo "Done. The app is at https://$(out Hostname)"
