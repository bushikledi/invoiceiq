import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../../config/config.module.js';

/**
 * Read-only object storage access.
 *
 * The worker never writes to the bucket — it only reads the PDF it was told
 * about. Keeping the surface this small means a compromised worker cannot
 * overwrite or delete a customer's documents.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(WORKER_ENV) env: WorkerEnv) {
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

  /** Streams the object into memory. Capped upstream at 10 MB by the upload rules. */
  async download(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));

    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as Readable) {
      chunks.push(chunk as Buffer);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
}
