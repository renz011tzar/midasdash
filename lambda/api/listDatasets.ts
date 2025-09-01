import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :pk)',
      ExpressionAttributeValues: {
        ':pk': { S: 'DATASET#' }
      }
    }));

    const datasets = result.Items?.map(item => ({
      datasetId: item.datasetId?.S,
      name: item.name?.S,
      description: item.description?.S,
      annotatorIds: item.annotatorIds?.SS || [],
      createdAt: item.createdAt?.S,
      submissionCount: parseInt(item.submissionCount?.N || '0')
    })) || [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasets })
    };
  } catch (error) {
    console.error('Error listing datasets:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to list datasets' })
    };
  }
};