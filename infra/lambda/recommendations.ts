import type { APIGatewayProxyHandler } from 'aws-lambda';

export const handler: APIGatewayProxyHandler = async () => {
  const recommendations = [
    { title: 'Blade Runner 2049', year: 2017, reason: 'Visually stunning sci-fi follow-up' },
    { title: 'The Lighthouse', year: 2019, reason: 'Atmospheric psychological drama' },
    { title: 'Princess Mononoke', year: 1997, reason: 'Studio Ghibli environmental epic' },
  ];

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recommendations }),
  };
};
