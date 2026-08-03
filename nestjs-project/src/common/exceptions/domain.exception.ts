export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_OWNED',
      403,
      'Video does not belong to the authenticated user',
    );
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      409,
      'No upload in progress for this video',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

export class VideoFileTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_FILE_TOO_LARGE',
      400,
      'Video exceeds the maximum allowed size',
    );
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_VIDEO_TYPE', 400, 'Unsupported video content type');
  }
}

export class InvalidRangeException extends DomainException {
  constructor() {
    super('INVALID_RANGE', 416, 'Requested range is not satisfiable');
  }
}
