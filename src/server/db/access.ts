import { AsyncLocalStorage } from "node:async_hooks";
import type { WindScopeDatabase } from "./client";

const pending = new WeakMap<WindScopeDatabase, Promise<void>>();
const owners = new AsyncLocalStorage<ReadonlySet<WindScopeDatabase>>();

/** Keep a complete asynchronous operation on the shared SQLite connection isolated.
 * Child service calls and SQL statements can re-enter their caller's operation.
 */
export function withDatabaseAccess<T>(db: WindScopeDatabase, operation: () => T | Promise<T>): Promise<T> {
  const currentOwners = owners.getStore();
  if (currentOwners?.has(db)) return Promise.resolve().then(operation);
  const previous = pending.get(db) ?? Promise.resolve();
  const result = previous.then(() => owners.run(new Set([...(currentOwners ?? []), db]), operation));
  pending.set(db, result.then(() => undefined, () => undefined));
  return result;
}
