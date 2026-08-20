export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'request_failed',
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJson(request: Request) {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, '请求格式不正确', 'unsupported_media_type');
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'JSON 内容无效', 'invalid_json');
  }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  const requestUrl = new URL(request.url);
  if (origin !== requestUrl.origin) {
    throw new HttpError(403, '请求来源无效', 'invalid_origin');
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (
    error instanceof Error &&
    (error.message.includes('no such table') || error.message.includes('D1_ERROR'))
  ) {
    console.error(error.message, error.stack);
    return json(
      {
        error: 'database_not_initialized',
        message: '本地数据库尚未初始化，请停止服务后重新运行 npm run dev',
      },
      { status: 503 },
    );
  }
  if (error instanceof Error) console.error(error.message, error.stack);
  return json({ error: 'internal_error', message: '服务暂时不可用，请稍后再试' }, { status: 500 });
}
