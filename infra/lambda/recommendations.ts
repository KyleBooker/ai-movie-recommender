import type { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';

const TABLE_NAME = process.env.TABLE_NAME!;
const REQUESTS_TABLE_NAME = process.env.REQUESTS_TABLE_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const USER_ID = 'kyle';
const NUM_RECOMMENDATIONS = 3;

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

const buildPrompt = (
  watched: WatchedMovie[],
  exclude: string[] = [],
): string => {
  const compact = watched.map((m) => ({
    title: m.title,
    year: m.year,
    playCount: m.playCount,
    completed: m.completed,
  }));

  const watchedTitles = watched.map((m) => `${m.title} (${m.year})`);

  const lines = [
    'You recommend movies for a user. Use their watch history as a taste signal:',
    'playCount indicates favorites/rewatches; completed=false suggests they bailed.',
    '',
    'CRITICAL RULES:',
    '1. NEVER recommend any movie that appears in the EXCLUSION LIST below. The',
    '   user has already seen those.',
    `2. Recommend exactly ${NUM_RECOMMENDATIONS} DISTINCT movies that are NOT in the exclusion list.`,
    '3. No duplicates — each recommendation must be a different film.',
    '4. Vary genres and eras. Reasons should reference specific watched titles',
    '   when possible.',
    '',
    'EXCLUSION LIST — these are already watched, do NOT recommend any of them:',
    watchedTitles.join('; '),
  ];

  if (exclude.length) {
    lines.push(
      '',
      'ALSO do NOT recommend (already considered in a prior attempt):',
      exclude.join('; '),
    );
  }

  lines.push(
    '',
    'Taste signals (rich data for inferring preferences):',
    JSON.stringify(compact),
  );
  return lines.join('\n');
};

const callBedrock = async (prompt: string): Promise<Recommendation[]> => {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 2048, temperature: 0.9, topP: 0.95 },
      toolConfig: {
        tools: [{ toolSpec: OUTPUT_TOOL }],
        toolChoice: { tool: { name: OUTPUT_TOOL.name } },
      },
    }),
  );
  return extractRecommendations(
    response.output?.message?.content as
      | Array<{ toolUse?: { input?: unknown }; text?: string }>
      | undefined,
  );
};

const applyFilter = (
  raw: Recommendation[],
  seen: Set<string>,
): Recommendation[] =>
  raw.filter((r) => {
    const key = normalizeKey(r.title, r.year);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

const getRecentRecommendedTitles = async (
  userId: string,
  recentRuns = 10,
): Promise<string[]> => {
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: REQUESTS_TABLE_NAME,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ScanIndexForward: false,
        Limit: recentRuns,
      }),
    );
    const titles = new Set<string>();
    for (const item of res.Items ?? []) {
      const recs = (item as { recommendations?: Recommendation[] }).recommendations ?? [];
      for (const r of recs) titles.add(`${r.title} (${r.year})`);
    }
    return Array.from(titles);
  } catch (err) {
    console.warn('Could not load recent recommended titles:', err);
    return [];
  }
};

const extractRecommendations = (
  content: Array<{ toolUse?: { input?: unknown }; text?: string }> | undefined,
): Recommendation[] => {
  const toolUse = content?.find((c) => c.toolUse)?.toolUse;
  const input = toolUse?.input as { recommendations?: Recommendation[] } | undefined;
  if (input?.recommendations?.length) return input.recommendations;

  // Fallback: parse text content if the model returned text instead of using the tool.
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
): Promise<EnrichedRecommendation> => {
  if (!TMDB_API_KEY) return rec;
  try {
    const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(
      rec.title,
    )}&year=${rec.year}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TMDB_API_KEY}`,
        Accept: 'application/json',
      },
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
    console.error(`TMDB lookup failed for "${rec.title}" (${rec.year}):`, err);
    return rec;
  }
};

export const handler: APIGatewayProxyHandler = async (event) => {
  // API Gateway's Cognito authorizer puts validated JWT claims here.
  // For this demo we still look up the seeded 'kyle' record regardless of who
  // authenticated — in production the partition key would be claims.sub.
  const claims = (event.requestContext as unknown as {
    authorizer?: { claims?: Record<string, string> };
  }).authorizer?.claims;

  const watchHistoryRecord = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: USER_ID },
    }),
  );

  if (!watchHistoryRecord.Item) {
    return {
      statusCode: 404,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      },
      body: JSON.stringify({ error: 'No watch history found', userId: USER_ID }),
    };
  }

  const watched = (watchHistoryRecord.Item.watchHistory ?? []) as WatchedMovie[];
  const watchedKeys = new Set(watched.map((m) => normalizeKey(m.title, m.year)));

  const requestUserId = claims?.sub ?? USER_ID;
  const recentTitles = await getRecentRecommendedTitles(requestUserId, 10);

  const seen = new Set(watchedKeys);
  let attempts = 1;
  const raw = await callBedrock(buildPrompt(watched, recentTitles));
  let filtered = applyFilter(raw, seen);

  // If the first attempt produced nothing usable (everything was already
  // watched or de-duped), retry once with an explicit exclusion list so the
  // model can't repeat the same picks.
  if (filtered.length === 0 && raw.length > 0) {
    attempts = 2;
    const exclude = [...recentTitles, ...raw.map((r) => `${r.title} (${r.year})`)];
    const retryRaw = await callBedrock(buildPrompt(watched, exclude));
    filtered = applyFilter(retryRaw, seen);
  }

  const enriched = await Promise.all(filtered.map(enrichWithTmdb));

  const runAt = Math.floor(Date.now() / 1000);
  const requestId = `${runAt}-${randomUUID().slice(0, 8)}`;

  await ddb.send(
    new PutCommand({
      TableName: REQUESTS_TABLE_NAME,
      Item: {
        userId: requestUserId,
        requestId,
        jobName: 'Manual run',
        runAt,
        status: 'success',
        recommendations: enriched,
        modelId: MODEL_ID,
        basedOnMovieCount: watched.length,
      },
    }),
  );

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify({
      recommendations: enriched,
      meta: {
        userId: USER_ID,
        authenticatedAs: claims?.email ?? null,
        cognitoSub: claims?.sub ?? null,
        basedOnMovieCount: watched.length,
        modelId: MODEL_ID,
        filteredOutCount: raw.length - filtered.length,
        attempts,
        requestId,
      },
    }),
  };
};
