import { BadRequestException } from '@nestjs/common';

import type { ResolvedClientConfig } from '../download-client-adapter';
import { OpenBooksAdapter } from './openbooks.adapter';

const INFO_HASH = 'c9e15763f722f23e98a29decdfae341b98d53056';

function config(overrides: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
  return {
    id: 1,
    name: 'local openbooks',
    adapterType: 'openbooks',
    baseUrl: 'http://127.0.0.1:6081',
    username: null,
    password: 'library-token',
    category: 'bookorbit',
    allowPrivateAddress: true,
    settings: null,
    ...overrides,
  };
}

function mockFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn((url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: url.toString(), init });
    return Promise.resolve(new Response('', { status: 200, headers: { 'content-length': '1234' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('OpenBooksAdapter', () => {
  let adapter: OpenBooksAdapter;

  beforeEach(() => {
    adapter = new OpenBooksAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tracks an OpenBooks library URL as a completed file under the OpenBooks library path', async () => {
    const { calls } = mockFetch();

    await expect(
      adapter.add(
        {
          fileUrl: 'http://127.0.0.1:6081/library/Sometimes%20I%20Lie.epub',
          fileName: 'Sometimes I Lie.epub',
          clientKey: INFO_HASH,
          sizeBytes: 1234,
        },
        config(),
      ),
    ).resolves.toEqual({ clientKey: INFO_HASH });

    await expect(adapter.status([INFO_HASH], config())).resolves.toEqual([
      expect.objectContaining({
        clientKey: INFO_HASH,
        state: 'completed',
        progressPercent: 100,
        downloadedBytes: 1234,
        totalBytes: 1234,
        contentPath: '/books/books/Sometimes I Lie.epub',
      }),
    ]);
    expect(calls).toEqual([]);
  });

  it('adds the configured library token when removing a file URL that does not already carry one', async () => {
    const { calls } = mockFetch();

    await adapter.add({ fileUrl: 'http://127.0.0.1:6081/library/book.epub', fileName: 'book.epub', clientKey: INFO_HASH }, config());
    await adapter.remove(INFO_HASH, config(), { deleteFiles: true });

    expect(calls[0]?.url).toBe('http://127.0.0.1:6081/library/book.epub?libraryToken=library-token');
    expect(calls[0]?.init.headers).toEqual({ 'X-OpenBooks-Library-Token': 'library-token' });
  });

  it('refuses a URL outside the configured OpenBooks library', async () => {
    mockFetch();

    await expect(
      adapter.add({ fileUrl: 'http://127.0.0.1:6081/download/book.epub', fileName: 'book.epub', clientKey: INFO_HASH }, config()),
    ).rejects.toThrow(BadRequestException);
  });

  it('tests the OpenBooks server endpoint', async () => {
    const { calls } = mockFetch();

    await expect(adapter.test(config({ baseUrl: 'http://127.0.0.1:6081/base' }))).resolves.toEqual({ success: true });
    expect(calls[0]?.url).toBe('http://127.0.0.1:6081/base/servers');
  });
});
