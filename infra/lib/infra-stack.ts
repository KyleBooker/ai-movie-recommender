import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import {
  aws_apigateway as apigateway,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
} from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
    });

    api.root
      .addResource('recommendations')
      .addMethod('GET', new apigateway.LambdaIntegration(recommendationsFn));

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'Base URL of the Movie Recommender API',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: watchHistory.tableName,
      description: 'DynamoDB table name (pass as TABLE_NAME env var to seed script)',
    });
  }
}
