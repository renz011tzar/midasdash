import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as waf from 'aws-cdk-lib/aws-wafv2';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

export class MathDataFoundryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ================== COGNITO USER POOL ==================
    const userPool = new cognito.UserPool(this, 'MdfUserPool', {
      userPoolName: 'mdf-user-pool',
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
        username: true
      },
      autoVerify: {
        email: true
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true
        }
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Admin group
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
      description: 'Admin users with full access',
      precedence: 1
    });

    // Annotator group  
    const annotatorGroup = new cognito.CfnUserPoolGroup(this, 'AnnotatorGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'annotator',
      description: 'Annotator users with restricted access',
      precedence: 10
    });

    // Admin user will be created manually after deployment
    // This avoids deployment issues with pre-created users
    // To create admin user after deployment:
    // 1. Create user in Cognito console or via CLI
    // 2. Add user to 'admin' group
    // 3. Email: renzo.balcazar.1@gmail.com

    // User Pool Client
    const userPoolClient = userPool.addClient('MdfWebClient', {
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE
        ],
        callbackUrls: [
          'http://localhost:3000/callback',
          `https://${cdk.Aws.ACCOUNT_ID}.cloudfront.net/callback`
        ],
        logoutUrls: [
          'http://localhost:3000',
          `https://${cdk.Aws.ACCOUNT_ID}.cloudfront.net`
        ]
      },
      generateSecret: false
    });

    // ================== DYNAMODB TABLE ==================
    const table = new dynamodb.Table(this, 'MdfCoreTable', {
      tableName: 'mdf-core',
      partitionKey: {
        name: 'pk',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // GSI for user submissions
    table.addGlobalSecondaryIndex({
      indexName: 'UserSubmissionsIndex',
      partitionKey: {
        name: 'submittedBy',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // GSI for review queue
    table.addGlobalSecondaryIndex({
      indexName: 'ReviewQueueIndex',
      partitionKey: {
        name: 'reviewState',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // GSI for label search
    table.addGlobalSecondaryIndex({
      indexName: 'LabelSearchIndex',
      partitionKey: {
        name: 'label',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // ================== S3 BUCKETS ==================
    const problemsBucket = new s3.Bucket(this, 'ProblemsBucket', {
      bucketName: `mdf-problems-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000
        }
      ],
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30)
            },
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(180)
            }
          ]
        }
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const solutionsBucket = new s3.Bucket(this, 'SolutionsBucket', {
      bucketName: `mdf-solutions-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000
        }
      ],
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30)
            },
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(180)
            }
          ]
        }
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const lean4Bucket = new s3.Bucket(this, 'Lean4Bucket', {
      bucketName: `mdf-lean4-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000
        }
      ],
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30)
            },
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(180)
            }
          ]
        }
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const exportsBucket = new s3.Bucket(this, 'ExportsBucket', {
      bucketName: `mdf-exports-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Frontend hosting bucket
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `mdf-frontend-${cdk.Aws.ACCOUNT_ID}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'error.html',
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // ================== SNS TOPIC FOR NOTIFICATIONS ==================
    const notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: 'mdf-notifications',
      displayName: 'Math Data Foundry Notifications'
    });

    // Add email subscription for admin
    notificationTopic.addSubscription(
      new subscriptions.EmailSubscription('renzo.balcazar.1@gmail.com')
    );

    // ================== LAMBDA FUNCTIONS ==================
    const lambdaEnvironment = {
      TABLE_NAME: table.tableName,
      PROBLEMS_BUCKET: problemsBucket.bucketName,
      SOLUTIONS_BUCKET: solutionsBucket.bucketName,
      LEAN4_BUCKET: lean4Bucket.bucketName,
      EXPORTS_BUCKET: exportsBucket.bucketName,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      NOTIFICATION_TOPIC_ARN: notificationTopic.topicArn,
      REGION: cdk.Aws.REGION
    };

    // Common Lambda function properties
    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: lambdaEnvironment,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512
    };

    // Auth Lambda
    const authFunction = new lambda.Function(this, 'AuthFunction', {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/api')),
      handler: 'auth.handler',
      functionName: 'mdf-auth'
    });

    // Datasets Lambda
    const datasetsFunction = new lambda.Function(this, 'DatasetsFunction', {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/api')),
      handler: 'datasets.handler',
      functionName: 'mdf-datasets'
    });

    // Problems Lambda
    const problemsFunction = new lambda.Function(this, 'ProblemsFunction', {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/api')),
      handler: 'problems.handler',
      functionName: 'mdf-problems'
    });

    // Admin Lambda
    const adminFunction = new lambda.Function(this, 'AdminFunction', {
      ...commonLambdaProps,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/api')),
      handler: 'admin.handler',
      functionName: 'mdf-admin'
    });

    // Grant permissions to Lambda functions
    table.grantReadWriteData(authFunction);
    table.grantReadWriteData(datasetsFunction);
    table.grantReadWriteData(problemsFunction);
    table.grantReadWriteData(adminFunction);

    problemsBucket.grantReadWrite(problemsFunction);
    solutionsBucket.grantReadWrite(problemsFunction);
    lean4Bucket.grantReadWrite(problemsFunction);
    exportsBucket.grantReadWrite(adminFunction);

    problemsBucket.grantRead(adminFunction);
    solutionsBucket.grantRead(adminFunction);
    lean4Bucket.grantRead(adminFunction);

    notificationTopic.grantPublish(problemsFunction);
    notificationTopic.grantPublish(adminFunction);

    // Grant Cognito permissions
    const cognitoPolicy = new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:ListUsers',
        'cognito-idp:ListUsersInGroup'
      ],
      resources: [userPool.userPoolArn]
    });

    authFunction.addToRolePolicy(cognitoPolicy);
    datasetsFunction.addToRolePolicy(cognitoPolicy);
    adminFunction.addToRolePolicy(cognitoPolicy);

    // ================== API GATEWAY ==================
    const api = new apigateway.RestApi(this, 'MdfApi', {
      restApiName: 'mdf-api',
      description: 'Math Data Foundry API',
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: false  // Disabled due to CloudWatch role requirements
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token'
        ]
      }
    });

    // Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'MdfAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'MdfCognitoAuthorizer'
    });

    // API Routes
    const meResource = api.root.addResource('me');
    meResource.addMethod('GET', new apigateway.LambdaIntegration(authFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const datasetsResource = api.root.addResource('datasets');
    datasetsResource.addMethod('GET', new apigateway.LambdaIntegration(datasetsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    datasetsResource.addMethod('POST', new apigateway.LambdaIntegration(datasetsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const datasetResource = datasetsResource.addResource('{datasetId}');
    datasetResource.addMethod('GET', new apigateway.LambdaIntegration(datasetsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const membersResource = datasetResource.addResource('members');
    membersResource.addMethod('GET', new apigateway.LambdaIntegration(datasetsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    membersResource.addMethod('POST', new apigateway.LambdaIntegration(datasetsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    membersResource.addMethod('DELETE', new apigateway.LambdaIntegration(datasetsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const datasetProblemsResource = datasetResource.addResource('problems');
    datasetProblemsResource.addMethod('GET', new apigateway.LambdaIntegration(problemsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    datasetProblemsResource.addMethod('POST', new apigateway.LambdaIntegration(problemsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const problemsResource = api.root.addResource('problems');
    const problemResource = problemsResource.addResource('{problemId}');
    problemResource.addMethod('GET', new apigateway.LambdaIntegration(problemsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    problemResource.addMethod('PUT', new apigateway.LambdaIntegration(problemsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const finalizeResource = problemResource.addResource('finalize');
    finalizeResource.addMethod('POST', new apigateway.LambdaIntegration(problemsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const lean4Resource = problemResource.addResource('lean4');
    lean4Resource.addMethod('PUT', new apigateway.LambdaIntegration(problemsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const searchResource = problemsResource.addResource('search');
    searchResource.addMethod('POST', new apigateway.LambdaIntegration(problemsFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const adminResource = api.root.addResource('admin');
    const exportResource = adminResource.addResource('export');
    exportResource.addMethod('POST', new apigateway.LambdaIntegration(adminFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const reviewResource = adminResource.addResource('review');
    reviewResource.addMethod('POST', new apigateway.LambdaIntegration(adminFunction), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // ================== CLOUDFRONT DISTRIBUTION ==================
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'OAI');
    frontendBucket.grantRead(originAccessIdentity);

    const distribution = new cloudfront.Distribution(this, 'MdfDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(frontendBucket, {
          originAccessIdentity
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.RestApiOrigin(api),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER
        }
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0)
        }
      ]
    });

    // ================== EVENTBRIDGE RULE ==================
    const submissionRule = new events.Rule(this, 'SubmissionRule', {
      eventPattern: {
        source: ['mdf.submissions'],
        detailType: ['New Submission', 'Submission Finalized']
      }
    });

    submissionRule.addTarget(new targets.SnsTopic(notificationTopic));

    // ================== WAF WEB ACL ==================
    const webAcl = new waf.CfnWebACL(this, 'MdfWebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: {
        allow: {}
      },
      rules: [
        {
          name: 'RateLimitRule',
          priority: 1,
          action: {
            block: {}
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP'
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule'
          }
        },
        {
          name: 'CommonRuleSet',
          priority: 2,
          overrideAction: {
            none: {}
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet'
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet'
          }
        }
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'MdfWebAcl'
      }
    });

    // ================== OUTPUTS ==================
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID'
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID'
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL'
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront Distribution URL'
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
      description: 'Frontend S3 Bucket Name'
    });
  }
}