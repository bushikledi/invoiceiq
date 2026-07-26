import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';

/**
 * S3-compatible object storage.
 *
 * One adapter serves both MinIO locally and real S3 in production — the only
 * difference is `forcePathStyle`, because MinIO addresses buckets by path while
 * AWS uses virtual-host style. Presigned upload/download arrives in M4; M2
 * needs only enough to prove the bucket is reachable.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(@Inject(API_ENV) env: ApiEnv) {
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
}
