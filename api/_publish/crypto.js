// AES-256-GCM encryption for per-brand channel credentials.
// Key derived from env APP_ENC_KEY (set a long random string in Vercel env).
// Blob layout: base64( iv(12) | authTag(16) | ciphertext ).
const crypto = require('crypto');

function key() {
  const k = process.env.APP_ENC_KEY || '';
  if (k.length < 16) throw new Error('APP_ENC_KEY is missing or too short');
  return crypto.createHash('sha256').update(k, 'utf8').digest(); // 32 bytes
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { encrypt, decrypt };
