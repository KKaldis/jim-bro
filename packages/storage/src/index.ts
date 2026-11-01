// @fa/storage — object storage (MinIO / S3-compatible) for the original
// reference files behind the knowledge base. See packages/db_qdrant for the
// vector index that points at these objects.
export {
  storage,
  bucketName,
  ensureBucket,
  putObject,
  getObject,
  objectExists,
  removeObject,
  presignGet,
  publicUrl,
  type StoredObject,
} from "./client.ts";
