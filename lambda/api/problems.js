const { DynamoDBClient  } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, UpdateCommand, ScanCommand  } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand  } = require('@aws-sdk/client-s3');
const { getSignedUrl  } = require('@aws-sdk/s3-request-presigner');
const { EventBridgeClient, PutEventsCommand  } = require('@aws-sdk/client-eventbridge');
const { SNSClient, PublishCommand  } = require('@aws-sdk/client-sns');
const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand  } = require('@aws-sdk/client-cognito-identity-provider');
const { v4: uuidv4 } = require('uuid');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const eventBridgeClient = new EventBridgeClient({});
const snsClient = new SNSClient({});
const cognitoClient = new CognitoIdentityProviderClient({});

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

async function isUserAdmin(username) {
  try {
    const groupsResponse = await cognitoClient.send(new AdminListGroupsForUserCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: username
    }));
    return groupsResponse.Groups?.some(g => g.GroupName === 'admin') || false;
  } catch {
    return false;
  }
}

async function canAccessDataset(userId, datasetId, isAdmin) {
  if (isAdmin) return true;
  
  const membership = await docClient.send(new GetCommand({
    TableName: process.env.TABLE_NAME,
    Key: {
      pk: `DATASET#${datasetId}`,
      sk: `MEMBER#${userId}`
    }
  }));
  
  return !!membership.Item;
}

async function notifyAdmins(message, subject) {
  try {
    await snsClient.send(new PublishCommand({
      TopicArn: process.env.NOTIFICATION_TOPIC_ARN,
      Message: message,
      Subject: subject
    }));

    await eventBridgeClient.send(new PutEventsCommand({
      Entries: [{
        Source: 'mdf.submissions',
        DetailType: subject,
        Detail: JSON.stringify({ message, timestamp: new Date().toISOString() })
      }]
    }));
  } catch (error) {
    console.error('Failed to send notification:', error);
  }
}

exports.handler = async (event) => {
  try {
    const authorizer = event.requestContext.authorizer;
    if (!authorizer?.claims) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    const username = authorizer.claims['cognito:username'] || authorizer.claims.email;
    const email = authorizer.claims.email;
    const userId = authorizer.claims.sub;
    const isAdmin = await isUserAdmin(username);

    const method = event.httpMethod;
    const pathParams = event.pathParameters;
    const datasetId = pathParams?.datasetId;
    const problemId = pathParams?.problemId;

    // GET /datasets/{datasetId}/problems - List problems in dataset
    if (method === 'GET' && datasetId && event.path?.includes('/datasets/')) {
      if (!await canAccessDataset(userId, datasetId, isAdmin)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied' })
        };
      }

      const problems = await docClient.send(new QueryCommand({
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `DATASET#${datasetId}`,
          ':skPrefix': 'PROBLEM#'
        }
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ problems: problems.Items || [] })
      };
    }

    // POST /datasets/{datasetId}/problems - Create new problem
    if (method === 'POST' && datasetId && event.path?.includes('/datasets/')) {
      if (!await canAccessDataset(userId, datasetId, isAdmin)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied' })
        };
      }

      const body = JSON.parse(event.body || '{}');
      const newProblemId = uuidv4();
      
      // Validate required fields
      if (!body.problemText || !body.solutionText) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Problem text and solution text are required' })
        };
      }

      const problem = {
        pk: `DATASET#${datasetId}`,
        sk: `PROBLEM#${newProblemId}`,
        problemId: newProblemId,
        datasetId,
        submittedBy: userId,
        username: body.username || username,
        email: body.email || email,
        labels: body.labels || [],
        originality: body.originality || 'original',
        variationSource: body.variationSource,
        problemText: body.problemText,
        solutionText: body.solutionText,
        s3Keys: {
          problemLatex: null,
          solutionLatex: null,
          problemMarkdown: null,
          solutionMarkdown: null
        },
        lean4: {
          attached: false,
          s3Key: null
        },
        review: {
          state: 'draft',
          by: null,
          at: null,
          comments: null
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // For GSIs
        submittedBy: userId,
        reviewState: 'draft',
        label: body.labels?.[0] || 'untagged'
      };

      await docClient.send(new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: problem
      }));

      // Generate presigned URLs for file uploads
      const presignedUrls = {};
      
      if (body.requestPresignedUrls) {
        const problemLatexKey = `${datasetId}/${newProblemId}/problem.tex`;
        const solutionLatexKey = `${datasetId}/${newProblemId}/solution.tex`;
        const problemMarkdownKey = `${datasetId}/${newProblemId}/problem.md`;
        const solutionMarkdownKey = `${datasetId}/${newProblemId}/solution.md`;

        presignedUrls.problemLatex = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: process.env.PROBLEMS_BUCKET,
            Key: problemLatexKey,
            ContentType: 'text/plain'
          }),
          { expiresIn: 3600 }
        );

        presignedUrls.solutionLatex = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: process.env.SOLUTIONS_BUCKET,
            Key: solutionLatexKey,
            ContentType: 'text/plain'
          }),
          { expiresIn: 3600 }
        );

        presignedUrls.problemMarkdown = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: process.env.PROBLEMS_BUCKET,
            Key: problemMarkdownKey,
            ContentType: 'text/markdown'
          }),
          { expiresIn: 3600 }
        );

        presignedUrls.solutionMarkdown = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: process.env.SOLUTIONS_BUCKET,
            Key: solutionMarkdownKey,
            ContentType: 'text/markdown'
          }),
          { expiresIn: 3600 }
        );
      }

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
          problem,
          presignedUrls
        })
      };
    }

    // GET /problems/{problemId} - Get problem details
    if (method === 'GET' && problemId) {
      // First find which dataset this problem belongs to
      const scanResult = await docClient.send(new ScanCommand({
        TableName: process.env.TABLE_NAME,
        FilterExpression: 'sk = :sk',
        ExpressionAttributeValues: {
          ':sk': `PROBLEM#${problemId}`
        }
      }));

      if (!scanResult.Items || scanResult.Items.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Problem not found' })
        };
      }

      const problem = scanResult.Items[0];
      const problemDatasetId = problem.datasetId;

      if (!await canAccessDataset(userId, problemDatasetId, isAdmin)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied' })
        };
      }

      // Generate signed URLs for reading files
      const signedUrls = {};
      
      if (problem.s3Keys?.problemLatex) {
        signedUrls.problemLatex = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: process.env.PROBLEMS_BUCKET,
            Key: problem.s3Keys.problemLatex
          }),
          { expiresIn: 3600 }
        );
      }

      if (problem.s3Keys?.solutionLatex) {
        signedUrls.solutionLatex = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: process.env.SOLUTIONS_BUCKET,
            Key: problem.s3Keys.solutionLatex
          }),
          { expiresIn: 3600 }
        );
      }

      if (problem.lean4?.s3Key) {
        signedUrls.lean4 = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: process.env.LEAN4_BUCKET,
            Key: problem.lean4.s3Key
          }),
          { expiresIn: 3600 }
        );
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...problem,
          signedUrls
        })
      };
    }

    // POST /problems/{problemId}/finalize - Finalize submission
    if (method === 'POST' && problemId && event.path?.endsWith('/finalize')) {
      // Find the problem
      const scanResult = await docClient.send(new ScanCommand({
        TableName: process.env.TABLE_NAME,
        FilterExpression: 'sk = :sk',
        ExpressionAttributeValues: {
          ':sk': `PROBLEM#${problemId}`
        }
      }));

      if (!scanResult.Items || scanResult.Items.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Problem not found' })
        };
      }

      const problem = scanResult.Items[0];
      const problemDatasetId = problem.datasetId;

      if (!await canAccessDataset(userId, problemDatasetId, isAdmin)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied' })
        };
      }

      // Update problem status to pending review
      await docClient.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME,
        Key: {
          pk: problem.pk,
          sk: problem.sk
        },
        UpdateExpression: 'SET #review.#state = :state, #review.#at = :now, updatedAt = :now, reviewState = :state',
        ExpressionAttributeNames: {
          '#review': 'review',
          '#state': 'state',
          '#at': 'at'
        },
        ExpressionAttributeValues: {
          ':state': 'pending',
          ':now': new Date().toISOString()
        }
      }));

      // Notify admins
      await notifyAdmins(
        `New submission finalized:\n\nProblem ID: ${problemId}\nDataset: ${problemDatasetId}\nSubmitted by: ${username}\nLabels: ${problem.labels?.join(', ') || 'None'}`,
        'New Submission Finalized'
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Problem finalized successfully' })
      };
    }

    // PUT /problems/{problemId}/lean4 - Attach Lean4 code
    if (method === 'PUT' && problemId && event.path?.endsWith('/lean4')) {
      // Find the problem
      const scanResult = await docClient.send(new ScanCommand({
        TableName: process.env.TABLE_NAME,
        FilterExpression: 'sk = :sk',
        ExpressionAttributeValues: {
          ':sk': `PROBLEM#${problemId}`
        }
      }));

      if (!scanResult.Items || scanResult.Items.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Problem not found' })
        };
      }

      const problem = scanResult.Items[0];
      const problemDatasetId = problem.datasetId;

      if (!await canAccessDataset(userId, problemDatasetId, isAdmin)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied' })
        };
      }

      const body = JSON.parse(event.body || '{}');
      const lean4Key = `${problemDatasetId}/${problemId}/code.lean`;

      // Generate presigned URL for Lean4 upload
      const presignedUrl = await getSignedUrl(
        s3Client,
        new PutObjectCommand({
          Bucket: process.env.LEAN4_BUCKET,
          Key: lean4Key,
          ContentType: 'text/plain'
        }),
        { expiresIn: 3600 }
      );

      // Update problem with Lean4 info
      await docClient.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME,
        Key: {
          pk: problem.pk,
          sk: problem.sk
        },
        UpdateExpression: 'SET lean4 = :lean4, updatedAt = :now',
        ExpressionAttributeValues: {
          ':lean4': {
            attached: true,
            s3Key: lean4Key,
            attachedAt: new Date().toISOString()
          },
          ':now': new Date().toISOString()
        }
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Lean4 attachment prepared',
          presignedUrl
        })
      };
    }

    // POST /problems/search - Advanced search
    if (method === 'POST' && event.path?.endsWith('/search')) {
      const body = JSON.parse(event.body || '{}');
      const { labels, user, status, datasetId: searchDatasetId } = body;

      let filterExpression = 'begins_with(sk, :skPrefix)';
      const expressionValues = {
        ':skPrefix': 'PROBLEM#'
      };

      if (labels && labels.length > 0) {
        filterExpression += ' AND contains(labels, :label)';
        expressionValues[':label'] = labels[0];
      }

      if (user) {
        filterExpression += ' AND submittedBy = :user';
        expressionValues[':user'] = user;
      }

      if (status) {
        filterExpression += ' AND #review.#state = :status';
        expressionValues[':status'] = status;
      }

      const scanParams = {
        TableName: process.env.TABLE_NAME,
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionValues
      };

      if (status) {
        scanParams.ExpressionAttributeNames = {
          '#review': 'review',
          '#state': 'state'
        };
      }

      const results = await docClient.send(new ScanCommand(scanParams));
      
      // Filter results based on user access
      let problems = results.Items || [];
      
      if (!isAdmin) {
        const userDatasets = new Set();
        const membershipQuery = await docClient.send(new QueryCommand({
          TableName: process.env.TABLE_NAME,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': `USER#${userId}`,
            ':skPrefix': 'DATASET#'
          }
        }));
        
        membershipQuery.Items?.forEach(item => {
          if (item.datasetId) {
            userDatasets.add(item.datasetId);
          }
        });
        
        problems = problems.filter(p => userDatasets.has(p.datasetId));
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ problems })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid request' })
    };

  } catch (error) {
    console.error('Error in problems handler:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};