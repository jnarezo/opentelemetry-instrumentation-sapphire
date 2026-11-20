import { SpanStatusCode, type Span } from '@opentelemetry/api';

export function recordFailure(span: Span, error: unknown): void {
  span.setAttribute('sapphire.outcome', 'error');
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: typeof error === 'string' ? error : undefined,
    });
  }
}

export function recordSuccess(_value: unknown, span: Span): void {
  span.setAttribute('sapphire.outcome', 'success');
}

export function observe(
  call: () => unknown,
  success: (value: unknown) => void,
  failure: (error: unknown) => void,
  finish?: () => void
): unknown {
  let value: unknown;
  try {
    value = call();
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      'then' in value &&
      typeof value.then === 'function'
    ) {
      return Promise.resolve(value).then(
        (result) => {
          try {
            success(result);
            return result;
          } finally {
            finish?.();
          }
        },
        (error: unknown) => {
          try {
            failure(error);
          } finally {
            finish?.();
          }
          throw error;
        }
      );
    }
  } catch (error) {
    try {
      failure(error);
    } finally {
      finish?.();
    }
    throw error;
  }

  try {
    success(value);
    return value;
  } finally {
    finish?.();
  }
}
