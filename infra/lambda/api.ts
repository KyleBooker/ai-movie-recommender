import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME!;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

type Claims = Record<string, string> | undefined;

const getClaims = (event: Parameters<APIGatewayProxyHandler>[0]): Claims => {
  return (event.requestContext as unknown as {
    authorizer?: { claims?: Record<string, string> };
  }).authorizer?.claims;
};

type UserSettings = {
  userId: string;
  tmdbApiKey?: string;
  omdbApiKey?: string;
  updatedAt: number;
};

const getSettings = async (userId: string): Promise<UserSettings | null> => {
  const result = await ddb.send(
    new GetCommand({
      TableName: SETTINGS_TABLE_NAME,
      Key: { userId },
    }),
  );
  return (result.Item as UserSettings | undefined) ?? null;
};

const putSettings = async (settings: UserSettings): Promise<void> => {
  await ddb.send(
    new PutCommand({
      TableName: SETTINGS_TABLE_NAME,
      Item: settings,
    }),
  );
};

const sanitizeSettingsForClient = (settings: UserSettings | null) => ({
  hasTmdbKey: Boolean(settings?.tmdbApiKey),
  hasOmdbKey: Boolean(settings?.omdbApiKey),
  updatedAt: settings?.updatedAt ?? null,
});

const testTmdb = async (apiKey: string) => {
  const res = await fetch(
    'https://api.themoviedb.org/3/configuration',
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    },
  );
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message:
        res.status === 401
          ? 'Invalid API key. Make sure you are using the v4 "API Read Access Token" (long eyJ... string), not the v3 API Key.'
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

export const handler: APIGatewayProxyHandler = async (event) => {
  const claims = getClaims(event);
  const userSub = claims?.sub;
  if (!userSub) {
    return json(401, { error: 'Unauthorized' });
  }

  const route = `${event.httpMethod} ${event.resource}`;

  try {
    if (route === 'GET /settings') {
      const settings = await getSettings(userSub);
      return json(200, sanitizeSettingsForClient(settings));
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
      return json(200, sanitizeSettingsForClient(next));
    }

    if (route === 'POST /settings/test/tmdb') {
      const body = JSON.parse(event.body ?? '{}') as { apiKey?: string };
      let apiKey = body.apiKey;
      if (!apiKey) {
        const stored = await getSettings(userSub);
        apiKey = stored?.tmdbApiKey;
      }
      if (!apiKey) return json(400, { ok: false, message: 'No TMDB key provided.' });
      const result = await testTmdb(apiKey);
      return json(200, result);
    }

    if (route === 'POST /settings/test/omdb') {
      const body = JSON.parse(event.body ?? '{}') as { apiKey?: string };
      let apiKey = body.apiKey;
      if (!apiKey) {
        const stored = await getSettings(userSub);
        apiKey = stored?.omdbApiKey;
      }
      if (!apiKey) return json(400, { ok: false, message: 'No OMDb key provided.' });
      const result = await testOmdb(apiKey);
      return json(200, result);
    }

    if (route === 'GET /requests') {
      // Placeholder until scheduled jobs land. Returns zero counts so the
      // stats card row renders cleanly.
      return json(200, {
        totalRequests: 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
      });
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
