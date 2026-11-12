const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('release signature verifies against the SHA-256 digest and pinned key', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-sign-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asset = path.join(dir, 'asset');
  fs.writeFileSync(asset, 'release binary');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const env = {
    ...process.env,
    UPDATE_SIGNING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    UPDATE_SIGNING_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
  const run = (overrides = {}) => spawnSync(process.execPath, [path.join(__dirname, 'sign-update.cjs'), asset], { env: { ...env, ...overrides } });
  assert.equal(run().status, 0);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(asset)).digest();
  assert.equal(crypto.verify(null, digest, publicKey, fs.readFileSync(`${asset}.sig`)), true);
  if (process.platform === 'linux') {
    const publicKeyPath = path.join(dir, 'public.pem');
    const digestPath = path.join(dir, 'digest');
    fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(digestPath, digest);
    const openssl = spawnSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', publicKeyPath, '-rawin', '-in', digestPath, '-sigfile', `${asset}.sig`]);
    assert.equal(openssl.status, 0, openssl.stderr.toString());
  }
  fs.unlinkSync(`${asset}.sig`);
  assert.notEqual(run({ UPDATE_SIGNING_PUBLIC_KEY: Buffer.alloc(32).toString('base64') }).status, 0);
  assert.equal(fs.existsSync(`${asset}.sig`), false);
});
