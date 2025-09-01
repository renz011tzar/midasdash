#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MathDataFoundryStack } from '../lib/mdf-stack';

const app = new cdk.App();

new MathDataFoundryStack(app, 'MathDataFoundryStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION || 'us-east-1'
  },
  description: 'Math Data Foundry - AWS Serverless Platform'
});

app.synth();