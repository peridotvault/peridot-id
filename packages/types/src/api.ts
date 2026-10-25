export interface ApiError {
  statusCode: number;
  message: string | string[];
  /** Machine-readable reason (e.g. "step_up_required") when the server sends one. */
  code?: string;
}
