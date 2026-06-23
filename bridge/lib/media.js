/**
 * Media upload module — AES-128-ECB encryption + WeChat CDN upload.
 *
 * The iLink protocol uses CDN + AES-128-ECB for all media types.
 * Flow:
 *   1. Generate random 16-byte AES key
 *   2. Call getUploadUrl with file metadata
 *   3. AES-128-ECB encrypt the file
 *   4. POST ciphertext to CDN URL
 *   5. Get x-encrypted-param from response (the download reference)
 *   6. Send message with { encrypt_query_param, aes_key (base64), mid_size }
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Media type mapping ─────────────────────────────────────────────────────

const MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
};

/**
 * Guess the iLink media_type from file extension.
 */
function guessMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
  const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
  const voiceExts = [".mp3", ".wav", ".ogg", ".aac", ".m4a", ".silk"];

  if (imageExts.includes(ext)) return MEDIA_TYPE.IMAGE;
  if (videoExts.includes(ext)) return MEDIA_TYPE.VIDEO;
  if (voiceExts.includes(ext)) return MEDIA_TYPE.VOICE;
  return MEDIA_TYPE.FILE;
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".json": "application/json",
  };
  return map[ext] || "application/octet-stream";
}

// ── AES-128-ECB ────────────────────────────────────────────────────────────

export function generateAesKey() {
  return crypto.randomBytes(16);
}

export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── CDN Upload ─────────────────────────────────────────────────────────────

/**
 * Full media upload flow.
 *
 * @param {object} params
 * @param {string} params.filePath - Local file path
 * @param {object} params.ilink - iLink module (for getUploadUrl)
 * @param {string} params.baseUrl - iLink API base URL
 * @param {string} params.token - Bot token
 * @param {string} params.toUserId - Recipient WeChat user ID
 * @returns {Promise<{downloadParam, aeskey, ciphertextSize, fileSize, mediaType, mimeType}>}
 */
export async function uploadMedia({ filePath, ilink, baseUrl, token, toUserId }) {
  const fileBuf = fs.readFileSync(filePath);
  const fileSize = fileBuf.length;
  const fileName = path.basename(filePath);
  const mediaType = guessMediaType(filePath);
  const mimeType = guessMimeType(filePath);

  // Generate AES key
  const aeskey = generateAesKey();

  // Encrypt
  const ciphertext = encryptAesEcb(fileBuf, aeskey);
  const ciphertextSize = ciphertext.length;

  // Compute hashes
  const rawMd5 = crypto.createHash("md5").update(fileBuf).digest("hex");
  const cipherMd5 = crypto.createHash("md5").update(ciphertext).digest("hex");

  // Unique file key
  const filekey = `${Date.now()}_${crypto.randomBytes(8).toString("hex")}_${fileName}`;

  console.log(`  📎 Uploading: ${fileName} (${fileSize} bytes, encrypted: ${ciphertextSize} bytes)`);

  // Step 1: Get upload URL
  const uploadResult = await ilink.getUploadUrl({
    baseUrl,
    token,
    toUserId,
    filekey,
    mediaType,
    rawSize: fileSize,
    rawMd5,
    fileSize: ciphertextSize,
    thumbRawSize: 0,
    thumbMd5: "d41d8cd98f00b204e9800998ecf8427e", // MD5 of empty
    thumbFileSize: 0,
    aeskey,
  });

  const uploadFullUrl = uploadResult.upload_full_url;
  if (!uploadFullUrl) {
    throw new Error(`getUploadUrl: no upload_full_url in response`);
  }

  // Step 2: Upload ciphertext to CDN
  const cdnRes = await fetch(uploadFullUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });

  if (cdnRes.status !== 200) {
    const errMsg = cdnRes.headers.get("x-error-message") ?? `status ${cdnRes.status}`;
    throw new Error(`CDN upload failed: ${errMsg}`);
  }

  const downloadParam = cdnRes.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload: missing x-encrypted-param in response");
  }

  console.log(`  ✅ Uploaded: downloadParam=${downloadParam.slice(0, 20)}...`);

  return {
    downloadParam,
    aeskey,
    ciphertextSize,
    fileSize,
    mediaType,
    mimeType,
    fileName,
  };
}

/**
 * Download a remote URL to a temp file, for forwarding media.
 */
export async function downloadToTemp(url, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const ext = path.extname(new URL(url).pathname) || ".bin";
  const tmpPath = path.join(tmpDir, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);

  return tmpPath;
}
