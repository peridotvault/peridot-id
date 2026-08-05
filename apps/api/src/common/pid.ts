import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export function newPid(): string {
  return `pid_${ulid()}`;
}
