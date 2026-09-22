export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function required(name: string) {
  const value = process.env[name];
  if (!value)
    throw new AppError(
      503,
      "configuration_required",
      `${name} is not configured`,
    );
  return value;
}
