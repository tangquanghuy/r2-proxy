import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_CONCURRENCY = 8;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    bucket: process.env.R2_BUCKET || "",
    prefix: process.env.R2_PREFIX || "",
    cacheControl: process.env.CACHE_CONTROL || DEFAULT_CACHE_CONTROL,
    concurrency: Number(process.env.CONCURRENCY || DEFAULT_CONCURRENCY),
    dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
    verbose: process.env.VERBOSE === "1" || process.env.VERBOSE === "true",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bucket") args.bucket = argv[++i] || "";
    else if (arg === "--prefix") args.prefix = argv[++i] || "";
    else if (arg === "--cache-control") args.cacheControl = argv[++i] || "";
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i] || DEFAULT_CONCURRENCY);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) {
    throw new Error(`Invalid concurrency: ${args.concurrency}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/backfill-cache-control.mjs --bucket <bucket> [--prefix <prefix>] [--cache-control "<value>"] [--concurrency 8] [--dry-run]

Required env vars:
  R2_ACCOUNT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY

Optional env vars:
  R2_BUCKET
  R2_PREFIX
  CACHE_CONTROL
  CONCURRENCY
  DRY_RUN=1
  VERBOSE=1
`);
}

function createClient() {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function* listKeys(client, bucket, prefix) {
  let continuationToken;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of page.Contents || []) {
      if (item.Key) yield item.Key;
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

function encodeCopySource(bucket, key) {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function updateOne(client, bucket, key, cacheControl, dryRun) {
  const head = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  if (head.CacheControl === cacheControl) {
    return { key, status: "skip" };
  }

  if (dryRun) {
    return {
      key,
      status: "dry-run",
      before: head.CacheControl || "",
      after: cacheControl,
    };
  }

  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: encodeCopySource(bucket, key),
      MetadataDirective: "REPLACE",
      ContentType: head.ContentType,
      CacheControl: cacheControl,
      ContentDisposition: head.ContentDisposition,
      ContentEncoding: head.ContentEncoding,
      ContentLanguage: head.ContentLanguage,
      Expires: head.Expires,
      WebsiteRedirectLocation: head.WebsiteRedirectLocation,
    }),
  );

  return {
    key,
    status: "updated",
    before: head.CacheControl || "",
    after: cacheControl,
  };
}

async function runPool(items, concurrency, worker) {
  const executing = new Set();
  const results = [];

  for await (const item of items) {
    const task = Promise.resolve()
      .then(() => worker(item))
      .then((result) => {
        results.push(result);
      })
      .finally(() => {
        executing.delete(task);
      });

    executing.add(task);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.bucket) {
    throw new Error("Bucket is required. Pass --bucket or set R2_BUCKET.");
  }

  const client = createClient();
  console.log(
    JSON.stringify(
      {
        bucket: args.bucket,
        prefix: args.prefix,
        cacheControl: args.cacheControl,
        concurrency: args.concurrency,
        dryRun: args.dryRun,
        verbose: args.verbose,
      },
      null,
      2,
    ),
  );

  const summary = {
    scanned: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    wouldUpdate: 0,
    failed: 0,
  };

  const keyStream = (async function* stream() {
    for await (const key of listKeys(client, args.bucket, args.prefix)) {
      summary.scanned += 1;
      yield key;
    }
  })();

  const results = await runPool(keyStream, args.concurrency, async (key) => {
    try {
      const result = await updateOne(client, args.bucket, key, args.cacheControl, args.dryRun);
      summary.processed += 1;
      if (result.status === "updated") summary.updated += 1;
      else if (result.status === "skip") summary.skipped += 1;
      else if (result.status === "dry-run") summary.wouldUpdate += 1;

      if (args.verbose) {
        console.log(`${result.status.toUpperCase()} ${key}`);
      } else if (summary.processed % 100 === 0) {
        console.log(
          `Progress: ${summary.processed}/${summary.scanned} processed, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.wouldUpdate} would-update, ${summary.failed} failed`,
        );
      }
      return result;
    } catch (error) {
      summary.processed += 1;
      summary.failed += 1;
      console.error(`FAILED ${key}: ${error.message}`);
      return { key, status: "failed", error: error.message };
    }
  });

  console.log("");
  console.log(JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    process.exitCode = 1;
  }

  return results;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
