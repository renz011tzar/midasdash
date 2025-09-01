const { DynamoDBClient  } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, ScanCommand, QueryCommand  } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand  } = require('@aws-sdk/client-s3');
const { getSignedUrl  } = require('@aws-sdk/s3-request-presigner');
const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand  } = require('@aws-sdk/client-cognito-identity-provider');
const { SNSClient, PublishCommand  } = require('@aws-sdk/client-sns');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const cognitoClient = new CognitoIdentityProviderClient({});
const snsClient = new SNSClient({});

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
    const userId = authorizer.claims.sub;
    
    // Verify admin access
    const isAdmin = await isUserAdmin(username);
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Admin access required' })
      };
    }

    const method = event.httpMethod;
    const path = event.path;

    // POST /admin/review - Review a problem (approve/reject)
    if (method === 'POST' && path.endsWith('/review')) {
      const body = JSON.parse(event.body || '{}');
      const { problemId, action, comments } = body;

      if (!problemId || !['approve', 'reject'].includes(action)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid request. Provide problemId and action (approve/reject)' })
        };
      }

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
      const newState = action === 'approve' ? 'approved' : 'rejected';

      // Update problem review status
      await docClient.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME,
        Key: {
          pk: problem.pk,
          sk: problem.sk
        },
        UpdateExpression: 'SET #review = :review, reviewState = :state, updatedAt = :now',
        ExpressionAttributeNames: {
          '#review': 'review'
        },
        ExpressionAttributeValues: {
          ':review': {
            state: newState,
            by: userId,
            at: new Date().toISOString(),
            comments: comments || null
          },
          ':state': newState,
          ':now': new Date().toISOString()
        }
      }));

      // Notify submitter via SNS
      await snsClient.send(new PublishCommand({
        TopicArn: process.env.NOTIFICATION_TOPIC_ARN,
        Message: `Your submission (Problem ID: ${problemId}) h ${newState}.\n\n${comments ? `Comments: ${comments}` : ''}`,
        Subject: `Submission ${newState}`
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: `Problem ${newState} successfully`,
          problemId,
          action,
          reviewedBy: userId
        })
      };
    }

    // POST /admin/export - Export dataset
    if (method === 'POST' && path.endsWith('/export')) {
      const body = JSON.parse(event.body || '{}');
      const { datasetId, format = 'json' } = body;

      if (!datasetId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Dataset ID required' })
        };
      }

      // Get all problems from dataset
      const problems = await docClient.send(new QueryCommand({
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `DATASET#${datasetId}`,
          ':skPrefix': 'PROBLEM#'
        }
      }));

      if (!problems.Items || problems.Items.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'No problems found in dataset' })
        };
      }

      // Prepare export data
      const exportData = {
        datasetId,
        exportedAt: new Date().toISOString(),
        exportedBy: userId,
        problemCount: problems.Items.length,
        problems: problems.Items.map(item => ({
          problemId: item.problemId,
          submittedBy: item.username,
          email: item.email,
          labels: item.labels,
          originality: item.originality,
          variationSource: item.variationSource,
          problemText: item.problemText,
          solutionText: item.solutionText,
          s3Keys: item.s3Keys,
          lean4: item.lean4,
          review: item.review,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        }))
      };

      // Save export to S3
      const exportKey = `exports/${datasetId}/${new Date().toISOString()}-export.${format}`;
      const exportContent = format === 'json' 
        ? JSON.stringify(exportData, null, 2)
        : convertToCSV(exportData.problems);

      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.EXPORTS_BUCKET,
        Key: exportKey,
        Body: exportContent,
        ContentType: format === 'json' ? 'application/json' : 'text/csv'
      }));

      // Generate signed URL for download
      const downloadUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: process.env.EXPORTS_BUCKET,
          Key: exportKey
        }),
        { expiresIn: 3600 }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Export generated successfully',
          downloadUrl,
          exportKey,
          problemCount: problems.Items.length
        })
      };
    }

    // GET /admin/stats - Get platform statistics
    if (method === 'GET' && path.endsWith('/stats')) {
      // Get all datasets
      const datasets = await docClient.send(new ScanCommand({
        TableName: process.env.TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pkPrefix) AND sk = :sk',
        ExpressionAttributeValues: {
          ':pkPrefix': 'DATASET#',
          ':sk': 'PROFILE'
        }
      }));

      // Get all problems
      const problems = await docClient.send(new ScanCommand({
        TableName: process.env.TABLE_NAME,
        FilterExpression: 'begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':skPrefix': 'PROBLEM#'
        }
      }));

      // Get all members
      const members = await docClient.send(new ScanCommand({
        TableName: process.env.TABLE_NAME,
        FilterExpression: 'begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':skPrefix': 'MEMBER#'
        }
      }));

      // Calculate statistics
      const stats = {
        totalDatasets: datasets.Items?.length || 0,
        totalProblems: problems.Items?.length || 0,
        totalMembers: new Set(members.Items?.map(m => m.userId)).size,
        problemsByStatus: {
          draft: 0,
          pending: 0,
          approved: 0,
          rejected: 0
        },
        problemsByLabel: {} <string, number>
      };

      problems.Items?.forEach(problem => {
        const status = problem.review?.state || 'draft';
        stats.problemsByStatus[status  typeof stats.problemsByStatus]++;
        
        problem.labels?.forEach((label) => {
          stats.problemsByLabel[label] = (stats.problemsByLabel[label] || 0) + 1;
        });
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(stats)
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid request' })
    };

  } catch (error) {
    console.error('Error in admin handler:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

function convertToCSV(data[]) {
  if (data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const csvHeaders = headers.join(',');
  
  const csvRows = data.map(row => {
    return headers.map(header => {
      const value = row[header];
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value || '').replace(/,/g, ';');
    }).join(',');
  });
  
  return [csvHeaders, ...csvRows].join('\n');
}