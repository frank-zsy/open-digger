/**
 * Export repo-level dependency relationships from the packages PostgreSQL database
 * (ecosyste.ms style: packages / versions / dependencies / registries) into ClickHouse.
 *
 * For every package whose repository_url belongs to GitHub / GitLab / Gitee / AtomGit,
 * we resolve each of its dependencies to a package on the same 4 platforms and compute
 * the dependency lifetime:
 *   - start_time: published_at of the earliest version that declares the dependency.
 *   - end_time:   published_at of the first version released AFTER the last version
 *                 that declares the dependency (i.e. when it was removed). NULL means
 *                 the dependency is still present in the latest release.
 *
 * All dependency kinds are kept (runtime, Development, dev, test, ...).
 *
 * Architecture (the dependencies table has 1.8B rows, so random per-package index
 * access does NOT scale; everything is streamed by sequential version-id ranges and
 * all heavy aggregations/joins are pushed down to ClickHouse):
 *   Phase A: scan packages once, parse repository_url, load platform packages into
 *            ClickHouse table `repo_dep_packages` (and an in-memory id set).
 *   Phase B: scan versions + dependencies by [id, id + VERSION_RANGE) ranges,
 *            pre-aggregate per (package, dep, kind) within each range in JS, and
 *            stream partials into `repo_dep_package_versions` / `repo_dep_ranges_raw`.
 *   Phase C (finalize): one INSERT SELECT in ClickHouse merges partials, computes
 *            removal time via version timelines, resolves both edge ends to platform
 *            repos and aggregates monorepo packages into repo-level edges.
 *
 * Usage:
 *   POSTGRES_URL=postgres://user:pass@host:5432/packages_production npm run build
 *   node lib/scripts/exportRepoDependencies.js             # full export + finalize
 *   node lib/scripts/exportRepoDependencies.js finalize    # only run finalize
 *   node lib/scripts/exportRepoDependencies.js enrich      # fill repo_id/dep_repo_id from events
 *   FROM_VERSION_ID=123456 node lib/scripts/exportRepoDependencies.js  # resume Phase B
 */
import { Client as PgClient } from 'pg';
import { getNewClient, insertRecords, queryStream } from '../db/clickhouse';
import getConfig from '../config';
import { getLogger } from '../utils';

const logger = getLogger('ExportRepoDependencies');

const PACKAGES_TABLE = 'repo_dep_packages';
const VERSIONS_TABLE = 'repo_dep_package_versions';
const RANGES_TABLE = 'repo_dep_ranges_raw';
const NAME_MAP_TABLE = 'repo_dep_name_id_map';
const FINAL_TABLE = 'repo_dependencies';

// Batch size of source packages per iteration in Phase A.
const PKG_BATCH_SIZE = parseInt(process.env.PKG_BATCH_SIZE ?? '2000', 10);
// Size of the version-id range per iteration in Phase B.
const VERSION_RANGE = parseInt(process.env.VERSION_RANGE ?? '50000', 10);
// Flush buffered rows into ClickHouse when reaching this size.
const FLUSH_SIZE = 50000;

// Note: platform names are case-sensitive and must match the ClickHouse events table.
const PLATFORM_HOSTS: Array<{ host: string, platform: string }> = [
  { host: 'github.com', platform: 'GitHub' },
  { host: 'gitlab.com', platform: 'GitLab' },
  { host: 'gitee.com', platform: 'Gitee' },
  { host: 'atomgit.com', platform: 'AtomGit' },
];

interface RepoRef {
  platform: string;
  repoName: string;
}

/**
 * Parse an author-provided repository URL into (platform, owner/repo).
 * Handles forms like:
 *   https://github.com/owner/repo(.git), git+https://github.com/owner/repo.git,
 *   git://github.com/owner/repo, ssh://git@github.com/owner/repo,
 *   git@github.com:owner/repo.git, http://www.github.com/owner/repo/tree/main
 * GitLab keeps the full (sub)group path, other platforms keep owner/repo only.
 */
export function parseRepoUrl(rawUrl: string): RepoRef | null {
  if (!rawUrl) return null;
  let url = rawUrl.trim();
  // strip common prefixes
  url = url.replace(/^git\+/i, '');
  // scp-like syntax: git@host:path
  const scpMatch = url.match(/^(?:[\w.-]+@)([\w.-]+):(.+)$/);
  if (scpMatch && !url.includes('://')) {
    url = `https://${scpMatch[1]}/${scpMatch[2]}`;
  }
  // strip protocol
  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // strip credentials
  url = url.replace(/^[^/@]+@/, '');
  // strip query string / fragment
  url = url.split('?')[0].split('#')[0];
  const parts = url.split('/').filter(p => p.length > 0);
  if (parts.length < 3) return null;
  const host = parts[0].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const platformEntry = PLATFORM_HOSTS.find(p => p.host === host);
  if (!platformEntry) return null;
  let pathParts = parts.slice(1);
  if (platformEntry.platform === 'GitLab') {
    // GitLab supports subgroups, keep full path but cut web sub-paths
    const cutIndex = pathParts.findIndex(p => p === '-' || p === 'tree' || p === 'blob' || p === 'raw');
    if (cutIndex >= 0) pathParts = pathParts.slice(0, cutIndex);
  } else {
    pathParts = pathParts.slice(0, 2);
  }
  if (pathParts.length < 2) return null;
  const last = pathParts[pathParts.length - 1].replace(/\.git$/i, '');
  if (!last) return null;
  pathParts[pathParts.length - 1] = last;
  const repoName = pathParts.join('/');
  // basic sanity check
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repoName)) return null;
  return { platform: platformEntry.platform, repoName };
}

// ClickHouse DateTime valid range guard.
const MIN_EPOCH = 0; // 1970-01-01
const MAX_EPOCH = 4102444800; // 2100-01-01

function formatEpoch(epochSeconds: number): string {
  const sec = Math.min(Math.max(epochSeconds, MIN_EPOCH), MAX_EPOCH);
  return new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

(async () => {
  const config = await getConfig();
  const chClient = await getNewClient();
  const startTime = Date.now();
  const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(0)}s`;

  const createTables = async (recreateStaging: boolean) => {
    if (recreateStaging) {
      for (const t of [PACKAGES_TABLE, VERSIONS_TABLE, RANGES_TABLE]) {
        await chClient.command({ query: `DROP TABLE IF EXISTS ${t}` });
      }
    }
    await chClient.command({
      query: `CREATE TABLE IF NOT EXISTS ${PACKAGES_TABLE} (
  package_id UInt32,
  ecosystem LowCardinality(String),
  name String,
  platform LowCardinality(String),
  repo_name String
) ENGINE = MergeTree ORDER BY package_id`,
    });
    await chClient.command({
      query: `CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (
  package_id UInt32,
  published_at DateTime
) ENGINE = MergeTree ORDER BY package_id`,
    });
    await chClient.command({
      query: `CREATE TABLE IF NOT EXISTS ${RANGES_TABLE} (
  package_id UInt32,
  dep_ecosystem LowCardinality(String),
  dep_name String,
  kind LowCardinality(String),
  start_time DateTime,
  last_seen DateTime
) ENGINE = MergeTree ORDER BY (package_id, dep_ecosystem, dep_name, kind)`,
    });
    await chClient.command({
      query: `CREATE TABLE IF NOT EXISTS ${FINAL_TABLE} (
  platform LowCardinality(String),
  repo_name String,
  repo_id UInt64 DEFAULT 0,
  dep_platform LowCardinality(String),
  dep_repo_name String,
  dep_repo_id UInt64 DEFAULT 0,
  kind LowCardinality(String),
  ecosystem LowCardinality(String),
  start_time DateTime,
  end_time Nullable(DateTime)
) ENGINE = ReplacingMergeTree ORDER BY (platform, repo_name, dep_platform, dep_repo_name, ecosystem, kind)`,
    });
  };

  // Phase C: merge range partials, compute removal time from version timelines and
  // aggregate package-level edges into repo-level edges (monorepo packages merged:
  // min(start); end is NULL if any package still declares the dependency).
  const finalize = async () => {
    logger.info(`[${elapsed()}] Finalizing: aggregating partials into ${FINAL_TABLE}...`);
    await chClient.command({ query: `TRUNCATE TABLE ${FINAL_TABLE}` });
    await chClient.command({
      query: `INSERT INTO ${FINAL_TABLE} (platform, repo_name, dep_platform, dep_repo_name, kind, ecosystem, start_time, end_time)
SELECT
  sp.platform AS platform,
  sp.repo_name AS repo_name,
  tp.platform AS dep_platform,
  tp.repo_name AS dep_repo_name,
  e.kind AS kind,
  e.dep_ecosystem AS ecosystem,
  min(e.start_time) AS start_time,
  if(countIf(e.removal_time = toDateTime(0)) > 0, NULL, max(e.removal_time)) AS end_time
FROM (
  SELECT r.package_id AS package_id, r.dep_ecosystem AS dep_ecosystem, r.dep_name AS dep_name,
         r.kind AS kind, r.start_time AS start_time,
         arrayFirst(x -> x > r.last_seen, vt.times) AS removal_time
  FROM (
    SELECT package_id, dep_ecosystem, dep_name, kind,
           min(start_time) AS start_time, max(last_seen) AS last_seen
    FROM ${RANGES_TABLE}
    GROUP BY package_id, dep_ecosystem, dep_name, kind
  ) r
  INNER JOIN (
    SELECT package_id, arraySort(groupArray(published_at)) AS times
    FROM ${VERSIONS_TABLE} GROUP BY package_id
  ) vt ON vt.package_id = r.package_id
) e
INNER JOIN ${PACKAGES_TABLE} sp ON sp.package_id = e.package_id
INNER JOIN (
  SELECT ecosystem, name, platform, repo_name FROM ${PACKAGES_TABLE}
  ORDER BY package_id LIMIT 1 BY ecosystem, name
) tp ON tp.ecosystem = e.dep_ecosystem AND tp.name = e.dep_name
WHERE NOT (sp.platform = tp.platform AND sp.repo_name = tp.repo_name)
GROUP BY platform, repo_name, dep_platform, dep_repo_name, kind, ecosystem`,
      clickhouse_settings: {
        max_execution_time: 0,
        max_bytes_before_external_group_by: '16000000000',
        max_bytes_in_join: '0',
      } as any,
    });
    logger.info(`[${elapsed()}] Final table ${FINAL_TABLE} is ready. Staging tables ${PACKAGES_TABLE}/${VERSIONS_TABLE}/${RANGES_TABLE} can be dropped manually.`);
  };

  // Enrich: fill repo_id / dep_repo_id by joining the events table. Repo URLs are
  // author-typed so the join is case-insensitive; for renamed/reused names the most
  // recent repo_id owning that name wins (argMax by created_at). Unmatched stays 0.
  const enrich = async () => {
    // Existing tables exported by older versions may not have the id columns yet.
    await chClient.command({ query: `ALTER TABLE ${FINAL_TABLE} ADD COLUMN IF NOT EXISTS repo_id UInt64 DEFAULT 0 AFTER repo_name` });
    await chClient.command({ query: `ALTER TABLE ${FINAL_TABLE} ADD COLUMN IF NOT EXISTS dep_repo_id UInt64 DEFAULT 0 AFTER dep_repo_name` });

    logger.info(`[${elapsed()}] Enrich: collecting repo names referenced by ${FINAL_TABLE}...`);
    // Restrict the name->id map to names actually referenced by the dependency edges
    // (a few million) instead of every repo ever seen in events (hundreds of millions),
    // otherwise the JOIN hash table blows past the server memory limit.
    const neededTable = `${NAME_MAP_TABLE}_needed`;
    await chClient.command({ query: `DROP TABLE IF EXISTS ${neededTable}` });
    await chClient.command({
      query: `CREATE TABLE ${neededTable} ENGINE = MergeTree ORDER BY (platform, name_lower) AS
SELECT DISTINCT platform, lower(repo_name) AS name_lower FROM ${FINAL_TABLE}
UNION DISTINCT
SELECT DISTINCT dep_platform AS platform, lower(dep_repo_name) AS name_lower FROM ${FINAL_TABLE}`,
      clickhouse_settings: { max_execution_time: 0 } as any,
    });

    logger.info(`[${elapsed()}] Enrich: building (platform, repo_name) -> repo_id map from events...`);
    await chClient.command({ query: `DROP TABLE IF EXISTS ${NAME_MAP_TABLE}` });
    await chClient.command({
      query: `CREATE TABLE ${NAME_MAP_TABLE} ENGINE = MergeTree ORDER BY (platform, name_lower) AS
SELECT platform, lower(repo_name) AS name_lower, argMax(repo_id, created_at) AS repo_id
FROM events
WHERE (platform, lower(repo_name)) IN (SELECT platform, name_lower FROM ${neededTable})
GROUP BY platform, name_lower`,
      clickhouse_settings: {
        max_execution_time: 0,
        max_bytes_before_external_group_by: '16000000000',
      } as any,
    });
    await chClient.command({ query: `DROP TABLE ${neededTable}` });

    logger.info(`[${elapsed()}] Enrich: rebuilding ${FINAL_TABLE} with repo ids...`);
    const tmpTable = `${FINAL_TABLE}_enriched_tmp`;
    await chClient.command({ query: `DROP TABLE IF EXISTS ${tmpTable}` });
    await chClient.command({ query: `CREATE TABLE ${tmpTable} AS ${FINAL_TABLE}` });
    await chClient.command({
      query: `INSERT INTO ${tmpTable}
SELECT
  d.platform AS platform,
  d.repo_name AS repo_name,
  m1.repo_id AS repo_id,
  d.dep_platform AS dep_platform,
  d.dep_repo_name AS dep_repo_name,
  m2.repo_id AS dep_repo_id,
  d.kind AS kind,
  d.ecosystem AS ecosystem,
  d.start_time AS start_time,
  d.end_time AS end_time
FROM ${FINAL_TABLE} d
LEFT JOIN ${NAME_MAP_TABLE} m1 ON m1.platform = d.platform AND m1.name_lower = lower(d.repo_name)
LEFT JOIN ${NAME_MAP_TABLE} m2 ON m2.platform = d.dep_platform AND m2.name_lower = lower(d.dep_repo_name)`,
      clickhouse_settings: {
        max_execution_time: 0,
        max_bytes_in_join: '0',
        // spill to disk instead of failing if the hash table still grows too large
        join_algorithm: 'grace_hash',
        grace_hash_join_initial_buckets: 8,
      } as any,
    });
    await chClient.command({ query: `EXCHANGE TABLES ${FINAL_TABLE} AND ${tmpTable}` });
    await chClient.command({ query: `DROP TABLE ${tmpTable}` });
    await chClient.command({ query: `DROP TABLE ${NAME_MAP_TABLE}` });

    const stats: any[] = [];
    await queryStream(
      `SELECT count(), countIf(repo_id != 0), countIf(dep_repo_id != 0) FROM ${FINAL_TABLE}`,
      (row: any) => stats.push(row));
    const [total, srcMatched, depMatched] = stats[0];
    logger.info(`[${elapsed()}] Enrich done: ${total} edges, source repo_id matched ${srcMatched} (${(srcMatched / total * 100).toFixed(1)}%), dep repo_id matched ${depMatched} (${(depMatched / total * 100).toFixed(1)}%).`);
  };

  const fromVersionId = parseInt(process.env.FROM_VERSION_ID ?? '0', 10);
  const isResume = fromVersionId > 0;
  await createTables(!isResume && process.argv[2] !== 'finalize' && process.argv[2] !== 'enrich');

  if (process.argv[2] === 'finalize') {
    await finalize();
    await chClient.close();
    return;
  }
  if (process.argv[2] === 'enrich') {
    await enrich();
    await chClient.close();
    return;
  }

  if (!config.db.postgres.url) {
    logger.error('POSTGRES_URL is not set, exiting.');
    process.exit(1);
  }
  const pg = new PgClient({ connectionString: config.db.postgres.url });
  await pg.connect();
  await pg.query('SET statement_timeout = 0');
  // Repeated small indexed queries do not benefit from JIT compilation overhead.
  await pg.query('SET jit = off');

  // ---------- Phase A: platform packages ----------
  const platformPkgIds = new Set<number>();
  const urlFilter = PLATFORM_HOSTS.map(p => `lower(repository_url) LIKE '%${p.host}%'`).join(' OR ');

  if (isResume) {
    logger.info(`Resuming from version id ${fromVersionId}, loading platform package ids from ClickHouse...`);
    await queryStream(`SELECT package_id FROM ${PACKAGES_TABLE}`, (row: any) => platformPkgIds.add(+row[0]));
    logger.info(`[${elapsed()}] Loaded ${platformPkgIds.size} platform packages from ${PACKAGES_TABLE}.`);
  } else {
    logger.info('Phase A: scanning packages for platform repository URLs...');
    let pkgBuffer: any[] = [];
    let lastPkgId = 0;
    let scanned = 0;
    for (; ;) {
      const res = await pg.query(
        `SELECT id, name, ecosystem, repository_url FROM packages
         WHERE id > $1 AND repository_url IS NOT NULL AND repository_url <> '' AND (${urlFilter})
         ORDER BY id LIMIT $2`,
        [lastPkgId, PKG_BATCH_SIZE]);
      if (res.rows.length === 0) break;
      lastPkgId = +res.rows[res.rows.length - 1].id;
      scanned += res.rows.length;
      for (const row of res.rows) {
        const repo = parseRepoUrl(row.repository_url);
        if (!repo) continue;
        platformPkgIds.add(+row.id);
        pkgBuffer.push({
          package_id: +row.id,
          ecosystem: row.ecosystem,
          name: row.name,
          platform: repo.platform,
          repo_name: repo.repoName,
        });
      }
      if (pkgBuffer.length >= FLUSH_SIZE) {
        await insertRecords(pkgBuffer, PACKAGES_TABLE);
        pkgBuffer = [];
      }
      if (scanned % 500000 < PKG_BATCH_SIZE) {
        logger.info(`[${elapsed()}] Phase A: scanned ${scanned} packages, last id ${lastPkgId}, parsed ${platformPkgIds.size}.`);
      }
    }
    await insertRecords(pkgBuffer, PACKAGES_TABLE);
    logger.info(`[${elapsed()}] Phase A done: ${platformPkgIds.size} platform packages loaded into ${PACKAGES_TABLE}.`);
  }

  // ---------- Phase B: sequential range scan over versions & dependencies ----------
  const maxVersionId = +(await pg.query('SELECT max(id) AS max_id FROM versions')).rows[0].max_id;
  logger.info(`Phase B: scanning version ranges up to ${maxVersionId} (range size ${VERSION_RANGE})...`);

  let versionBuffer: any[] = [];
  let rangeBuffer: any[] = [];
  let totalVersions = 0;
  let totalDepRows = 0;
  let totalPartials = 0;

  const flush = async (force = false) => {
    if (versionBuffer.length >= FLUSH_SIZE || (force && versionBuffer.length > 0)) {
      await insertRecords(versionBuffer, VERSIONS_TABLE);
      versionBuffer = [];
    }
    if (rangeBuffer.length >= FLUSH_SIZE || (force && rangeBuffer.length > 0)) {
      totalPartials += rangeBuffer.length;
      await insertRecords(rangeBuffer, RANGES_TABLE);
      rangeBuffer = [];
    }
  };

  let batchCount = 0;
  for (let rangeStart = fromVersionId; rangeStart <= maxVersionId; rangeStart += VERSION_RANGE) {
    const rangeEnd = rangeStart + VERSION_RANGE;

    // 1. versions in range (only platform packages kept, filtered in JS via the id set)
    const verRes = await pg.query(
      `SELECT id, package_id, extract(epoch FROM published_at)::bigint AS epoch
       FROM versions WHERE id >= $1 AND id < $2 AND published_at IS NOT NULL`,
      [rangeStart, rangeEnd]);
    // version id -> { pkgId, epoch }
    const versionInfo = new Map<number, { pkgId: number, epoch: number }>();
    for (const row of verRes.rows) {
      const pkgId = +row.package_id;
      if (!platformPkgIds.has(pkgId)) continue;
      versionInfo.set(+row.id, { pkgId, epoch: +row.epoch });
      versionBuffer.push({ package_id: pkgId, published_at: formatEpoch(+row.epoch) });
    }
    totalVersions += versionInfo.size;

    if (versionInfo.size > 0) {
      // 2. all dependency rows in the same id range (single contiguous index range
      //    scan; per-package random access over the 1.8B-row table does not scale)
      const depRes = await pg.query(
        `SELECT version_id, ecosystem AS dep_ecosystem, package_name AS dep_name, COALESCE(kind, '') AS kind
         FROM dependencies WHERE version_id >= $1 AND version_id < $2`,
        [rangeStart, rangeEnd]);
      totalDepRows += depRes.rows.length;

      // 3. pre-aggregate per (package, dep, kind) within this range
      const partials = new Map<string, { pkgId: number, depEcosystem: string, depName: string, kind: string, start: number, lastSeen: number }>();
      for (const row of depRes.rows) {
        const ver = versionInfo.get(+row.version_id);
        if (!ver) continue;
        if (!row.dep_name || row.dep_name === ':' || row.dep_name.includes('${')) continue;
        const key = `${ver.pkgId}\n${row.dep_ecosystem}\n${row.dep_name}\n${row.kind}`;
        const range = partials.get(key);
        if (!range) {
          partials.set(key, {
            pkgId: ver.pkgId, depEcosystem: row.dep_ecosystem, depName: row.dep_name,
            kind: row.kind, start: ver.epoch, lastSeen: ver.epoch,
          });
        } else {
          if (ver.epoch < range.start) range.start = ver.epoch;
          if (ver.epoch > range.lastSeen) range.lastSeen = ver.epoch;
        }
      }
      for (const p of partials.values()) {
        rangeBuffer.push({
          package_id: p.pkgId,
          dep_ecosystem: p.depEcosystem,
          dep_name: p.depName,
          kind: p.kind,
          start_time: formatEpoch(p.start),
          last_seen: formatEpoch(p.lastSeen),
        });
      }
    }
    await flush();

    batchCount++;
    if (batchCount % 10 === 0) {
      const pct = ((rangeEnd - fromVersionId) / (maxVersionId - fromVersionId) * 100).toFixed(1);
      logger.info(`[${elapsed()}] Phase B: version id ${rangeEnd} (${pct}%), platform versions ${totalVersions}, dep rows ${totalDepRows}, partials ${totalPartials + rangeBuffer.length}. Resume with FROM_VERSION_ID=${rangeEnd}.`);
    }
  }
  await flush(true);
  logger.info(`[${elapsed()}] Phase B done: ${totalVersions} versions, ${totalDepRows} dependency rows, ${totalPartials} partials.`);
  await pg.end();

  // ---------- Phase C ----------
  await finalize();
  await enrich();
  await chClient.close();
})();
