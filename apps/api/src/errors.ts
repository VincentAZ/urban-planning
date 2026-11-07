export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = () =>
  new ApiError(404, "NOT_FOUND", "The requested record was not found.");
