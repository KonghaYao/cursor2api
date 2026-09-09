export class CloudChatError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CloudChatError";
    this.status = status;
  }
}

export function isCloudChatError(err: unknown): err is CloudChatError {
  return err instanceof CloudChatError;
}
