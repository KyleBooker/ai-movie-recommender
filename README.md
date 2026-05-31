# AI Movie Recommender

A serverless AI movie recommender on AWS. Cognito-authenticated users hit an
API Gateway → Lambda → Bedrock pipeline that reads their Plex watch history
from DynamoDB, asks Amazon Nova Micro for personalized picks, enriches each
result with poster art from TMDB, and returns it to a CloudFront-hosted SPA.

Infrastructure is defined entirely in TypeScript via AWS CDK. The full stack
tears down and redeploys end-to-end in under 20 minutes including data
seeding.

---

## What it does

- **Personalized recommendations** generated from real Plex watch history (one
  seeded user, ~270 unique movies after dedupe from ~380 watch events)
- **Scheduled jobs** via EventBridge Scheduler — users can configure recurring
  recommendation runs (daily, hourly, custom cron) with per-job max-results
- **Run history** persisted in DynamoDB with stats (total, today, week, month)
- **TMDB integration** for poster art and click-through links
- **Cognito auth** with hosted UI, JWT-protected API endpoints
- **Multi-tab SPA** (Requests / Services / Jobs) hosted from S3 behind
  CloudFront with HTTPS

## Architecture

```
                            ┌──────────────┐
                            │   Cognito    │  Hosted UI, User Pool,
                            │  User Pool   │  JWT issuance
                            └──────┬───────┘
                                   │ ID token (Implicit grant)
                                   ▼
┌─────────────┐           ┌─────────────────┐
│  CloudFront │──────────▶│   S3 Bucket     │  Static SPA assets
│ (HTTPS+CDN) │           │ (frontend/)     │  + injected config.json
└──────┬──────┘           └─────────────────┘
       │
       │ HTTPS + Bearer <id_token>
       ▼
┌─────────────────────────────────────────────────────────────┐
│                       API Gateway (REST)                    │
│   /recommendations   /settings   /jobs   /requests          │
│             │ CognitoUserPoolsAuthorizer (JWT validation)   │
└─────┬───────────────────┬───────────────────┬───────────────┘
      │                   │                   │
      ▼                   ▼                   ▼
┌──────────────┐   ┌─────────────┐   ┌──────────────────┐
│Recommendations│   │   ApiFn     │   │ ScheduledRunFn   │
│      Fn       │   │  (CRUD)     │   │  (job runner)    │
└──────┬───────┘   └──────┬──────┘   └────────┬─────────┘
       │                  │                   │
       │   Bedrock        │  DynamoDB         │  ▲
       │   (Nova Micro    │  Settings/Jobs/   │  │ fires on cron
       │   via Converse,  │  Requests         │  │
       │   tool-use)      │                   │  │
       │                  │                   │  │
       ▼                  ▼                   ▼  │
┌──────────────┐   ┌────────────────────┐   ┌───┴──────────────┐
│   Bedrock    │   │     DynamoDB       │   │ EventBridge      │
│  Nova Micro  │   │  WatchHistory      │   │   Scheduler      │
└──────┬───────┘   │  UserSettings      │   │ (one schedule    │
       │           │  Jobs              │   │  per user job)   │
       │ TMDB enrichment               │   └──────────────────┘
       ▼           │  Requests          │
┌──────────────┐   └────────────────────┘
│  TMDB API    │
│ (posters,IDs)│
└──────────────┘
```

### Service responsibilities

| AWS Service              | What it does in this project                          |
| ------------------------ | ----------------------------------------------------- |
| **Cognito User Pool**    | Email/password auth, hosted login UI, JWT issuance    |
| **API Gateway (REST)**   | HTTPS routing, CORS, Cognito authorizer enforcement   |
| **Lambda (NodejsFunction × 3)** | `RecommendationsFn` (on-demand), `ApiFn` (CRUD), `ScheduledRunFn` (job execution) |
| **DynamoDB (× 4 tables)** | `WatchHistory`, `UserSettings`, `Jobs`, `Requests`   |
| **S3 + CloudFront**      | Static SPA hosting with edge caching + HTTPS via OAC |
| **Bedrock**              | Amazon Nova Micro for recommendation generation       |
| **EventBridge Scheduler** | One schedule per user job, invokes Lambda on cron    |
| **CloudWatch Logs**      | All Lambda invocations + scheduled run history        |

## Tech stack

- **Infrastructure**: AWS CDK (TypeScript)
- **Backend**: Node.js 22 Lambdas in TypeScript, bundled by esbuild via
  `aws-cdk-lib/aws-lambda-nodejs`
- **AI**: Amazon Bedrock — Nova Micro with structured output via tool-use
- **Frontend**: Vanilla HTML/CSS/JS — no build step, no framework
- **Auth**: Cognito User Pool (implicit grant flow for SPA)
- **External**: TMDB API for movie metadata + posters

## Project structure

```
ai-movie-recommender/
├── infra/                    # CDK app (TypeScript)
│   ├── bin/infra.ts          # CDK entrypoint
│   ├── lib/infra-stack.ts    # All AWS resources defined here
│   ├── lambda/
│   │   ├── recommendations.ts  # On-demand /recommendations endpoint
│   │   ├── api.ts              # /settings, /jobs, /requests CRUD
│   │   └── scheduledRun.ts     # EventBridge Scheduler target
│   ├── scripts/
│   │   └── seed-watch-history.ts  # One-time DynamoDB seeder
│   └── data/                 # Local-only Tautulli export (gitignored)
├── frontend/                 # Static SPA
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

## Local development

### Prerequisites

- Node.js 22+
- AWS CLI configured with credentials (`aws configure`)
- AWS account with Bedrock model access for Nova Micro (auto-enabled on first
  invocation in `us-east-1`)
- TMDB v4 API Read Access Token (entered through the in-app Settings tab
  after first deploy — no longer required at build time)

### One-time setup

```bash
# Install CDK CLI globally
npm install -g aws-cdk

# Install project deps
cd infra
npm install

# Bootstrap CDK in your account/region (one-time per account)
cdk bootstrap
```

### Deploy

```bash
cd infra
cdk deploy
```

First deploy takes ~10 minutes (CloudFront distribution creation). Subsequent
deploys are ~30s–2min depending on what changed.

After deploy, copy the `TableName` and `FrontendUrl` from CloudFormation
outputs.

### Configure your TMDB key (in the app, not the shell)

Open `FrontendUrl`, sign up for a Cognito account, go to **Services** tab,
paste your TMDB v4 token, and Save. Recommendations now include poster art
and click-through links. Without a key, recommendations still work — just
without TMDB enrichment.

### Seed watch history

The project expects a Tautulli movie history export at
`infra/data/watch-history.json`. Pull it with:

```bash
curl "https://<your-tautulli>/api/v2?apikey=<key>&cmd=get_history&user_id=<id>&media_type=movie&length=10000" \
  > infra/data/watch-history.json
```

Then seed DynamoDB:

```bash
cd infra
set TABLE_NAME=InfraStack-WatchHistory<hash>
npm run seed
```
