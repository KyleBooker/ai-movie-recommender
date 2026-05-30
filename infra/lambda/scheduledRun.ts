import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';

const TABLE_NAME = process.env.TABLE_NAME!;
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME!;
const REQUESTS_TABLE_NAME = process.env.REQUESTS_TABLE_NAME!;
const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
const FALLBACK_TMDB_KEY = process.env.TMDB_API_KEY;
const WATCH_HISTORY_USER_ID = 'kyle';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const bedrock = new BedrockRuntimeClient({});

type WatchedMovie = {
  title: string;
  year: number;
  playCount: number;
  completed: boolean;
};

type Recommendation = {
  title: string;
  year: number;
  reason: string;
};

type EnrichedRecommendation = Recommendation & {
  tmdbId?: number;
  tmdbUrl?: string;
  posterUrl?: string;
};

type Job = {
  userId: string;
  jobId: string;
  name: string;
  type: 'RECOMMENDATION' | 'DISCOVER';
  scheduleExpression: string;
  maxResults: number;
  enabled: boolean;
};

type ScheduledEvent = {
  userId: string;
  jobId: string;
};

const OUTPUT_TOOL = {
  name: 'output_recommendations',
  description: 'Provide the final list of movie recommendations.',
  inputSchema: {
    json: {
      type: 'object',
      properties: {
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Movie title' },
              year: { type: 'number', description: 'Release year' },
              reason: {
                type: 'string',
                description:
                  'One sentence explaining why this user would like it, referencing watched titles when possible.',
              },
            },
            required: ['title', 'year', 'reason'],
          },
        },
      },
      required: ['recommendations'],
    },
  },
} as const;

const buildPrompt = (watched: WatchedMovie[], n: number): string =>
  [
    "You recommend movies based on a user's watch history.",
    'Each entry has playCount (rewatches are strong positive signals) and completed',
    '(false suggests they bailed — weak negative signal).',
    '',
    `Recommend exactly ${n} movies the user would likely enjoy but has not watched.`,
    'Vary genres and eras. Reasons should reference specific watched titles when possible.',
    '',
    'Watched movies (JSON):',
    JSON.stringify(
      watched.map((m) => ({
        title: m.title,
        year: m.year,
        playCount: m.playCount,
        completed: m.completed,
      })),
    ),
  ].join('\n');

const extractRecommendations = (
  content: Array<{ toolUse?: { input?: unknown }; text?: string }> | undefined,
): Recommendation[] => {
  const toolUse = content?.find((c) => c.toolUse)?.toolUse;
  const input = toolUse?.input as { recommendations?: Recommendation[] } | undefined;
  if (input?.recommendations?.length) return input.recommendations;

  const text = content?.find((c) => c.text)?.text ?? '';
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`Model returned no recommendations: ${text.slice(0, 200)}`);
  }
  const cleaned = text.slice(start, end + 1).replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(cleaned) as Recommendation[];
};

const normalizeKey = (title: string, year: number): string =>
  `${title.toLowerCase().trim()}|${year}`;

const enrichWithTmdb = async (
  rec: Recommendation,
  apiKey: string | undefined,
): Promise<EnrichedRecommendation> => {
  if (!apiKey) return rec;
  try {
    const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(
      rec.title,
    )}&year=${rec.year}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) return rec;
    const json = (await res.json()) as {
      results?: Array<{ id: number; poster_path: string | null }>;
    };
    const first = json.results?.[0];
    if (!first) return rec;
    return {
      ...rec,
      tmdbId: first.id,
      tmdbUrl: `https://www.themoviedb.org/movie/${first.id}`,
      posterUrl: first.poster_path
        ? `https://image.tmdb.org/t/p/w500${first.poster_path}`
        : undefined,
    };
  } catch (err) {
    console.error(`TMDB lookup failed for "${rec.title}":`, err);
    return rec;
  }
};

export const runJob = async (userId: string, jobId: string): Promise<void> => {
  const jobRes = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE_NAME, Key: { userId, jobId } }),
  );
  const job = jobRes.Item as Job | undefined;
  if (!job) throw new Error(`Job not found: ${userId}/${jobId}`);

  const settingsRes = await ddb.send(
    new GetCommand({
      TableName: SETTINGS_TABLE_NAME,
      Key: { userId },
    }),
  );
  const userTmdbKey = (settingsRes.Item as { tmdbApiKey?: string } | undefined)
    ?.tmdbApiKey;
  const effectiveTmdbKey = userTmdbKey || FALLBACK_TMDB_KEY;

  const historyRes = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: WATCH_HISTORY_USER_ID },
    }),
  );
  const watched = (historyRes.Item?.watchHistory ?? []) as WatchedMovie[];
  const watchedKeys = new Set(watched.map((m) => normalizeKey(m.title, m.year)));

  const runAt = Math.floor(Date.now() / 1000);
  const requestId = `${runAt}-${randomUUID().slice(0, 8)}`;

  try {
    const bedrockResponse = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        messages: [
          { role: 'user', content: [{ text: buildPrompt(watched, job.maxResults) }] },
        ],
        inferenceConfig: { maxTokens: 2048, temperature: 0.7 },
        toolConfig: {
          tools: [{ toolSpec: OUTPUT_TOOL }],
          toolChoice: { tool: { name: OUTPUT_TOOL.name } },
        },
      }),
    );

    const raw = extractRecommendations(
      bedrockResponse.output?.message?.content as
        | Array<{ toolUse?: { input?: unknown }; text?: string }>
        | undefined,
    );
    const filtered = raw.filter(
      (r) => !watchedKeys.has(normalizeKey(r.title, r.year)),
    );
    const enriched = await Promise.all(
      filtered.map((rec) => enrichWithTmdb(rec, effectiveTmdbKey)),
    );

    await ddb.send(
      new PutCommand({
        TableName: REQUESTS_TABLE_NAME,
        Item: {
          userId,
          requestId,
          jobId,
          jobName: job.name,
          runAt,
          status: 'success',
          recommendations: enriched,
          modelId: MODEL_ID,
        },
      }),
    );

    await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE_NAME,
        Key: { userId, jobId },
        UpdateExpression: 'SET lastRunAt = :t',
        ExpressionAttributeValues: { ':t': runAt },
      }),
    );
  } catch (err) {
    console.error('Job run failed:', err);
    await ddb.send(
      new PutCommand({
        TableName: REQUESTS_TABLE_NAME,
        Item: {
          userId,
          requestId,
          jobId,
          jobName: job.name,
          runAt,
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      }),
    );
    throw err;
  }
};

export const handler = async (event: ScheduledEvent): Promise<void> => {
  if (!event.userId || !event.jobId) {
    throw new Error('ScheduledRun requires { userId, jobId } payload');
  }
  await runJob(event.userId, event.jobId);
};
