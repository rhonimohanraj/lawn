import { S3Client } from "@aws-sdk/client-s3";

function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

export const BUCKET_NAME =
  readEnv("BACKBLAZE_BUCKET_NAME", "RAILWAY_BUCKET_NAME") ?? "videos";

function getBasePublicUrl(): string {
  const baseUrl = readEnv(
    "BACKBLAZE_PUBLIC_URL",
    "BACKBLAZE_ENDPOINT",
    "RAILWAY_PUBLIC_URL",
    "RAILWAY_ENDPOINT",
  );
  if (!baseUrl) {
    throw new Error(
      "Missing BACKBLAZE_PUBLIC_URL or BACKBLAZE_ENDPOINT for bucket URLs",
    );
  }
  return baseUrl;
}

export function buildPublicUrl(key: string): string {
  const includeBucketFlag = readEnv(
    "BACKBLAZE_PUBLIC_URL_INCLUDE_BUCKET",
    "RAILWAY_PUBLIC_URL_INCLUDE_BUCKET",
  );
  const includeBucket = includeBucketFlag !== "false";
  const url = new URL(getBasePublicUrl());
  const basePath = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  const objectPath = includeBucket ? `${BUCKET_NAME}/${key}` : key;
  url.pathname = `${basePath}/${objectPath}`;
  return url.toString();
}

export function getS3Client(): S3Client {
  const accessKeyId = readEnv(
    "BACKBLAZE_ACCESS_KEY_ID",
    "RAILWAY_ACCESS_KEY_ID",
  );
  const secretAccessKey = readEnv(
    "BACKBLAZE_SECRET_ACCESS_KEY",
    "RAILWAY_SECRET_ACCESS_KEY",
  );

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing BACKBLAZE S3 credentials");
  }

  return new S3Client({
    region:
      readEnv("BACKBLAZE_REGION", "RAILWAY_REGION") ?? "us-west-004",
    endpoint: readEnv("BACKBLAZE_ENDPOINT", "RAILWAY_ENDPOINT"),
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle: true,
  });
}
