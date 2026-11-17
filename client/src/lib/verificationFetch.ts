import superjson from 'superjson';

/** 僅限身分查詢；不可套用到建立預約或其他寫入。 */
export async function verificationFetch(
  run: (signal: AbortSignal) => Promise<Response>,
  parent?: AbortSignal | null,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<Response>(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(new Response(JSON.stringify([{ error: superjson.serialize({
            message: '系統忙碌，請稍後重試', code: -32008,
            data: { code: 'TIMEOUT', httpStatus: 408, path: '' },
          }) }]), { status: 408, headers: { 'content-type': 'application/json' } }));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}
