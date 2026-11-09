import {
  FileSyncError,
  type FileEntry,
  type FileHead,
  type FileSyncErrorCode,
  type FileSyncProvider,
} from '@/services/sync/file/provider';

const SPACEBYTE_API_BASE_URL = 'https://spacebyte.in/api/v1';
const PAGE_SIZE = 50;

interface SpaceByteEntry {
  id: number;
  name: string;
  file_name: string;
  file_size: number;
  parent_id: number | null;
  updated_at: string;
  type: 'file' | 'folder';
  hash: string;
}

type SpaceByteListResponse =
  | SpaceByteEntry[]
  | {
      data?: SpaceByteEntry[];
      current_page?: number;
      last_page?: number;
      next_page?: number | string | null;
      next_page_url?: string | null;
    };

interface SpaceByteFolderResponse {
  folder: SpaceByteEntry;
}

interface SpaceByteUploadResponse {
  fileEntry: SpaceByteEntry;
}

export interface SpaceByteProviderConfig {
  apiKey: string;
  rootFolderId: number;
}

export type SpaceByteFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const normalizePath = (path: string): string => {
  const segments = path.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}` : '/';
};

const pathSegments = (path: string): string[] => normalizePath(path).split('/').filter(Boolean);

const parentPath = (path: string): string => {
  const segments = pathSegments(path);
  segments.pop();
  return segments.length ? `/${segments.join('/')}` : '/';
};

const basename = (path: string): string => pathSegments(path).at(-1) ?? '';

const joinPath = (parent: string, name: string): string =>
  normalizePath(parent === '/' ? `/${name}` : `${parent}/${name}`);

const errorCodeForStatus = (status: number): FileSyncErrorCode => {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 408 || status === 429 || status >= 500) return 'NETWORK';
  return 'UNKNOWN';
};

const responseError = async (response: Response, operation: string): Promise<FileSyncError> => {
  let detail = '';
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    detail = body.message ?? body.error ?? '';
  } catch {
    detail = '';
  }
  const message = detail
    ? `${operation} failed: ${detail}`
    : `${operation} failed with status ${response.status}`;
  return new FileSyncError(message, errorCodeForStatus(response.status), response.status);
};

const authorizationHeaders = (apiKey: string, accept = 'application/json'): HeadersInit => ({
  Accept: accept,
  Authorization: `Bearer ${apiKey}`,
});

export const createSpaceByteRootFolder = async (
  apiKey: string,
  fetchFn: SpaceByteFetchFn = fetch,
): Promise<number> => {
  let response: Response;
  try {
    response = await fetchFn(`${SPACEBYTE_API_BASE_URL}/folders`, {
      method: 'POST',
      headers: {
        ...authorizationHeaders(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'ReadestBackup', parentId: null }),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new FileSyncError(`Failed to create SpaceByte backup folder: ${message}`, 'NETWORK');
  }
  if (!response.ok) throw await responseError(response, 'Create folder');
  const body = (await response.json()) as SpaceByteFolderResponse;
  if (!body.folder?.id) throw new FileSyncError('Create folder returned no folder id');
  return body.folder.id;
};

class SpaceByteProvider implements FileSyncProvider {
  readonly rootPath = '/';

  private readonly pathCache = new Map<string, SpaceByteEntry>();
  private readonly childrenCache = new Map<number, SpaceByteEntry[]>();

  constructor(
    private readonly config: SpaceByteProviderConfig,
    private readonly fetchFn: SpaceByteFetchFn,
  ) {}

  async readText(path: string): Promise<string | null> {
    const response = await this.download(path);
    return response ? response.text() : null;
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const response = await this.download(path);
    return response ? response.arrayBuffer() : null;
  }

  async head(path: string): Promise<FileHead | null> {
    const item = await this.resolveEntry(path);
    if (!item || item.type !== 'file') return null;
    return { size: item.file_size };
  }

  async list(path: string): Promise<FileEntry[]> {
    const normalized = normalizePath(path);
    const folderId =
      normalized === '/' ? this.config.rootFolderId : await this.resolveFolderId(normalized, false);
    if (folderId === null) return [];
    const children = await this.listChildren(folderId, true);
    return children.map((item) => ({
      name: item.name,
      path: joinPath(normalized, item.name),
      isDirectory: item.type === 'folder',
      size: item.type === 'file' ? item.file_size : undefined,
      lastModified: item.updated_at,
    }));
  }

  async writeText(path: string, body: string, contentType = 'application/json'): Promise<void> {
    await this.upload(path, new Blob([body], { type: contentType }));
  }

  async writeBinary(
    path: string,
    body: ArrayBuffer,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    await this.upload(path, new Blob([body], { type: contentType }));
  }

  async ensureDir(paths: string[]): Promise<void> {
    for (const path of paths) {
      await this.resolveFolderId(path, true);
    }
  }

  async deleteDir(path: string): Promise<void> {
    const entry = await this.resolveEntry(path);
    if (!entry) return;
    await this.deleteEntries([entry.id]);
    this.invalidatePath(path);
  }

  private async download(path: string): Promise<Response | null> {
    const item = await this.resolveEntry(path);
    if (!item || item.type !== 'file') return null;
    let response: Response;
    try {
      response = await this.fetchFn(
        `${SPACEBYTE_API_BASE_URL}/file-entries/download/${encodeURIComponent(item.hash)}`,
        {
          method: 'GET',
          headers: authorizationHeaders(this.config.apiKey, 'application/octet-stream'),
        },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new FileSyncError(`SpaceByte download failed: ${message}`, 'NETWORK');
    }
    if (response.status === 404) {
      this.invalidatePath(path);
      return null;
    }
    if (!response.ok) throw await responseError(response, 'Download');
    return response;
  }

  private async upload(path: string, body: Blob): Promise<void> {
    const normalized = normalizePath(path);
    const name = basename(normalized);
    if (!name) throw new FileSyncError('Cannot upload to the SpaceByte root');

    const parent = parentPath(normalized);
    const parentId = await this.resolveFolderId(parent, true);
    if (parentId === null) throw new FileSyncError(`Parent folder not found: ${parent}`);

    const existing = await this.resolveEntry(normalized);
    if (existing) await this.deleteEntries([existing.id]);

    const form = new FormData();
    form.append('file', body, name);
    form.append('parentId', String(parentId));
    form.append('relativePath', '');

    let response: Response;
    try {
      response = await this.fetchFn(`${SPACEBYTE_API_BASE_URL}/uploads`, {
        method: 'POST',
        headers: authorizationHeaders(this.config.apiKey),
        body: form,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new FileSyncError(`SpaceByte upload failed: ${message}`, 'NETWORK');
    }
    if (!response.ok) throw await responseError(response, 'Upload');
    const result = (await response.json()) as SpaceByteUploadResponse;
    if (!result.fileEntry?.id) throw new FileSyncError('Upload returned no file entry');
    this.pathCache.set(normalized, result.fileEntry);
    this.childrenCache.delete(parentId);
  }

  private async resolveFolderId(path: string, create: boolean): Promise<number | null> {
    const normalized = normalizePath(path);
    if (normalized === '/') return this.config.rootFolderId;

    let currentId = this.config.rootFolderId;
    let currentPath = '/';
    for (const segment of pathSegments(normalized)) {
      const nextPath = joinPath(currentPath, segment);
      const cached = this.pathCache.get(nextPath);
      let folder =
        cached?.type === 'folder'
          ? cached
          : (await this.listChildren(currentId)).find(
              (item) => item.type === 'folder' && item.name === segment,
            );
      if (!folder && create) {
        folder = await this.createFolder(segment, currentId);
      }
      if (!folder) return null;
      this.pathCache.set(nextPath, folder);
      currentId = folder.id;
      currentPath = nextPath;
    }
    return currentId;
  }

  private async resolveEntry(path: string): Promise<SpaceByteEntry | null> {
    const normalized = normalizePath(path);
    if (normalized === '/') return null;
    const cached = this.pathCache.get(normalized);
    if (cached) return cached;

    const parent = parentPath(normalized);
    const parentId = await this.resolveFolderId(parent, false);
    if (parentId === null) return null;
    const name = basename(normalized);
    const found = (await this.listChildren(parentId)).find((item) => item.name === name) ?? null;
    if (found) this.pathCache.set(normalized, found);
    return found;
  }

  private async listChildren(parentId: number, refresh = false): Promise<SpaceByteEntry[]> {
    if (!refresh) {
      const cached = this.childrenCache.get(parentId);
      if (cached) return cached;
    }

    const entries = new Map<number, SpaceByteEntry>();
    let page = 1;
    while (true) {
      const url =
        `${SPACEBYTE_API_BASE_URL}/drive/file-entries?perPage=${PAGE_SIZE}` +
        `&parentIds=${parentId}&workspaceId=0&page=${page}`;
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'GET',
          headers: authorizationHeaders(this.config.apiKey),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new FileSyncError(`SpaceByte listing failed: ${message}`, 'NETWORK');
      }
      if (!response.ok) throw await responseError(response, 'List folder');
      const result = (await response.json()) as SpaceByteListResponse;
      const pageEntries = Array.isArray(result) ? result : (result.data ?? []);
      const previousSize = entries.size;
      for (const entry of pageEntries) entries.set(entry.id, entry);
      if (entries.size === previousSize || pageEntries.length < PAGE_SIZE) break;

      if (Array.isArray(result)) {
        page += 1;
        continue;
      }

      const nextPageFromUrl = result.next_page_url
        ? Number(new URL(result.next_page_url, SPACEBYTE_API_BASE_URL).searchParams.get('page'))
        : NaN;
      const explicitNext = Number(result.next_page);
      const nextPage =
        Number.isFinite(explicitNext) && explicitNext > page
          ? explicitNext
          : Number.isFinite(nextPageFromUrl) && nextPageFromUrl > page
            ? nextPageFromUrl
            : result.current_page && result.last_page && result.current_page < result.last_page
              ? result.current_page + 1
              : page + 1;
      if (nextPage <= page) break;
      page = nextPage;
    }
    const result = [...entries.values()];
    this.childrenCache.set(parentId, result);
    return result;
  }

  private async createFolder(name: string, parentId: number): Promise<SpaceByteEntry> {
    let response: Response;
    try {
      response = await this.fetchFn(`${SPACEBYTE_API_BASE_URL}/folders`, {
        method: 'POST',
        headers: {
          ...authorizationHeaders(this.config.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, parentId }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new FileSyncError(`SpaceByte folder creation failed: ${message}`, 'NETWORK');
    }
    if (!response.ok) throw await responseError(response, 'Create folder');
    const result = (await response.json()) as SpaceByteFolderResponse;
    if (!result.folder?.id) throw new FileSyncError('Create folder returned no folder entry');
    this.childrenCache.delete(parentId);
    return result.folder;
  }

  private async deleteEntries(entryIds: number[]): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn(`${SPACEBYTE_API_BASE_URL}/file-entries`, {
        method: 'DELETE',
        headers: {
          ...authorizationHeaders(this.config.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          entryIds: entryIds.map(String),
          deleteForever: true,
        }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new FileSyncError(`SpaceByte deletion failed: ${message}`, 'NETWORK');
    }
    if (!response.ok) throw await responseError(response, 'Delete entry');
  }

  private invalidatePath(path: string): void {
    const normalized = normalizePath(path);
    this.pathCache.delete(normalized);
    const parent = parentPath(normalized);
    const cachedParent = this.pathCache.get(parent);
    if (parent === '/') this.childrenCache.delete(this.config.rootFolderId);
    else if (cachedParent?.type === 'folder') this.childrenCache.delete(cachedParent.id);
  }
}

export const createSpaceByteProvider = (
  config: SpaceByteProviderConfig,
  fetchFn: SpaceByteFetchFn = fetch,
): FileSyncProvider => new SpaceByteProvider(config, fetchFn);
