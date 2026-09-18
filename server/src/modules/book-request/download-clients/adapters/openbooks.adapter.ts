import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { DownloadClientTestResult } from '@bookorbit/types';

import { sanitizeLogValue } from '../../../../common/utils/log-sanitize.utils';
import { ensureSafeUrl } from '../../../../common/utils/ssrf.utils';
import type {
  DownloadClientAdapter,
  DownloadStatus,
  GrabPayload,
  OwnedDownloadClientInventory,
  ResolvedClientConfig,
} from '../download-client-adapter';
import { endpointUrl, fetchClient, readClientText, throwForClientServerError } from './client-http.utils';

const LABEL = 'OpenBooks';
const DEFAULT_LIBRARY_PATH = '/books/books';

interface TrackedOpenBooksFile {
  fileUrl: string;
  fileName: string;
  contentPath: string;
  sizeBytes: number | null;
}

@Injectable()
export class OpenBooksAdapter implements DownloadClientAdapter {
  readonly type = 'openbooks' as const;
  readonly label = LABEL;
  readonly delivers = 'file' as const;

  private readonly logger = new Logger(OpenBooksAdapter.name);
  private readonly tracked = new Map<number, Map<string, TrackedOpenBooksFile>>();

  async add(release: GrabPayload, config: ResolvedClientConfig): Promise<{ clientKey: string }> {
    if (!release.fileUrl) throw new BadRequestException('OpenBooks needs a resolved file URL');
    const fileUrl = await this.resolveFileUrl(release.fileUrl, config);
    const base = await this.resolveBaseUrl(config);
    if (fileUrl.origin !== base.origin || !sameOrNestedPath(fileUrl.pathname, endpointUrl(base, '/library/').pathname)) {
      throw new BadRequestException('OpenBooks can only import files served from its own /library path');
    }

    const fileName = release.fileName?.trim() || fileNameFromLibraryUrl(fileUrl);
    const contentPath = `${DEFAULT_LIBRARY_PATH}/${fileName.replace(/^\/+/, '')}`;
    this.trackedFor(config.id).set(release.clientKey.toLowerCase(), {
      fileUrl: fileUrl.toString(),
      fileName,
      contentPath,
      sizeBytes: release.sizeBytes ?? null,
    });

    return { clientKey: release.clientKey.toLowerCase() };
  }

  status(clientKeys: string[], config: ResolvedClientConfig): Promise<DownloadStatus[]> {
    const tracked = this.trackedFor(config.id);
    const results: DownloadStatus[] = [];
    for (const clientKey of clientKeys) {
      const normalized = clientKey.toLowerCase();
      const entry = tracked.get(normalized);
      if (!entry) continue;

      const totalBytes = entry.sizeBytes;
      results.push({
        clientKey: normalized,
        state: 'completed',
        progressPercent: 100,
        downloadedBytes: totalBytes ?? 0,
        totalBytes,
        contentPath: entry.contentPath,
      });
    }
    return Promise.resolve(results);
  }

  listOwned(): Promise<OwnedDownloadClientInventory> {
    return Promise.resolve({ supported: false, truncated: false, items: [] });
  }

  async remove(clientKey: string, config: ResolvedClientConfig, opts: { deleteFiles: boolean }): Promise<void> {
    const tracked = this.trackedFor(config.id);
    const entry = tracked.get(clientKey.toLowerCase());
    tracked.delete(clientKey.toLowerCase());
    if (!entry || !opts.deleteFiles) return;

    const fileUrl = await this.resolveFileUrl(entry.fileUrl, config);
    const response = await fetchClient(
      fileUrl,
      {
        method: 'DELETE',
        headers: this.tokenHeaders(config),
      },
      LABEL,
    );
    if (response.status === 401 || response.status === 403 || response.status === 405) return;
    if (!response.ok) {
      throwForClientServerError(response, LABEL, 'delete library file');
      throw new BadRequestException(`OpenBooks answered ${response.status} while removing the library file`);
    }
  }

  async test(config: ResolvedClientConfig): Promise<DownloadClientTestResult> {
    try {
      const base = await this.resolveBaseUrl(config);
      const response = await fetchClient(endpointUrl(base, '/servers'), { method: 'GET' }, LABEL);
      if (!response.ok) {
        throwForClientServerError(response, LABEL, '/servers');
        return { success: false, error: `OpenBooks answered ${response.status} for /servers` };
      }
      await readClientText(response, LABEL);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[download_client.test] [fail] clientId=${config.id} error="${sanitizeLogValue(message)}" - OpenBooks connection test failed`);
      return { success: false, error: message };
    }
  }

  forget(clientId: number): void {
    this.tracked.delete(clientId);
  }

  private async resolveBaseUrl(config: ResolvedClientConfig): Promise<URL> {
    return ensureSafeUrl(config.baseUrl, { allowPrivate: config.allowPrivateAddress });
  }

  private async resolveFileUrl(fileUrl: string, config: ResolvedClientConfig): Promise<URL> {
    const safe = await ensureSafeUrl(fileUrl, { allowPrivate: config.allowPrivateAddress });
    if (config.password && !safe.searchParams.has('libraryToken')) {
      safe.searchParams.set('libraryToken', config.password);
    }
    return safe;
  }

  private tokenHeaders(config: ResolvedClientConfig): Record<string, string> {
    return config.password ? { 'X-OpenBooks-Library-Token': config.password } : {};
  }

  private trackedFor(clientId: number): Map<string, TrackedOpenBooksFile> {
    let tracked = this.tracked.get(clientId);
    if (!tracked) {
      tracked = new Map();
      this.tracked.set(clientId, tracked);
    }
    return tracked;
  }
}

function sameOrNestedPath(pathname: string, prefix: string): boolean {
  const normalized = trimTrailingSlash(pathname);
  const normalizedPrefix = trimTrailingSlash(prefix);
  return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function fileNameFromLibraryUrl(fileUrl: URL): string {
  const segments = fileUrl.pathname.split('/').filter(Boolean);
  const tail = segments.at(-1);
  if (!tail) throw new BadRequestException('OpenBooks library URL did not name a file');
  return decodeURIComponent(tail);
}
