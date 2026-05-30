import type { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const TABLE_NAME = process.env.TABLE_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const USER_ID = 'kyle';
const NUM_RECOMMENDATIONS = 3;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
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

const buildPrompt = (watched: WatchedMovie[]): string => {
  const compact = watched.map((m) => ({
    title: m.title,
    year: m.year,
    playCount: m.playCount,
    completed: m.completed,
  }));

  return [
    'You are a movie recommender. Below is a JSON list of movies a user has watched.',
    'Each entry has the title, release year, how many times they watched it (playCount),',
    'and whether they finished it (completed). Rewatches and completion are strong',
    'preference signals; abandoned movies are weak negative signals.',
    '',
    `Recommend exactly ${NUM_RECOMMENDATIONS} movies the user would likely enjoy but has not watched based on their previous watch history.`,
    'Vary the genres and eras. For each recommendation, write a one-sentence reason',
    'that references specific watched titles when possible.',
    '',
    'Respond with ONLY a JSON array, no preamble or markdown. Schema:',
    '[{"title": string, "year": number, "reason": string}, ...]',
    '',
    'Watched movies:',
    JSON.stringify(compact),
  ].join('\n');
};

const parseRecommendations = (text: string): Recommendation[] => {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`Model response had no JSON array: ${text.slice(0, 200)}`);
  }
  // Strip trailing commas before closing brackets — LLMs sometimes emit them,
  // which JSON.parse rejects.
  const cleaned = text.slice(start, end + 1).replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(cleaned);
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

  const bedrockResponse = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: 'user', content: [{ text: buildPrompt(watched) }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
    }),
  );

  const rawText = bedrockResponse.output?.message?.content?.[0]?.text ?? '';
  const raw = parseRecommendations(rawText);

  const filtered = raw.filter(
    (r) => !watchedKeys.has(normalizeKey(r.title, r.year)),
  );

  const enriched = await Promise.all(filtered.map(enrichWithTmdb));

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
      },
    }),
  };
};
