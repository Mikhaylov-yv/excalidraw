import { createHash } from "node:crypto";

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type StoredObject = { body: Uint8Array; etag: string };

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  /** ETag of the stored object, or null if there's none */
  getETag(key: string): Promise<string | null>;
  /** stores the object and returns its new ETag */
  put(key: string, body: Uint8Array): Promise<string>;
}

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

const isNotFound = (error: any) =>
  error?.name === "NoSuchKey" ||
  error?.name === "NotFound" ||
  error?.$metadata?.httpStatusCode === 404;

export class S3ObjectStore implements ObjectStore {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // S3-compatible servers (MinIO, RustFS, ...) may reject the CRC
      // checksums the SDK otherwise adds to every request
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  ensureBucket = async () => {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error: any) {
      if (!isNotFound(error)) {
        throw error;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  };

  get = async (key: string) => {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        body: await response.Body!.transformToByteArray(),
        etag: response.ETag!,
      };
    } catch (error: any) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  };

  getETag = async (key: string) => {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return response.ETag!;
    } catch (error: any) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  };

  put = async (key: string, body: Uint8Array) => {
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/octet-stream",
      }),
    );
    return response.ETag!;
  };
}

/** For tests and for trying the server out without an S3 */
export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, StoredObject>();

  get = async (key: string) => this.objects.get(key) ?? null;

  getETag = async (key: string) => this.objects.get(key)?.etag ?? null;

  put = async (key: string, body: Uint8Array) => {
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    this.objects.set(key, { body: new Uint8Array(body), etag });
    return etag;
  };
}
