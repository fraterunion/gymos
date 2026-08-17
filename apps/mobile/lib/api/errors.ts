export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class TimeoutError extends ApiError {
  constructor() {
    super(
      'La solicitud tardó demasiado. Verifica tu conexión e inténtalo de nuevo.',
      0,
    );
    this.name = 'TimeoutError';
  }
}
