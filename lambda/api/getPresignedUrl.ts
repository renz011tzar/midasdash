import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: process.env.REGION });

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { bucket, key, operation = 'getObject' } = body;

    if (!bucket || !key) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'bucket and key are required' })
      };
    }

    // Validate bucket name
    const validBuckets = [
      process.env.PROBLEMS_BUCKET,
      process.env.SOLUTIONS_BUCKET,
      process.env.LEAN4_BUCKET
    ];

    if (!validBuckets.includes(bucket)) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid bucket' })
      };
    }

    let command;
    if (operation === 'putObject') {
      command = new PutObjectCommand({
        Bucket: bucket,
        Key: key
      });
    } else {
      command = new GetObjectCommand({
        Bucket: bucket,
        Key: key
      });
    }

    const presignedUrl = await getSignedUrl(s3, command, {
      expiresIn: 3600 // 1 hour
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presignedUrl })
    };
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to generate presigned URL' })
    };
  }
};