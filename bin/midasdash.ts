#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MidasDashStack } from '../lib/midasdash-stack';

const app = new cdk.App();

new MidasDashStack(app, 'MidasDashStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
  },
  description: 'MidasDash - Multi-annotator dataset management system'
});