import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import {
  aws_apigateway as apigateway,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_scheduler as scheduler,
} from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

const COGNITO_DOMAIN_PREFIX = 'ai-movie-recs-kbooker';
const SCHEDULE_GROUP_NAME = 'movie-recs-jobs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // TMDB API keys are now stored per-user via the Settings tab (UserSettings
    // table). No build-time secret is required.

    // ----- Data -----
    const watchHistory = new dynamodb.Table(this, 'WatchHistory', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userSettings = new dynamodb.Table(this, 'UserSettings', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const jobs = new dynamodb.Table(this, 'Jobs', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const requests = new dynamodb.Table(this, 'Requests', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const modelId = 'amazon.nova-micro-v1:0';

    // ----- On-demand recommendations Lambda (existing) -----
    const recommendationsFn = new NodejsFunction(this, 'RecommendationsFn', {
      entry: path.join(__dirname, '..', 'lambda', 'recommendations.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: watchHistory.tableName,
        REQUESTS_TABLE_NAME: requests.tableName,
        SETTINGS_TABLE_NAME: userSettings.tableName,
        MODEL_ID: modelId,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    watchHistory.grantReadData(recommendationsFn);
    requests.grantReadWriteData(recommendationsFn);
    userSettings.grantReadData(recommendationsFn);
    recommendationsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/${modelId}`],
      }),
    );

    // ----- Scheduled-run Lambda (new) -----
    const scheduledRunFn = new NodejsFunction(this, 'ScheduledRunFn', {
      entry: path.join(__dirname, '..', 'lambda', 'scheduledRun.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        TABLE_NAME: watchHistory.tableName,
        JOBS_TABLE_NAME: jobs.tableName,
        REQUESTS_TABLE_NAME: requests.tableName,
        SETTINGS_TABLE_NAME: userSettings.tableName,
        MODEL_ID: modelId,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    watchHistory.grantReadData(scheduledRunFn);
    jobs.grantReadWriteData(scheduledRunFn);
    requests.grantReadWriteData(scheduledRunFn);
    userSettings.grantReadData(scheduledRunFn);
    scheduledRunFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/${modelId}`],
      }),
    );

    // ----- Scheduler group + role -----
    new scheduler.CfnScheduleGroup(this, 'JobScheduleGroup', {
      name: SCHEDULE_GROUP_NAME,
    });

    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler invoke ScheduledRunFn',
    });
    scheduledRunFn.grantInvoke(schedulerRole);

    // ----- API Lambda -----
    const apiFn = new NodejsFunction(this, 'ApiFn', {
      entry: path.join(__dirname, '..', 'lambda', 'api.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        SETTINGS_TABLE_NAME: userSettings.tableName,
        JOBS_TABLE_NAME: jobs.tableName,
        REQUESTS_TABLE_NAME: requests.tableName,
        WATCH_HISTORY_TABLE_NAME: watchHistory.tableName,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
        SCHEDULED_FN_ARN: scheduledRunFn.functionArn,
        SCHEDULE_GROUP_NAME,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    userSettings.grantReadWriteData(apiFn);
    jobs.grantReadWriteData(apiFn);
    requests.grantReadWriteData(apiFn);
    watchHistory.grantReadWriteData(apiFn);
    scheduledRunFn.grantInvoke(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
          'scheduler:ListSchedules',
        ],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/${SCHEDULE_GROUP_NAME}/*`,
        ],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
      }),
    );

    // ----- Frontend hosting -----
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

    const frontendOrigin = `https://${distribution.distributionDomainName}`;
    const callbackUrl = `${frontendOrigin}/`;

    // ----- Cognito -----
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolDomain = userPool.addDomain('UserPoolDomain', {
      cognitoDomain: { domainPrefix: COGNITO_DOMAIN_PREFIX },
    });

    const userPoolClient = userPool.addClient('UserPoolClient', {
      authFlows: { userSrp: true },
      generateSecret: false,
      oAuth: {
        flows: { implicitCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        // Custom domain is the canonical URL; cloudfront URL kept as a fallback
        // so the app still works while DNS propagates after first deploy.
        callbackUrls: [callbackUrl],
        logoutUrls: [callbackUrl],
      },
      preventUserExistenceErrors: true,
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ApiAuthorizer', {
      cognitoUserPools: [userPool],
    });

    // ----- API Gateway -----
    const api = new apigateway.RestApi(this, 'RecommenderApi', {
      restApiName: 'Movie Recommender API',
      deployOptions: { stageName: 'prod' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const authedMethod = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    api.root
      .addResource('recommendations')
      .addMethod('GET', new apigateway.LambdaIntegration(recommendationsFn), authedMethod);

    const apiIntegration = new apigateway.LambdaIntegration(apiFn);

    const settings = api.root.addResource('settings');
    settings.addMethod('GET', apiIntegration, authedMethod);
    settings.addMethod('PUT', apiIntegration, authedMethod);
    const settingsTest = settings.addResource('test');
    settingsTest.addResource('tmdb').addMethod('POST', apiIntegration, authedMethod);
    settingsTest.addResource('omdb').addMethod('POST', apiIntegration, authedMethod);
    settingsTest.addResource('tautulli').addMethod('POST', apiIntegration, authedMethod);

    const tautulli = api.root.addResource('tautulli');
    tautulli.addResource('users').addMethod('GET', apiIntegration, authedMethod);
    tautulli.addResource('import').addMethod('POST', apiIntegration, authedMethod);

    const requestsResource = api.root.addResource('requests');
    requestsResource.addMethod('GET', apiIntegration, authedMethod);
    requestsResource
      .addResource('{requestId}')
      .addMethod('DELETE', apiIntegration, authedMethod);

    const jobsResource = api.root.addResource('jobs');
    jobsResource.addMethod('GET', apiIntegration, authedMethod);
    jobsResource.addMethod('POST', apiIntegration, authedMethod);
    const oneJob = jobsResource.addResource('{jobId}');
    oneJob.addMethod('PUT', apiIntegration, authedMethod);
    oneJob.addMethod('DELETE', apiIntegration, authedMethod);
    oneJob.addResource('run').addMethod('POST', apiIntegration, authedMethod);

    // ----- Frontend deployment -----
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'frontend')),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: api.url,
          cognito: {
            domain: userPoolDomain.baseUrl(),
            clientId: userPoolClient.userPoolClientId,
            redirectUri: callbackUrl,
          },
        }),
      ],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ----- Outputs -----
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'TableName', { value: watchHistory.tableName });
    new cdk.CfnOutput(this, 'FrontendUrl', { value: frontendOrigin });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoLoginUrl', {
      value: `${userPoolDomain.baseUrl()}/login?client_id=${userPoolClient.userPoolClientId}&response_type=token&scope=openid+email+profile&redirect_uri=${encodeURIComponent(callbackUrl)}`,
    });
  }
}
