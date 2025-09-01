import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export class MidasDashStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Buckets for file storage
    const problemsBucket = new s3.Bucket(this, 'ProblemsBucket', {
      bucketName: `midasdash-problems-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        maxAge: 3000
      }]
    });

    const solutionsBucket = new s3.Bucket(this, 'SolutionsBucket', {
      bucketName: `midasdash-solutions-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        maxAge: 3000
      }]
    });

    const lean4Bucket = new s3.Bucket(this, 'Lean4Bucket', {
      bucketName: `midasdash-lean4-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        maxAge: 3000
      }]
    });

    // DynamoDB Tables
    const coreTable = new dynamodb.Table(this, 'CoreTable', {
      tableName: 'midasdash-core',
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES
    });

    // Add GSI for querying by dataset
    coreTable.addGlobalSecondaryIndex({
      indexName: 'DatasetIndex',
      partitionKey: {
        name: 'datasetId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Add GSI for querying by annotator
    coreTable.addGlobalSecondaryIndex({
      indexName: 'AnnotatorIndex',
      partitionKey: {
        name: 'annotatorId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Cognito User Pool for authentication
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'midasdash-users',
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
        username: true
      },
      autoVerify: {
        email: true
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      generateSecret: false,
      preventUserExistenceErrors: true
    });

    // Lambda execution role
    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    // Grant Lambda permissions to access DynamoDB
    coreTable.grantReadWriteData(lambdaRole);

    // Grant Lambda permissions to access S3 buckets
    problemsBucket.grantReadWrite(lambdaRole);
    solutionsBucket.grantReadWrite(lambdaRole);
    lean4Bucket.grantReadWrite(lambdaRole);

    // Lambda environment variables
    const lambdaEnvironment = {
      TABLE_NAME: coreTable.tableName,
      PROBLEMS_BUCKET: problemsBucket.bucketName,
      SOLUTIONS_BUCKET: solutionsBucket.bucketName,
      LEAN4_BUCKET: lean4Bucket.bucketName,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      REGION: this.region
    };

    // Create Lambda functions for API endpoints
    const createDatasetFunction = new nodejs.NodejsFunction(this, 'CreateDatasetFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api/createDataset.ts'),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      bundling: {
        externalModules: ['aws-sdk']
      }
    });

    const listDatasetsFunction = new nodejs.NodejsFunction(this, 'ListDatasetsFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api/listDatasets.ts'),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        externalModules: ['aws-sdk']
      }
    });

    const submitProblemFunction = new nodejs.NodejsFunction(this, 'SubmitProblemFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api/submitProblem.ts'),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      bundling: {
        externalModules: ['aws-sdk']
      }
    });

    const getSubmissionsFunction = new nodejs.NodejsFunction(this, 'GetSubmissionsFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api/getSubmissions.ts'),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        externalModules: ['aws-sdk']
      }
    });

    const getPresignedUrlFunction = new nodejs.NodejsFunction(this, 'GetPresignedUrlFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/api/getPresignedUrl.ts'),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        externalModules: ['aws-sdk']
      }
    });

    // API Gateway HTTP API
    const httpApi = new apigateway.HttpApi(this, 'MidasDashApi', {
      apiName: 'midasdash-api',
      description: 'MidasDash API for dataset management',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.PUT,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(1)
      }
    });

    // Add routes to API Gateway
    httpApi.addRoutes({
      path: '/datasets',
      methods: [apigateway.HttpMethod.POST],
      integration: new apigatewayIntegrations.HttpLambdaIntegration('CreateDatasetIntegration', createDatasetFunction)
    });

    httpApi.addRoutes({
      path: '/datasets',
      methods: [apigateway.HttpMethod.GET],
      integration: new apigatewayIntegrations.HttpLambdaIntegration('ListDatasetsIntegration', listDatasetsFunction)
    });

    httpApi.addRoutes({
      path: '/submissions',
      methods: [apigateway.HttpMethod.POST],
      integration: new apigatewayIntegrations.HttpLambdaIntegration('SubmitProblemIntegration', submitProblemFunction)
    });

    httpApi.addRoutes({
      path: '/submissions',
      methods: [apigateway.HttpMethod.GET],
      integration: new apigatewayIntegrations.HttpLambdaIntegration('GetSubmissionsIntegration', getSubmissionsFunction)
    });

    httpApi.addRoutes({
      path: '/presigned-url',
      methods: [apigateway.HttpMethod.POST],
      integration: new apigatewayIntegrations.HttpLambdaIntegration('GetPresignedUrlIntegration', getPresignedUrlFunction)
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.url!,
      description: 'API Gateway endpoint URL'
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID'
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID'
    });

    new cdk.CfnOutput(this, 'ProblemsS3Bucket', {
      value: problemsBucket.bucketName,
      description: 'S3 bucket for problem files'
    });

    new cdk.CfnOutput(this, 'SolutionsS3Bucket', {
      value: solutionsBucket.bucketName,
      description: 'S3 bucket for solution files'
    });

    new cdk.CfnOutput(this, 'Lean4S3Bucket', {
      value: lean4Bucket.bucketName,
      description: 'S3 bucket for Lean4 files'
    });

    new cdk.CfnOutput(this, 'DynamoDBTable', {
      value: coreTable.tableName,
      description: 'DynamoDB table name'
    });
  }
}