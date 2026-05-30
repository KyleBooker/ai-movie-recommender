import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
  FlexibleTimeWindowMode,
  ScheduleState,
} from '@aws-sdk/client-scheduler';
import {
  InvokeCommand,
  InvocationType,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import { randomUUID } from 'node:crypto';

const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME!;
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME!;
const REQUESTS_TABLE_NAME = process.env.REQUESTS_TABLE_NAME!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;
const SCHEDULED_FN_ARN = process.env.SCHEDULED_FN_ARN!;
const SCHEDULE_GROUP_NAME = process.env.SCHEDULE_GROUP_NAME || 'default';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const scheduler = new SchedulerClient({});
const lambdaClient = new LambdaClient({});

const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

const getClaims = (event: Parameters<APIGatewayProxyHandler>[0]) =>
  (event.requestContext as unknown as {
    authorizer?: { claims?: Record<string, string> };
  }).authorizer?.claims;

// ----- Settings -----
type UserSettings = {
  userId: string;
  tmdbApiKey?: string;
  omdbApiKey?: string;
  updatedAt: number;
};

const getSettings = async (userId: string): Promise<UserSettings | null> => {
  const result = await ddb.send(
    new GetCommand({ TableName: SETTINGS_TABLE_NAME, Key: { userId } }),
  );
  return (result.Item as UserSettings | undefined) ?? null;
};

const putSettings = (settings: UserSettings) =>
  ddb.send(new PutCommand({ TableName: SETTINGS_TABLE_NAME, Item: settings }));

const sanitizeSettings = (s: UserSettings | null) => ({
  hasTmdbKey: Boolean(s?.tmdbApiKey),
  hasOmdbKey: Boolean(s?.omdbApiKey),
  updatedAt: s?.updatedAt ?? null,
});

const testTmdb = async (apiKey: string) => {
  const res = await fetch('https://api.themoviedb.org/3/configuration', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message:
        res.status === 401
          ? 'Invalid API key. Use the v4 "API Read Access Token" (long eyJ... string), not the v3 key.'
          : `TMDB returned ${res.status}`,
    };
  }
  return { ok: true, status: 200, message: 'Connected to TMDB.' };
};

const testOmdb = async (apiKey: string) => {
  const res = await fetch(
    `https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&t=Inception`,
  );
  if (!res.ok) {
    return { ok: false, status: res.status, message: `OMDb returned ${res.status}` };
  }
  const data = (await res.json()) as { Response?: string; Error?: string };
  if (data.Response === 'False') {
    return { ok: false, status: 401, message: data.Error ?? 'OMDb rejected the key.' };
  }
  return { ok: true, status: 200, message: 'Connected to OMDb.' };
};

// ----- Jobs -----
type Job = {
  userId: string;
  jobId: string;
  name: string;
  type: 'RECOMMENDATION' | 'DISCOVER';
  scheduleExpression: string;
  scheduleLabel: string;
  maxResults: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
};

const scheduleNameFor = (userId: string, jobId: string) =>
  `job-${userId.slice(0, 8)}-${jobId}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64);

const createScheduleForJob = async (job: Job) => {
  const name = scheduleNameFor(job.userId, job.jobId);
  await scheduler.send(
    new CreateScheduleCommand({
      Name: name,
      GroupName: SCHEDULE_GROUP_NAME,
      ScheduleExpression: job.scheduleExpression,
      State: job.enabled ? ScheduleState.ENABLED : ScheduleState.DISABLED,
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      Target: {
        Arn: SCHEDULED_FN_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({ userId: job.userId, jobId: job.jobId }),
      },
    }),
  );
};

const updateScheduleForJob = async (job: Job) => {
  const name = scheduleNameFor(job.userId, job.jobId);
  await scheduler.send(
    new UpdateScheduleCommand({
      Name: name,
      GroupName: SCHEDULE_GROUP_NAME,
      ScheduleExpression: job.scheduleExpression,
      State: job.enabled ? ScheduleState.ENABLED : ScheduleState.DISABLED,
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      Target: {
        Arn: SCHEDULED_FN_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({ userId: job.userId, jobId: job.jobId }),
      },
    }),
  );
};

const deleteScheduleForJob = async (userId: string, jobId: string) => {
  const name = scheduleNameFor(userId, jobId);
  try {
    await scheduler.send(
      new DeleteScheduleCommand({ Name: name, GroupName: SCHEDULE_GROUP_NAME }),
    );
  } catch (err) {
    console.warn('Schedule delete failed (may already be gone):', err);
  }
};

const getScheduleNextRun = async (
  userId: string,
  jobId: string,
): Promise<string | null> => {
  const name = scheduleNameFor(userId, jobId);
  try {
    const res = await scheduler.send(
      new GetScheduleCommand({ Name: name, GroupName: SCHEDULE_GROUP_NAME }),
    );
    // EventBridge Scheduler doesn't expose "next run" directly; we return state
    // and let the client compute next-run from the cron/rate expression.
    return res.State ?? null;
  } catch {
    return null;
  }
};

const listJobs = async (userId: string): Promise<Job[]> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName: JOBS_TABLE_NAME,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
    }),
  );
  return (res.Items ?? []) as Job[];
};

const getJob = async (userId: string, jobId: string): Promise<Job | null> => {
  const res = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { userId, jobId } }),
  );
  return (res.Item as Job | undefined) ?? null;
};

const putJob = (job: Job) =>
  ddb.send(new PutCommand({ TableName: JOBS_TABLE_NAME, Item: job }));

const deleteJob = (userId: string, jobId: string) =>
  ddb.send(new DeleteCommand({ TableName: JOBS_TABLE_NAME, Key: { userId, jobId } }));

// ----- Requests / stats -----
const listRequests = async (userId: string) => {
  const res = await ddb.send(
    new QueryCommand({
      TableName: REQUESTS_TABLE_NAME,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false,
    }),
  );
  const items = (res.Items ?? []) as Array<{
    requestId: string;
    runAt: number;
    status: string;
  }>;
  // Sort newest-first by runAt in code as a safety net — the sort key may
  // include legacy non-timestamped requestIds from earlier deploys.
  return items.sort((a, b) => (b.runAt ?? 0) - (a.runAt ?? 0));
};

const computeStats = (requests: Array<{ runAt: number }>) => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const startOfWeek = startOfDay - now.getDay() * 86400;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;

  let today = 0;
  let thisWeek = 0;
  let thisMonth = 0;
  for (const r of requests) {
    if (r.runAt >= startOfDay) today++;
    if (r.runAt >= startOfWeek) thisWeek++;
    if (r.runAt >= startOfMonth) thisMonth++;
  }
  return { totalRequests: requests.length, today, thisWeek, thisMonth };
};

// ----- Handler -----
export const handler: APIGatewayProxyHandler = async (event) => {
  const claims = getClaims(event);
  const userSub = claims?.sub;
  if (!userSub) return json(401, { error: 'Unauthorized' });

  const method = event.httpMethod;
  const resource = event.resource;
  const route = `${method} ${resource}`;
  const jobIdParam = event.pathParameters?.jobId;

  try {
    if (route === 'GET /settings') {
      return json(200, sanitizeSettings(await getSettings(userSub)));
    }

    if (route === 'PUT /settings') {
      const body = JSON.parse(event.body ?? '{}') as {
        tmdbApiKey?: string;
        omdbApiKey?: string;
      };
      const existing = await getSettings(userSub);
      const next: UserSettings = {
        userId: userSub,
        tmdbApiKey:
          body.tmdbApiKey !== undefined ? body.tmdbApiKey : existing?.tmdbApiKey,
        omdbApiKey:
          body.omdbApiKey !== undefined ? body.omdbApiKey : existing?.omdbApiKey,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await putSettings(next);
      return json(200, sanitizeSettings(next));
    }

    if (route === 'POST /settings/test/tmdb') {
      const body = JSON.parse(event.body ?? '{}') as { apiKey?: string };
      let apiKey = body.apiKey || (await getSettings(userSub))?.tmdbApiKey;
      if (!apiKey) return json(400, { ok: false, message: 'No TMDB key provided.' });
      return json(200, await testTmdb(apiKey));
    }

    if (route === 'POST /settings/test/omdb') {
      const body = JSON.parse(event.body ?? '{}') as { apiKey?: string };
      let apiKey = body.apiKey || (await getSettings(userSub))?.omdbApiKey;
      if (!apiKey) return json(400, { ok: false, message: 'No OMDb key provided.' });
      return json(200, await testOmdb(apiKey));
    }

    if (route === 'GET /requests') {
      const requests = await listRequests(userSub);
      return json(200, {
        ...computeStats(requests),
        recent: requests.slice(0, 20),
      });
    }

    if (route === 'DELETE /requests/{requestId}' && event.pathParameters?.requestId) {
      await ddb.send(
        new DeleteCommand({
          TableName: REQUESTS_TABLE_NAME,
          Key: { userId: userSub, requestId: event.pathParameters.requestId },
        }),
      );
      return json(200, { ok: true });
    }

    if (route === 'GET /jobs') {
      const jobs = await listJobs(userSub);
      return json(200, { jobs });
    }

    if (route === 'POST /jobs') {
      const body = JSON.parse(event.body ?? '{}') as Partial<Job>;
      if (!body.name || !body.scheduleExpression || !body.maxResults) {
        return json(400, { error: 'name, scheduleExpression, maxResults required' });
      }
      const now = Math.floor(Date.now() / 1000);
      const job: Job = {
        userId: userSub,
        jobId: randomUUID().slice(0, 8),
        name: body.name,
        type: body.type === 'DISCOVER' ? 'DISCOVER' : 'RECOMMENDATION',
        scheduleExpression: body.scheduleExpression,
        scheduleLabel: body.scheduleLabel ?? body.scheduleExpression,
        maxResults: Math.max(1, Math.min(50, body.maxResults ?? 5)),
        enabled: body.enabled !== false,
        createdAt: now,
        updatedAt: now,
      };
      await putJob(job);
      await createScheduleForJob(job);
      return json(201, { job });
    }

    if (route === 'PUT /jobs/{jobId}' && jobIdParam) {
      const existing = await getJob(userSub, jobIdParam);
      if (!existing) return json(404, { error: 'Job not found' });
      const body = JSON.parse(event.body ?? '{}') as Partial<Job>;
      const updated: Job = {
        ...existing,
        ...('name' in body ? { name: body.name! } : {}),
        ...('scheduleExpression' in body
          ? { scheduleExpression: body.scheduleExpression! }
          : {}),
        ...('scheduleLabel' in body ? { scheduleLabel: body.scheduleLabel! } : {}),
        ...('maxResults' in body ? { maxResults: body.maxResults! } : {}),
        ...('enabled' in body ? { enabled: body.enabled! } : {}),
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await putJob(updated);
      await updateScheduleForJob(updated);
      return json(200, { job: updated });
    }

    if (route === 'DELETE /jobs/{jobId}' && jobIdParam) {
      await deleteScheduleForJob(userSub, jobIdParam);
      await deleteJob(userSub, jobIdParam);
      return json(200, { ok: true });
    }

    if (route === 'POST /jobs/{jobId}/run' && jobIdParam) {
      const job = await getJob(userSub, jobIdParam);
      if (!job) return json(404, { error: 'Job not found' });
      // Fire-and-forget the scheduled run Lambda; user gets quick response.
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: SCHEDULED_FN_ARN,
          InvocationType: InvocationType.Event,
          Payload: Buffer.from(
            JSON.stringify({ userId: userSub, jobId: jobIdParam }),
          ),
        }),
      );
      return json(202, { ok: true, message: 'Run started' });
    }

    return json(404, { error: `Route not found: ${route}` });
  } catch (err) {
    console.error('API handler error:', err);
    return json(500, {
      error: 'Internal server error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
