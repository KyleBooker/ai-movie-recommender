import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import {
  aws_apigateway as apigateway,
  aws_dynamodb as dynamodb,
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

    const recommendationsFn = new NodejsFunction(this, 'RecommendationsFn', {
      entry: path.join(__dirname, '..', 'lambda', 'recommendations.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        TABLE_NAME: watchHistory.tableName,
      },
    });

    watchHistory.grantReadData(recommendationsFn);

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
  }
}
