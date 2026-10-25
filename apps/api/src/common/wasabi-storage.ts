// Wasabi (S3-compatible) object storage for token + chain logos.
//
// Layout (one file per entity, human-readable):
//   public/tokens/<SYMBOL>.png    — global token logo
//   public/chains/<ns>-<ref>.png  — chain logo
// The DB stores the object key; readers get the API logo-proxy URL (the
// Wasabi account blocks public bucket reads) — no signed URLs, no secrets.
// Reads never need credentials (fail-open to `logoUrl: null`); uploads throw
// when WASABI_* env is missing.
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const TOKEN_LOGO_PREFIX = "public/tokens";
export const CHAIN_LOGO_PREFIX = "public/chains";
const LOGO_MAX_BYTES = 512 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** EVM addresses lowercase; Solana base58 is case-sensitive — keep as-is. */
export function normalizeMint(namespace: string, mint: string): string {
  return namespace === "eip155" ? mint.toLowerCase() : mint;
}

export function extForMime(mimetype: string): string | null {
  return MIME_EXT[mimetype] ?? null;
}

/** Global token logo key: one file per symbol (`public/tokens/USDC.png`). */
export function tokenLogoKey(symbol: string, ext: string): string {
  const safe = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 24);
  return `${TOKEN_LOGO_PREFIX}/${safe}.${ext}`;
}

/** Chain logo key: one file per chain (`public/chains/eip155-97.png`). */
export function chainLogoKey(namespace: string, reference: string, ext: string): string {
  const safeRef = reference.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `${CHAIN_LOGO_PREFIX}/${namespace}-${safeRef}.${ext}`;
}

/** API logo-proxy URL for a stored key (same shape the registry serves). */
export function proxyLogoUrl(apiBase: string, key: string): string | null {
  if (!apiBase) return null;
  return `${apiBase.replace(/\/+$/, "")}/v1/tokens/logo?key=${encodeURIComponent(key)}`;
}

export function logoPublicUrl(endpoint: string, bucket: string, key: string): string {
  return `${endpoint.replace(/\/+$/, "")}/${bucket}/${key}`;
}

export interface UploadFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

@Injectable()
export class WasabiStorageService {
  private client: S3Client | null = null;

  constructor(@Optional() private readonly config?: ConfigService) {}

  private env(name: string): string {
    const v = (this.config?.get<string>(name) ?? process.env[name] ?? "").trim();
    return v;
  }

  private settings(): { endpoint: string; region: string; bucket: string; access: string; secret: string } {
    const s = {
      endpoint: this.env("WASABI_ENDPOINT"),
      region: this.env("WASABI_REGION") || "ap-southeast-1",
      bucket: this.env("WASABI_BUCKET_NAME"),
      access: this.env("WASABI_ACCESS_KEY"),
      secret: this.env("WASABI_SECRET_KEY"),
    };
    if (!s.endpoint || !s.bucket || !s.access || !s.secret) {
      throw new Error("Wasabi storage is not configured (WASABI_ENDPOINT/BUCKET_NAME/ACCESS_KEY/SECRET_KEY)");
    }
    return s;
  }

  private s3(): { client: S3Client; bucket: string } {
    const s = this.settings();
    if (!this.client) {
      this.client = new S3Client({
        endpoint: s.endpoint,
        region: s.region,
        credentials: { accessKeyId: s.access, secretAccessKey: s.secret },
        forcePathStyle: true,
      });
    }
    return { client: this.client, bucket: s.bucket };
  }

  /** Public URL for a stored key. Throws when endpoint/bucket are missing. */
  logoUrl(key: string): string {
    const endpoint = this.env("WASABI_ENDPOINT");
    const bucket = this.env("WASABI_BUCKET_NAME");
    if (!endpoint || !bucket) throw new Error("Wasabi storage is not configured");
    return logoPublicUrl(endpoint, bucket, key);
  }

  /** Upload a token logo, returning the object key for the token row. */
  async putTokenLogo(symbol: string, file: UploadFile): Promise<string> {
    return this.putImage(tokenLogoKey(symbol, this.checkedExt(file)), file);
  }

  /** Upload a chain logo, returning the object key (stored as proxy URL). */
  async putChainLogo(namespace: string, reference: string, file: UploadFile): Promise<string> {
    return this.putImage(chainLogoKey(namespace, reference, this.checkedExt(file)), file);
  }

  private checkedExt(file: UploadFile): string {
    const ext = extForMime(file.mimetype);
    if (!ext) throw new Error("Logo must be PNG, JPEG, or WebP");
    if (file.size > LOGO_MAX_BYTES || file.buffer.length > LOGO_MAX_BYTES) {
      throw new Error("Logo must be 512KB or smaller");
    }
    return ext;
  }

  private async putImage(key: string, file: UploadFile): Promise<string> {
    const { client, bucket } = this.s3();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return key;
  }

  /**
   * Move a logo object (symbol renames keep the tidy key). Copy first, delete
   * after — a failed copy never orphans the original.
   */
  async moveLogo(fromKey: string, toKey: string): Promise<void> {
    for (const key of [fromKey, toKey]) {
      if (!key.startsWith(`${TOKEN_LOGO_PREFIX}/`) && !key.startsWith(`${CHAIN_LOGO_PREFIX}/`)) {
        throw new Error("Unknown logo");
      }
    }
    const { client, bucket } = this.s3();
    await client.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${fromKey}`, Key: toKey }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
  }

  /**
   * Stream a public logo (proxy — the account currently blocks public
   * bucket reads, so wallets load logos through the API, not Wasabi
   * directly). Key locked to the logo prefixes + image ext: anything else is
   * refused, so callers can never pull arbitrary bucket objects.
   */
  async getLogo(key: string): Promise<{ bytes: Buffer; contentType: string }> {
    if (!key.startsWith(`${TOKEN_LOGO_PREFIX}/`) && !key.startsWith(`${CHAIN_LOGO_PREFIX}/`)) {
      throw new Error("Unknown logo");
    }
    const ext = key.split(".").pop()?.toLowerCase();
    const contentType =
      ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : null;
    if (!contentType) throw new Error("Unknown logo");
    const { client, bucket } = this.s3();
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = out.Body ? Buffer.from(await out.Body.transformToByteArray()) : Buffer.alloc(0);
    if (bytes.length === 0) throw new Error("Unknown logo");
    return { bytes, contentType };
  }
}
