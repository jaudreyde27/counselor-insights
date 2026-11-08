# Shutting the prototype down

This is a class project. It is **due December 2, 2026** and is **switched off after December 15, 2026**. This page says what happens automatically, what does not, and what to do by hand.

## What happens automatically

From the **end of December 15, 2026, Pacific time** (midnight, the start of December 16), the app refuses everything:

- Every page, form, upload and webhook call gets an HTTP **410 Gone**. Pages show a plain "This prototype has been switched off" notice. Nobody can sign in and no student information is shown.
- No new analysis and no new transcription are started (so no AI or AssemblyAI calls).
- Only `/healthz` still answers, so the load balancer does not keep restarting the app.

The date is `APP_ACTIVE_UNTIL` (a `YYYY-MM-DD` date, active through the end of that day). If the setting is missing, December 15, 2026 applies. If it is badly formed, the app switches **off**, never on. The code is in `src/lib/lifecycle.ts` and `src/proxy.ts`; nobody should remove that check.

## What does NOT happen automatically

Switching the app off only stops it answering. **It does not stop AWS charges and it does not delete anything.** After December 15 these all still exist, and some still cost money:

| Still there | Still costs money? |
|---|---|
| The load balancer | Yes (a large part of the roughly $50 to $60 a month) |
| The app server (Fargate) | Yes, unless scaled to zero |
| The database and its data (fictional students, transcripts, themes) | Yes |
| The S3 bucket and every uploaded recording | A little |
| The login (Cognito), secrets, logs, the audit trail | A little |
| AssemblyAI account and key | No, but the key stays valid |
| Two DNS records in Cloudflare | No |

Every extra day it runs costs about $2. Your budget alert is $25 a month.

## What the cloud setup (Phase 3) must include

When the infrastructure is written, it must include these, so cost stops even if nobody remembers:

1. `APP_ACTIVE_UNTIL=2026-12-15` set on the app.
2. A **scheduled scale-to-zero** of the app server for December 16, 2026 (an Application Auto Scaling scheduled action). This stops the compute bill by itself.
3. Do **not** rely on stopping the database: AWS restarts a stopped database after 7 days. A real teardown (below) is the way to stop it.

## The teardown, by hand

Do this after the project is graded and before you stop needing the data. **Each step deletes things for good.** Claude Code will list what a step deletes and wait for your yes before running it.

1. **Keep what you need first.** Take screenshots or exports for your report. Nothing in the app is kept anywhere else.
2. **Empty and delete the recordings** (the S3 bucket must be empty before it can be removed). Recordings are not deleted automatically (see "Audio retention" in the README).
3. **Delete the deploy-only user's access key first** (see step 8; a user with a key cannot be deleted by the stack), then **destroy the stack** (`cdk destroy`). This removes the app server, load balancer, database, login, bucket and logs. Check first that it does not leave behind the database snapshot or the bucket.
4. **Delete the secrets** in AWS Secrets Manager (`counselor-insights/...`). AWS may keep a deleted secret for a recovery period unless you force-delete it.
5. **Remove the two Cloudflare DNS records** for `studentcounseling` (the certificate validation record and the app address). Leave every other record, especially `tracker`, alone.
6. **AssemblyAI:** delete the API key, and any transcripts still stored there. Close the account if you do not need it.
7. **AWS Budgets and the account:** delete the budget when you no longer need it, and close the AWS account if it was made only for this.
8. **GitHub:** first delete the deploy key: `aws iam list-access-keys --user-name counselor-insights-github-deployer`, then `aws iam delete-access-key` for each, and delete the two secrets in the repository's `production` environment. (`cdk destroy` in step 3 removes the AWS user itself, but only after its key is gone.) Then archive or delete the repository. It contains no real data and no keys, and is public by choice.
9. **Your computer:** `docker compose down -v` removes the local database, and deleting the `.local-audio` folder removes local recordings.

## Why the date is built into the code

A reminder note would depend on someone remembering. The app instead refuses to run after the date, and the cloud setup will scale itself down, so the project cannot quietly stay open (and keep costing money) after it is no longer needed. The real teardown is still a person's decision.
