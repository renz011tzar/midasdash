const { DynamoDBClient  } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand, GetCommand, ScanCommand  } = require('@aws-sdk/lib-dynamodb');
const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand  } = require('@aws-sdk/client-cognito-identity-provider');
const { v4: uuidv4 } = require('uuid');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
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

async function getUserDatasets(userId) {
  const datasets = new Set();
  
  // Query memberships
  const membershipsQuery = await docClient.send(new QueryCommand({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}`,
      ':skPrefix': 'DATASET#'
    }
  }));

  membershipsQuery.Items?.forEach(item => {
    if (item.datasetId) {
      datasets.add(item.datasetId);
    }
  });

  return Array.from(datasets);
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
    const isAdmin = await isUserAdmin(username);

    const method = event.httpMethod;
    const pathParams = event.pathParameters;
    const datasetId = pathParams?.datasetId;

    // GET /datasets - List datasets
    if (method === 'GET' && !datasetId) {
      let datasets;
      
      if (isAdmin) {
        // Admin sees all datasets
        const scanResult = await docClient.send(new ScanCommand({
          TableName: process.env.TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix) AND sk = :sk',
          ExpressionAttributeValues: {
            ':pkPrefix': 'DATASET#',
            ':sk': 'PROFILE'
          }
        }));
        datasets = scanResult.Items || [];
      } else {
        // Regular user sees only their datasets
        const userDatasetIds = await getUserDatasets(userId);
        datasets = [];
        
        for (const id of userDatasetIds) {
          const result = await docClient.send(new GetCommand({
            TableName: process.env.TABLE_NAME,
            Key: {
              pk: `DATASET#${id}`,
              sk: 'PROFILE'
            }
          }));
          if (result.Item) {
            datasets.push(result.Item);
          }
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ datasets })
      };
    }

    // GET /datasets/{datasetId} - Get dataset details
    if (method === 'GET' && datasetId) {
      // Check access
      if (!isAdmin) {
        const userDatasets = await getUserDatasets(userId);
        if (!userDatasets.includes(datasetId)) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Access denied' })
          };
        }
      }

      const dataset = await docClient.send(new GetCommand({
        TableName: process.env.TABLE_NAME,
        Key: {
          pk: `DATASET#${datasetId}`,
          sk: 'PROFILE'
        }
      }));

      if (!dataset.Item) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Dataset not found' })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(dataset.Item)
      };
    }

    // POST /datasets - Create new dataset (admin only)
    if (method === 'POST' && !datasetId) {
      if (!isAdmin) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Admin access required' })
        };
      }

      const body = JSON.parse(event.body || '{}');
      const newDatasetId = uuidv4();
      
      const dataset = {
        pk: `DATASET#${newDatasetId}`,
        sk: 'PROFILE',
        datasetId: newDatasetId,
        name: body.name || 'Unnamed Dataset',
        description: body.description || '',
        createdBy: userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        problemCount: 0,
        memberCount: 0
      };

      await docClient.send(new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: dataset
      }));

      // Add creator 
      await docClient.send(new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          pk: `DATASET#${newDatasetId}`,
          sk: `MEMBER#${userId}`,
          userId,
          username,
          role: 'owner',
          addedAt: new Date().toISOString()
        }
      }));

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify(dataset)
      };
    }

    // GET /datasets/{datasetId}/members - List dataset members
    if (method === 'GET' && datasetId && event.path?.endsWith('/members')) {
      if (!isAdmin) {
        const userDatasets = await getUserDatasets(userId);
        if (!userDatasets.includes(datasetId)) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Access denied' })
          };
        }
      }

      const members = await docClient.send(new QueryCommand({
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `DATASET#${datasetId}`,
          ':skPrefix': 'MEMBER#'
        }
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ members: members.Items || [] })
      };
    }

    // POST /datasets/{datasetId}/members - Add member (admin only)
    if (method === 'POST' && datasetId && event.path?.endsWith('/members')) {
      if (!isAdmin) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Admin access required' })
        };
      }

      const body = JSON.parse(event.body || '{}');
      const { userId: newMemberId, username: newMemberUsername, role = 'annotator' } = body;

      await docClient.send(new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          pk: `DATASET#${datasetId}`,
          sk: `MEMBER#${newMemberId}`,
          userId: newMemberId,
          username: newMemberUsername,
          role,
          addedAt: new Date().toISOString()
        }
      }));

      // Also create reverse mapping for quick user dataset lookups
      await docClient.send(new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          pk: `USER#${newMemberId}`,
          sk: `DATASET#${datasetId}`,
          datasetId,
          role,
          addedAt: new Date().toISOString()
        }
      }));

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({ message: 'Member added successfully' })
      };
    }

    // DELETE /datasets/{datasetId}/members - Remove member (admin only)
    if (method === 'DELETE' && datasetId && event.path?.endsWith('/members')) {
      if (!isAdmin) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Admin access required' })
        };
      }

      const body = JSON.parse(event.body || '{}');
      const { userId: memberToRemove } = body;

      await docClient.send(new DeleteCommand({
        TableName: process.env.TABLE_NAME,
        Key: {
          pk: `DATASET#${datasetId}`,
          sk: `MEMBER#${memberToRemove}`
        }
      }));

      await docClient.send(new DeleteCommand({
        TableName: process.env.TABLE_NAME,
        Key: {
          pk: `USER#${memberToRemove}`,
          sk: `DATASET#${datasetId}`
        }
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Member removed successfully' })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid request' })
    };

  } catch (error) {
    console.error('Error in datasets handler:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};