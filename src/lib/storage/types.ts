// Storage API shape shared by the server implementation
// (storage/server.ts) and the browser client (storage/client.ts).

export interface StorageError {
  message: string;
  statusCode?: string;
}

export interface FileOptions {
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
}

export interface StorageBucketApi {
  upload(
    path: string,
    body: Blob | ArrayBuffer | ArrayBufferView | Buffer,
    opts?: FileOptions,
  ): Promise<{ data: { path: string; fullPath: string } | null; error: StorageError | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  remove(paths: string[]): Promise<{ data: { name: string }[] | null; error: StorageError | null }>;
}

export interface StorageApi {
  from(bucket: string): StorageBucketApi;
}
