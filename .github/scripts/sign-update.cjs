const crypto = require('node:crypto');
const fs = require('node:fs');

const asset = process.argv[2];
const key = crypto.createPrivateKey(process.env.UPDATE_SIGNING_PRIVATE_KEY);
const publicKey = crypto.createPublicKey(key);
if (key.asymmetricKeyType !== 'ed25519' ||
    publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') !== process.env.UPDATE_SIGNING_PUBLIC_KEY) {
  throw new Error('Signing key does not match UPDATE_SIGNING_PUBLIC_KEY');
}
const digest = crypto.createHash('sha256').update(fs.readFileSync(asset)).digest();
fs.writeFileSync(`${asset}.sig`, crypto.sign(null, digest, key));
