import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { name, description, annotatorIds } = body;

    if (!name) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Dataset name is required' })
      };
    }

    const datasetId = uuidv4();
    const timestamp = new Date().toISOString();

    const item = {
      PK: { S: `DATASET#${datasetId}` },
      SK: { S: 'METADATA' },
      datasetId: { S: datasetId },
      name: { S: name },
      description: { S: description || '' },
      annotatorIds: { SS: annotatorIds || ['public'] },
      createdAt: { S: timestamp },
      updatedAt: { S: timestamp },
      submissionCount: { N: '0' }
    };

    await dynamodb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        datasetId,
        name,
        description,
        annotatorIds: annotatorIds || ['public'],
        createdAt: timestamp
      })
    };
  } catch (error) {
    console.error('Error creating dataset:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to create dataset' })
    };
  }
};