'use strict';

/**
 * Thin wrapper over AWS Secrets Manager with an in-process cache so warm
 * lambdas don't re-fetch secrets on every invocation.
 *
 * Secrets are NEVER hardcoded or committed — the only inputs here are secret
 * ARNs/names supplied via environment variables at deploy time.
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'eu-north-1',
});

const cache = new Map();

async function getSecretString(secretId) {
  if (cache.has(secretId)) return cache.get(secretId);
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  const value = out.SecretString;
  cache.set(secretId, value);
  return value;
}

async function getSecretJson(secretId) {
  const str = await getSecretString(secretId);
  return JSON.parse(str);
}

module.exports = { getSecretString, getSecretJson };
