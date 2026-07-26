import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';

export interface ObjectMetadata {
  sizeBytes: number;
  contentType: string | undefined;
}

/**
 * S3-compatible object storage.
 *
 * One adapter serves MinIO locally and real S3 in production; the only
 * difference is `forcePathStyle`, because MinIO addresses buckets by path while
 * AWS uses virtual-host style.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  /** Confirms the bucket exists and our credentials can see it. */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /**
   * Generates a storage key.
   *
   * Server-generated UUID, never the user's filename. The original name is kept
   * in the database for display only — letting it reach the key would open path
   * traversal and key-collision problems for no benefit.
   */
  newDocumentKey(): string {
    return `docs/${randomUUID()}.pdf`;
  }

  /**
   * Presigns a PUT so the browser uploads straight to storage.
   *
   * Content-Type and Content-Length are bound into the signature, so a client
   * that tries to upload something larger or of a different type gets a
   * signature mismatch from S3 rather than a surprise for us to discover later.
   * This is a first line of defence, not the only one — /complete re-verifies.
   */
  presignUpload(key: string, sizeBytes: number, contentType: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      }),
      { expiresIn: this.env.PRESIGNED_PUT_TTL_SECONDS },
    );
  }

  /** Short-lived presigned GET for the PDF viewer. */
  presignDownload(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.env.PRESIGNED_GET_TTL_SECONDS,
    });
  }

  /** Returns metadata, or undefined when the object does not exist. */
  async head(key: string): Promise<ObjectMetadata | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** Reads the first `length` bytes — enough to check a file signature. */
  async readPrefix(key: string, length: number): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=0-${length - 1}`,
      }),
    );
    return streamToBuffer(result);
  }

  /**
   * Streams the object to compute its SHA-256.
   *
   * Streamed rather than buffered because a 10 MB allocation per concurrent
   * upload is avoidable waste, and the same code path will later handle the
   * worker's PDF reads where size limits are less certain.
   */
  async sha256(key: string): Promise<string> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));

    const hash = createHash('sha256');
    const body = result.Body as Readable;
    for await (const chunk of body) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}

async function streamToBuffer(result: GetObjectCommandOutput): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const body = result.Body as Readable;
  for await (const chunk of body) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
