import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import {
  aws_apigateway as apigateway,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tmdbApiKey = process.env.TMDB_API_KEY;
    if (!tmdbApiKey) {
      throw new Error(
        'TMDB_API_KEY env var is required. Set it in your shell before cdk synth/deploy.',
      );
    }

    const watchHistory = new dynamodb.Table(this, 'WatchHistory', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const modelId = 'amazon.nova-micro-v1:0';

    const recommendationsFn = new NodejsFunction(this, 'RecommendationsFn', {
      entry: path.join(__dirname, '..', 'lambda', 'recommendations.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: watchHistory.tableName,
        MODEL_ID: modelId,
        TMDB_API_KEY: tmdbApiKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    watchHistory.grantReadData(recommendationsFn);

    recommendationsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/${modelId}`],
      }),
    );

    const api = new apigateway.RestApi(this, 'RecommenderApi', {
      restApiName: 'Movie Recommender API',
      deployOptions: { stageName: 'prod' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'OPTIONS'],
      },
    });

    api.root
      .addResource('recommendations')
      .addMethod('GET', new apigateway.LambdaIntegration(recommendationsFn));

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'frontend')),
        s3deploy.Source.jsonData('config.json', { apiUrl: api.url }),
      ],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'Base URL of the Movie Recommender API',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: watchHistory.tableName,
      description: 'DynamoDB table name (pass as TABLE_NAME env var to seed script)',
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the frontend (open this in a browser)',
    });
  }
}
