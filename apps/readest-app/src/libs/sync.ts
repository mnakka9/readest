import { Book, BookConfig, BookNote, BookDataRecord } from '@/types/book';
import { getSpaceByteFileProvider } from '@/services/sync/spacebyteReplicaClient';

const SPACEBYTE_STATS_PATH = '/Readest/statistics.json';

export type SyncType = 'books' | 'configs' | 'notes' | 'stats';
export type SyncOp = 'push' | 'pull' | 'both';

interface BookRecord extends BookDataRecord, Book {}
interface BookConfigRecord extends BookDataRecord, BookConfig {}
interface BookNoteRecord extends BookDataRecord, BookNote {}

export interface StatBookRecord {
  user_id?: string;
  book_hash: string;
  title: string;
  authors: string;
  updated_at?: string;
  updated_at_ms?: number; // epoch ms, attached by the GET response for cursor math
  deleted_at?: string | null;
}

export interface StatPageRecord {
  user_id?: string;
  book_hash: string;
  page: number;
  start_time: number;
  duration: number;
  total_pages: number;
  ext?: unknown;
  updated_at?: string;
  updated_at_ms?: number; // epoch ms, attached by the GET response for cursor math
  deleted_at?: string | null;
}

export interface SyncResult {
  books: BookRecord[] | null;
  notes: BookNoteRecord[] | null;
  configs: BookConfigRecord[] | null;
  statBooks?: StatBookRecord[] | null;
  statPages?: StatPageRecord[] | null;
}

export type SyncRecord = BookRecord & BookConfigRecord & BookNoteRecord;

export interface SyncData {
  books?: Partial<BookRecord>[];
  notes?: Partial<BookNoteRecord>[];
  configs?: Partial<BookConfigRecord>[];
  statBooks?: StatBookRecord[];
  statPages?: StatPageRecord[];
}

const emptyResult = (): SyncResult => ({
  books: [],
  notes: [],
  configs: [],
  statBooks: [],
  statPages: [],
});

const readStats = async (): Promise<{
  statBooks: StatBookRecord[];
  statPages: StatPageRecord[];
}> => {
  const provider = await getSpaceByteFileProvider();
  const raw = await provider.readText(SPACEBYTE_STATS_PATH);
  if (!raw) return { statBooks: [], statPages: [] };
  try {
    const parsed = JSON.parse(raw) as {
      statBooks?: StatBookRecord[];
      statPages?: StatPageRecord[];
    };
    return {
      statBooks: parsed.statBooks ?? [],
      statPages: parsed.statPages ?? [],
    };
  } catch {
    return { statBooks: [], statPages: [] };
  }
};

export class SyncClient {
  private static writeChain: Promise<void> = Promise.resolve();

  /**
   * Pull incremental changes since a given timestamp (in ms).
   * Returns updated or deleted records since that time.
   */
  async pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    metaHash?: string,
    limit?: number,
  ): Promise<SyncResult> {
    void book;
    void metaHash;
    if (type !== 'stats') return emptyResult();
    const data = await readStats();
    const statPages = data.statPages
      .filter((record) => (record.updated_at_ms ?? 0) > since)
      .sort((a, b) => (a.updated_at_ms ?? 0) - (b.updated_at_ms ?? 0))
      .slice(0, limit && limit > 0 ? limit : undefined);
    const hashes = new Set(statPages.map((record) => record.book_hash));
    const statBooks = data.statBooks.filter((record) => hashes.has(record.book_hash));
    return { ...emptyResult(), statBooks, statPages };
  }

  /**
   * Push local changes to the server.
   * Uses last-writer-wins logic as implemented on the server side.
   */
  async pushChanges(payload: SyncData): Promise<SyncResult> {
    if (!payload.statBooks?.length && !payload.statPages?.length) return emptyResult();
    const previous = SyncClient.writeChain;
    let release!: () => void;
    SyncClient.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const provider = await getSpaceByteFileProvider();
      const current = await readStats();
      const now = Date.now();
      const books = new Map(current.statBooks.map((record) => [record.book_hash, record]));
      for (const record of payload.statBooks ?? []) {
        books.set(record.book_hash, { ...record, updated_at_ms: now });
      }
      const pages = new Map(
        current.statPages.map((record) => [
          `${record.book_hash}:${record.page}:${record.start_time}`,
          record,
        ]),
      );
      for (const record of payload.statPages ?? []) {
        pages.set(`${record.book_hash}:${record.page}:${record.start_time}`, {
          ...record,
          updated_at_ms: now,
        });
      }
      await provider.ensureDir(['/Readest']);
      await provider.writeText(
        SPACEBYTE_STATS_PATH,
        JSON.stringify({
          statBooks: [...books.values()],
          statPages: [...pages.values()],
        }),
      );
      return emptyResult();
    } finally {
      release();
    }
  }
}
