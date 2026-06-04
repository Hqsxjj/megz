import crypto from 'node:crypto';

export class WeComCrypt {
  constructor(token, encodingAesKey, corpId) {
    this.token = token;
    this.corpId = corpId;
    this.aesKey = Buffer.from(encodingAesKey + '=', 'base64');
    this.iv = this.aesKey.subarray(0, 16);
  }

  // Verify signature
  verifySignature(signature, timestamp, nonce, encrypt) {
    const list = [this.token, timestamp, nonce, encrypt].sort();
    const str = list.join('');
    const sha1 = crypto.createHash('sha1').update(str).digest('hex');
    return sha1 === signature;
  }

  // Decrypt cipher (Base64 string) to plaintext XML/JSON string
  decrypt(encryptB64) {
    const encrypted = Buffer.from(encryptB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.iv);
    decipher.setAutoPadding(false); // Manually handle PKCS#7 padding
    let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    
    // Strip PKCS#7 padding
    const pad = decrypted[decrypted.length - 1];
    if (pad >= 1 && pad <= 32) {
      decrypted = decrypted.subarray(0, decrypted.length - pad);
    }

    const content = decrypted.subarray(16); // skip random 16 bytes
    const len = content.readInt32BE(0); // read 4 bytes message length
    const msg = content.subarray(4, 4 + len).toString('utf8');
    const receiveId = content.subarray(4 + len).toString('utf8');
    
    return { msg, receiveId };
  }

  // Encrypt plaintext message (XML string) to Base64 string
  encrypt(replyMsg) {
    const randomBytes = crypto.randomBytes(16);
    const msgBuffer = Buffer.from(replyMsg, 'utf8');
    const lenBuffer = Buffer.alloc(4);
    lenBuffer.writeInt32BE(msgBuffer.length, 0);
    const corpIdBuffer = Buffer.from(this.corpId, 'utf8');

    const totalBuffer = Buffer.concat([randomBytes, lenBuffer, msgBuffer, corpIdBuffer]);
    
    // Apply PKCS#7 padding manually
    const pad = 32 - (totalBuffer.length % 32);
    const padBuffer = Buffer.alloc(pad, pad);
    const paddedBuffer = Buffer.concat([totalBuffer, padBuffer]);

    const cipher = crypto.createCipheriv('aes-256-cbc', this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(paddedBuffer), cipher.final()]);
    return encrypted.toString('base64');
  }

  // Create signature for replying
  getSignature(timestamp, nonce, encrypt) {
    const list = [this.token, timestamp, nonce, encrypt].sort();
    const str = list.join('');
    return crypto.createHash('sha1').update(str).digest('hex');
  }
}
