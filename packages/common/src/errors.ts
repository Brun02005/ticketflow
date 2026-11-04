/**
 * Errores de dominio. Los servicios lanzan estos errores y el error handler
 * los traduce a respuestas HTTP con un formato uniforme:
 *   { "error": { "code": "EMAIL_TAKEN", "message": "..." } }
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(400, code, message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(code = 'UNAUTHORIZED', message = 'No autenticado') {
    super(401, code, message)
  }
}

export class ForbiddenError extends AppError {
  constructor(code = 'FORBIDDEN', message = 'No tenés permisos para esta acción') {
    super(403, code, message)
  }
}

export class NotFoundError extends AppError {
  constructor(code: string, message: string) {
    super(404, code, message)
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details)
  }
}
