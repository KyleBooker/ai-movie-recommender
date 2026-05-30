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
- TMDB v4 API Read Access Token

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
# In infra/
set TMDB_API_KEY=eyJ...your-v4-bearer-token   # cmd.exe
$env:TMDB_API_KEY = "eyJ..."                  # PowerShell
export TMDB_API_KEY=eyJ...                    # bash

cdk deploy
```

First deploy takes ~10 minutes (CloudFront distribution creation). Subsequent
deploys are ~30s–2min depending on what changed.

After deploy, copy the `TableName` and `FrontendUrl` from CloudFormation
outputs.

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

### Tear down

```bash
cd infra
cdk destroy
```

Wipes all stack resources (~5 min). Local seed file and CDK bootstrap stack
remain.

## Design decisions

These are the answers I'd give if asked "why this choice" in an interview.

### Why CDK over Terraform or raw CloudFormation?

- **AWS-native** — no third-party state file to manage, no provider plugin
  lag behind new AWS features
- **Higher-level than CFN** — `grantReadData()` produces a least-privilege
  IAM policy in one line; the equivalent CloudFormation YAML is ~15 lines
- **TypeScript everywhere** — Lambdas and infrastructure share the same
  language and tooling
- **Trade-off** — locks the project to AWS. For a multi-cloud shop, Terraform
  is the better choice

### Why Nova Micro on Bedrock instead of Claude or OpenAI?

- **Cheapest serious model on Bedrock** — $0.035/$0.14 per million input/output
  tokens. ~8× cheaper than Claude Haiku 3.
- **First-party AWS model** — keeps everything (IAM, billing, observability)
  in one account
- **Tool-use support** — the recommendation pipeline uses Bedrock's structured
  output (tool-use with required tool choice) to guarantee valid JSON
- **Trade-off** — Nova Micro is not as strong as frontier models. For
  recommendations the output is structured JSON, not creative writing, so
  the quality gap doesn't show

### Why DynamoDB on-demand instead of provisioned?

- **Zero idle cost** — most of the time there's no traffic
- **Auto-scales burst writes** during scheduled job batches
- **Trade-off** — higher per-request price than provisioned. Fine for a
  bursty, unpredictable workload; not for a steady ~1000 RPS production
  service

### Why one mega API Lambda (`ApiFn`) instead of one Lambda per endpoint?

- **Faster deploys** — single function to redeploy on API changes
- **Cheaper cold starts** — once warm, all endpoints share the container
- **Simpler IAM** — one role to maintain
- **Trade-off** — the function fans-out to more routes. At ~10 endpoints it's
  manageable; at 50+ a function-per-endpoint or splitting by domain would be
  cleaner

### Why EventBridge Scheduler instead of a polling Lambda?

- **Scales to thousands of schedules** without scanning DynamoDB every minute
- **Sub-minute precision** instead of the polling interval
- **Built-in retry + DLQ support** if needed
- **Trade-off** — per-user schedule creation requires the API Lambda to have
  scheduler:* permissions + iam:PassRole. A polling approach is simpler IAM
  but doesn't scale beyond hobby use

### Why Bedrock tool-use instead of "respond with JSON" in the prompt?

- **Guaranteed valid JSON** — the model can't emit malformed output because
  it's constrained to a typed schema at the API level
- **No defensive parser** — initially I had a regex stripping trailing
  commas, then I hit a missing-colon error. Tool-use eliminates the entire
  class of failures
- **Trade-off** — slightly more setup. Not all models support tool-use; Nova
  does

### Why Cognito implicit grant over authorization code with PKCE?

- **Pure-vanilla-JS SPA** — implicit grant returns tokens directly in the
  URL fragment, no exchange step
- **Trade-off** — implicit grant is deprecated in OAuth 2.1 for security
  reasons (tokens in URL hash can leak via referer headers, browser
  history). Production would migrate to authorization code + PKCE. Acceptable
  for a portfolio demo running on a single-user CloudFront

### Why CloudFront + S3 with OAC instead of S3 static website hosting?

- **HTTPS** — S3 static website endpoints are HTTP-only; mixed content
  blocks browser fetch to the HTTPS API
- **Single point of distribution** — easier custom domain + WAF later
- **Trade-off** — CloudFront distribution creation is ~10 minutes the first
  time

## Reliability patterns

- **Tool-use for LLM JSON** — guarantees schema-conformant output
- **Intra-batch dedup** — collapse repeated recommendations within one run
- **Retry on empty filter** — if every pick was already-watched, retry once
  with explicit exclusion list
- **Cross-run variety** — exclude last 10 runs' recommendations to push the
  model toward novel picks
- **Temperature + topP tuning** — 0.9 / 0.95 for variety without gibberish
- **Optimistic UI** — job enable/disable updates locally before backend
  responds; reverts on error

## Cost analysis (rough)

Everything inside AWS's always-free tier except Bedrock:

- **Lambda**: 1M requests/month free forever — this project uses < 1K
- **DynamoDB on-demand**: 25 GB free; per-request pricing is negligible at
  this volume
- **CloudFront**: 1 TB free for 12 months
- **Cognito**: 50K MAUs free forever
- **Bedrock Nova Micro**: ~$0.0003 per recommendation. 1000 runs ≈ $0.30

Total runtime cost for active development + interview demo: **under $5**.

## What I'd build next

- **Plex PIN auth** so multiple users can link their own Plex accounts
  instead of sharing the seeded data
- **Live Tautulli sync** via scheduled Lambda so the recommendation pipeline
  uses fresh watch history without a re-seed
- **Tighten Cognito flow** to authorization code + PKCE
- **CloudWatch alarms** on Lambda errors + Bedrock spend
- **Migrate API Lambda** to one-Lambda-per-domain if the surface grows past
  ~15 endpoints
- **Per-user partition** for watch history (currently a single seeded `kyle`
  user serves all authenticated requests)

## License

MIT
