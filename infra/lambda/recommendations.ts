import type { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const TABLE_NAME = process.env.TABLE_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
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
  return JSON.parse(text.slice(start, end + 1));
};

const normalizeKey = (title: string, year: number): string =>
  `${title.toLowerCase().trim()}|${year}`;

export const handler: APIGatewayProxyHandler = async () => {
  const watchHistoryRecord = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: USER_ID },
    }),
  );

  if (!watchHistoryRecord.Item) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'No watch history found', userId: USER_ID }),
    };
  }

  const watched = (watchHistoryRecord.Item.watchHistory ?? []) as WatchedMovie[];
  const watchedKeys = new Set(watched.map((m) => normalizeKey(m.title, m.year)));

  const bedrockResponse = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [
        { role: 'user', content: [{ text: buildPrompt(watched) }] },
      ],
      inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
    }),
  );

  const rawText = bedrockResponse.output?.message?.content?.[0]?.text ?? '';
  const raw = parseRecommendations(rawText);

  const recommendations = raw.filter(
    (r) => !watchedKeys.has(normalizeKey(r.title, r.year)),
  );

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recommendations,
      meta: {
        userId: USER_ID,
        basedOnMovieCount: watched.length,
        modelId: MODEL_ID,
        filteredOutCount: raw.length - recommendations.length,
      },
    }),
  };
};
