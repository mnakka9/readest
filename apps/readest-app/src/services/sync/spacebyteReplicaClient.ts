import { v4 as uuidv4 } from 'uuid';
import { hlcCompare, hlcMax, mergeFields } from '@/libs/crdt';
import { SyncError } from '@/libs/errors';
import type { ReplicaKeyRow } from '@/libs/replicaSyncClient';
import { createFileSyncProvider } from '@/services/sync/file/providerRegistry';
import type { FileSyncProvider } from '@/services/sync/file/provider';
import { useSettingsStore } from '@/store/settingsStore';
import type { Hlc, ReplicaRow } from '@/types/replica';

const REPLICAS_DIR = '/Readest/replicas';
const REPLICA_KEYS_PATH = `${REPLICAS_DIR}/replica-keys.json`;

const rowPath = (kind: string, replicaId: string): string =>
  `${REPLICAS_DIR}/${encodeURIComponent(kind)}/${encodeURIComponent(replicaId)}.json`;

const kindPath = (kind: string): string => `${REPLICAS_DIR}/${encodeURIComponent(kind)}`;

export const isSpaceByteSyncConfigured = (): boolean => {
  const settings = useSettingsStore.getState().settings;
  return !!(
    settings.spacebyte?.enabled &&
    settings.spacebyte.apiKey &&
    settings.spacebyte.rootFolderId
  );
};

export const getSpaceByteSyncUserId = (): string | null => {
  const folderId = useSettingsStore.getState().settings.spacebyte?.rootFolderId;
  return folderId ? `spacebyte:${folderId}` : null;
};

export const getSpaceByteFileProvider = async (): Promise<FileSyncProvider> => {
  const settings = useSettingsStore.getState().settings;
  const provider = await createFileSyncProvider('spacebyte', settings);
  if (!provider) throw new SyncError('AUTH', 'SpaceByte sync is not configured');
  return provider;
};

const mergeReplicaRows = (current: ReplicaRow, incoming: ReplicaRow): ReplicaRow => {
  const fields_jsonb = mergeFields(current.fields_jsonb, incoming.fields_jsonb);
  const deleted_at_ts = hlcMax(current.deleted_at_ts, incoming.deleted_at_ts);
  const updated_at_ts =
    hlcMax(current.updated_at_ts, incoming.updated_at_ts) ?? incoming.updated_at_ts;

  const newest =
    hlcCompare(incoming.updated_at_ts, current.updated_at_ts) >= 0 ? incoming : current;
  const reincarnation =
    newest.reincarnation && (!deleted_at_ts || hlcCompare(newest.updated_at_ts, deleted_at_ts) > 0)
      ? newest.reincarnation
      : null;

  return {
    user_id: incoming.user_id,
    kind: incoming.kind,
    replica_id: incoming.replica_id,
    fields_jsonb,
    manifest_jsonb:
      incoming.manifest_jsonb === null
        ? current.manifest_jsonb
        : current.manifest_jsonb === null
          ? incoming.manifest_jsonb
          : newest.manifest_jsonb,
    deleted_at_ts,
    reincarnation,
    updated_at_ts,
    schema_version: Math.max(current.schema_version, incoming.schema_version),
  };
};

const parseRow = (raw: string | null): ReplicaRow | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReplicaRow;
  } catch {
    return null;
  }
};

export class SpaceByteReplicaSyncClient {
  private writeChain: Promise<void> = Promise.resolve();

  async push(rows: ReplicaRow[]): Promise<ReplicaRow[]> {
    if (rows.length === 0) return [];
    const result: ReplicaRow[] = [];
    await this.withWriteLock(async () => {
      const provider = await getSpaceByteFileProvider();
      for (const row of rows) {
        const path = rowPath(row.kind, row.replica_id);
        await provider.ensureDir([REPLICAS_DIR, kindPath(row.kind)]);
        const current = parseRow(await provider.readText(path));
        const merged = current ? mergeReplicaRows(current, row) : row;
        await provider.writeText(path, JSON.stringify(merged));
        result.push(merged);
      }
    });
    return result;
  }

  async pull(kind: string, since: Hlc | null): Promise<ReplicaRow[]> {
    const provider = await getSpaceByteFileProvider();
    const entries = await provider.list(kindPath(kind));
    const rows = await Promise.all(
      entries
        .filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
        .map(async (entry) => parseRow(await provider.readText(entry.path))),
    );
    return rows
      .filter((row): row is ReplicaRow => !!row)
      .filter((row) => !since || hlcCompare(row.updated_at_ts, since) > 0)
      .sort((a, b) => hlcCompare(a.updated_at_ts, b.updated_at_ts));
  }

  async pullBatch(
    cursors: { kind: string; since: Hlc | null }[],
  ): Promise<{ kind: string; rows: ReplicaRow[] }[]> {
    return Promise.all(
      cursors.map(async ({ kind, since }) => ({ kind, rows: await this.pull(kind, since) })),
    );
  }

  async listReplicaKeys(): Promise<ReplicaKeyRow[]> {
    const provider = await getSpaceByteFileProvider();
    const raw = await provider.readText(REPLICA_KEYS_PATH);
    if (!raw) return [];
    try {
      const rows = JSON.parse(raw) as ReplicaKeyRow[];
      return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  async createReplicaKey(alg: string): Promise<ReplicaKeyRow> {
    let created!: ReplicaKeyRow;
    await this.withWriteLock(async () => {
      const provider = await getSpaceByteFileProvider();
      const current = await this.listReplicaKeys();
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const salt = btoa(String.fromCharCode(...bytes));
      created = {
        saltId: uuidv4(),
        alg,
        salt,
        createdAt: new Date().toISOString(),
      };
      await provider.ensureDir([REPLICAS_DIR]);
      await provider.writeText(REPLICA_KEYS_PATH, JSON.stringify([created, ...current]));
    });
    return created;
  }

  async forgetReplicaKeys(): Promise<void> {
    await this.withWriteLock(async () => {
      const provider = await getSpaceByteFileProvider();
      await provider.deleteDir(REPLICA_KEYS_PATH);
    });
  }

  invalidateReplicaKeysCache(): void {}

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const spaceByteReplicaSyncClient = new SpaceByteReplicaSyncClient();
