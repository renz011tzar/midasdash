import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    const datasetId = event.queryStringParameters?.datasetId;
    const annotatorId = event.queryStringParameters?.annotatorId;

    if (!datasetId && !annotatorId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Either datasetId or annotatorId is required' })
      };
    }

    let result;
    
    if (datasetId) {
      // Query by dataset
      result = await dynamodb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'DatasetIndex',
        KeyConditionExpression: 'datasetId = :datasetId',
        ExpressionAttributeValues: {
          ':datasetId': { S: datasetId }
        }
      }));
    } else {
      // Query by annotator
      result = await dynamodb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'AnnotatorIndex',
        KeyConditionExpression: 'annotatorId = :annotatorId',
        ExpressionAttributeValues: {
          ':annotatorId': { S: annotatorId! }
        }
      }));
    }

    const submissions = result.Items?.map(item => ({
      submissionId: item.submissionId?.S,
      datasetId: item.datasetId?.S,
      annotatorId: item.annotatorId?.S,
      createdAt: item.createdAt?.S,
      status: item.status?.S,
      fileKeys: item.fileKeys?.M ? Object.entries(item.fileKeys.M).reduce((acc, [k, v]) => ({
        ...acc,
        [k]: v.S
      }), {}) : {},
      metadata: item.metadata?.S ? JSON.parse(item.metadata.S) : null
    })) || [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissions })
    };
  } catch (error) {
    console.error('Error getting submissions:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to get submissions' })
    };
  }
};