const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { CognitoIdentityProviderClient, AdminGetUserCommand, AdminListGroupsForUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const cognitoClient = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  };

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
    const sub = authorizer.claims.sub;

    // Get user groups from Cognito
    const groupsResponse = await cognitoClient.send(new AdminListGroupsForUserCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: username
    }));

    const groups = groupsResponse.Groups?.map(g => g.GroupName) || [];
    const isAdmin = groups.includes('admin');

    // Get user's dataset memberships from DynamoDB
    const membershipsQuery = await docClient.send(new QueryCommand({
      TableName: process.env.TABLE_NAME,
      IndexName: 'UserSubmissionsIndex',
      KeyConditionExpression: 'submittedBy = :userId',
      ExpressionAttributeValues: {
        ':userId': sub
      },
      ProjectionExpression: 'pk, datasetName, role'
    }));

    const datasets = new Set();
    membershipsQuery.Items?.forEach(item => {
      if (item.pk && item.pk.startsWith('DATASET#')) {
        datasets.add(item.pk.replace('DATASET#', ''));
      }
    });

    // Query for explicit memberships
    const membershipQuery = await docClient.send(new QueryCommand({
      TableName: process.env.TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'sk = :sk',
      ExpressionAttributeValues: {
        ':pk': `USER#${sub}`,
        ':sk': 'MEMBERSHIP'
      }
    }));

    membershipQuery.Items?.forEach(item => {
      if (item.datasetId) {
        datasets.add(item.datasetId);
      }
    });

    const profile = {
      userId: sub,
      username,
      email,
      groups,
      isAdmin,
      datasets: Array.from(datasets),
      createdAt: new Date().toISOString()
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(profile)
    };
  } catch (error) {
    console.error('Error in auth handler:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};