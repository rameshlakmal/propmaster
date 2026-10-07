/** An error whose message is already written for the person at the keyboard. */
export class UserError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'UserError';
  }
}

interface PgLikeError {
  code?: string;
  message: string;
  address?: string;
  port?: number;
}

/** Turns driver and Postgres errors into a message plus a next step. Unknown errors pass through. */
export function explainError(err: unknown): UserError | unknown {
  if (err instanceof UserError || !(err instanceof Error)) return err;
  const e = err as Error & PgLikeError;

  switch (e.code) {
    case 'ECONNREFUSED':
      return new UserError(
        `Can't reach Postgres${e.address ? ` at ${e.address}:${e.port}` : ''}.`,
        'Is it running? For the demo database: npm run db:up');
    case 'ENOTFOUND':
      return new UserError('The database host name could not be found.', 'Check the host in your connection string.');
    case '28P01':
    case '28000':
      return new UserError('Postgres rejected the user name or password.', 'Check the credentials in your connection string.');
    case '3D000':
      return new UserError(e.message.replace(/^database/, 'Database') + '.', 'Check the database name in your connection string.');
    case '42501':
      return new UserError(
        `Permission denied: ${e.message}.`,
        'Run `propmaster doctor` to see what your DB user can do. Without trigger rights, use snapshot mode: `propmaster record start --snapshot`.');
    case '55P03':
      return new UserError(
        'A table is locked by another session, so the recorder could not attach its trigger in time.',
        'Wait for long-running transactions or migrations to finish, then try again.');
    case 'P0001':
      return new UserError(e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.');
    default:
      return err;
  }
}
