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
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
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

/**
 * Create or update a secret at `name` holding `value`. If the secret already
 * exists, its value is overwritten (idempotent for reconnect flows). Returns
 * the secret name (used as the stored reference on the sites row).
 */
async function putSecret(name, value) {
  try {
    await client.send(
      new CreateSecretCommand({ Name: name, SecretString: value })
    );
  } catch (err) {
    if (err.name === 'ResourceExistsException') {
      await client.send(
        new PutSecretValueCommand({ SecretId: name, SecretString: value })
      );
    } else {
      throw err;
    }
  }
  cache.set(name, value);
  return name;
}

/**
 * Delete a secret immediately (no recovery window) so a subsequent reconnect
 * can recreate the same name. Missing secrets are treated as success.
 */
async function deleteSecret(name) {
  try {
    await client.send(
      new DeleteSecretCommand({
        SecretId: name,
        ForceDeleteWithoutRecovery: true,
      })
    );
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }
  cache.delete(name);
}

module.exports = {
  getSecretString,
  getSecretJson,
  putSecret,
  deleteSecret,
};
