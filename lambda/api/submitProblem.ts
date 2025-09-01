import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const s3 = new S3Client({ region: process.env.REGION });
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      datasetId,
      annotatorId,
      problemText,
      solutionText,
      lean4Text,
      metadata
    } = body;

    if (!datasetId || !annotatorId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'datasetId and annotatorId are required' })
      };
    }

    const submissionId = uuidv4();
    const timestamp = new Date().toISOString();

    // Store files in S3 if provided
    const fileKeys: any = {};
    
    if (problemText) {
      const problemKey = `${datasetId}/${submissionId}/problem.txt`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.PROBLEMS_BUCKET!,
        Key: problemKey,
        Body: problemText,
        ContentType: 'text/plain'
      }));
      fileKeys.problemKey = problemKey;
    }

    if (solutionText) {
      const solutionKey = `${datasetId}/${submissionId}/solution.txt`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.SOLUTIONS_BUCKET!,
        Key: solutionKey,
        Body: solutionText,
        ContentType: 'text/plain'
      }));
      fileKeys.solutionKey = solutionKey;
    }

    if (lean4Text) {
      const lean4Key = `${datasetId}/${submissionId}/proof.lean`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.LEAN4_BUCKET!,
        Key: lean4Key,
        Body: lean4Text,
        ContentType: 'text/plain'
      }));
      fileKeys.lean4Key = lean4Key;
    }

    // Store submission in DynamoDB
    const item: any = {
      PK: { S: `SUBMISSION#${submissionId}` },
      SK: { S: `DATASET#${datasetId}` },
      submissionId: { S: submissionId },
      datasetId: { S: datasetId },
      annotatorId: { S: annotatorId },
      createdAt: { S: timestamp },
      status: { S: 'submitted' }
    };

    if (Object.keys(fileKeys).length > 0) {
      item.fileKeys = { M: Object.entries(fileKeys).reduce((acc, [k, v]) => ({
        ...acc,
        [k]: { S: v as string }
      }), {}) };
    }

    if (metadata) {
      item.metadata = { S: JSON.stringify(metadata) };
    }

    await dynamodb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    // Update submission count for dataset
    await dynamodb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `DATASET#${datasetId}` },
        SK: { S: 'METADATA' }
      },
      UpdateExpression: 'ADD submissionCount :inc',
      ExpressionAttributeValues: {
        ':inc': { N: '1' }
      }
    }));

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submissionId,
        datasetId,
        annotatorId,
        fileKeys,
        createdAt: timestamp,
        status: 'submitted'
      })
    };
  } catch (error) {
    console.error('Error submitting problem:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to submit problem' })
    };
  }
};