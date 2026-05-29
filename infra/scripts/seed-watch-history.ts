import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const USER_ID = 'kyle';
const SOURCE_USER = 'DoctorNumbers';

const TABLE_NAME = process.env.TABLE_NAME;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

if (!TABLE_NAME) {
  console.error('TABLE_NAME env var required. Get it from `cdk deploy` outputs.');
  process.exit(1);
}

type TautulliRow = {
  rating_key: number;
  title: string;
  year: number;
  date: number;
  play_duration: number;
  percent_complete: number;
};

type Movie = {
  ratingKey: number;
  title: string;
  year: number;
  lastWatchedAt: number;
  playCount: number;
  maxCompletion: number;
  totalPlayDurationSec: number;
  completed: boolean;
};

const snapshotPath = join(__dirname, '..', 'data', 'watch-history.json');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
const rows: TautulliRow[] = snapshot.response.data.data;

const byMovie = new Map<number, Omit<Movie, 'completed'>>();
for (const row of rows) {
  const existing = byMovie.get(row.rating_key);
  if (!existing) {
    byMovie.set(row.rating_key, {
      ratingKey: row.rating_key,
      title: row.title,
      year: row.year,
      lastWatchedAt: row.date,
      playCount: 1,
      maxCompletion: row.percent_complete,
      totalPlayDurationSec: row.play_duration,
    });
  } else {
    existing.lastWatchedAt = Math.max(existing.lastWatchedAt, row.date);
    existing.playCount += 1;
    existing.maxCompletion = Math.max(existing.maxCompletion, row.percent_complete);
    existing.totalPlayDurationSec += row.play_duration;
  }
}

const watchHistory: Movie[] = Array.from(byMovie.values())
  .map((m) => ({ ...m, completed: m.maxCompletion >= 90 }))
  .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

(async () => {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId: USER_ID,
        sourceUser: SOURCE_USER,
        snapshotTakenAt: Math.floor(Date.now() / 1000),
        movieCount: watchHistory.length,
        watchHistory,
      },
    }),
  );
  console.log(
    `Seeded ${watchHistory.length} unique movies (from ${rows.length} watch events) for user ${USER_ID} into ${TABLE_NAME}.`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
