import type { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME!;
const USER_ID = 'kyle';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler: APIGatewayProxyHandler = async () => {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { userId: USER_ID },
    }),
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'No watch history found', userId: USER_ID }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: result.Item.userId,
      movieCount: result.Item.movieCount,
      snapshotTakenAt: result.Item.snapshotTakenAt,
      watchHistory: result.Item.watchHistory,
    }),
  };
};
