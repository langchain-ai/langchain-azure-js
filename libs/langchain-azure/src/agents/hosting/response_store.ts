import type {
  CreateResponseRequest,
  ResponseInputItem,
  ResponseObject,
} from "./types.js";

export interface StoredResponse {
  request: CreateResponseRequest;
  response: ResponseObject;
  inputItems: ResponseInputItem[];
  abortController: AbortController;
}

export interface InMemoryResponseStoreOptions {
  maxRecords?: number;
  ttlMs?: number;
  now?: () => number;
}

export class ResponseStoreCapacityError extends Error {
  readonly isResponseStoreCapacityError = true;

  constructor(readonly maxRecords: number) {
    super(`Response store capacity of ${maxRecords} records was reached.`);
    this.name = "ResponseStoreCapacityError";
  }
}

interface StoredEntry {
  record: StoredResponse;
  expiresAt: number;
}

const DEFAULT_MAX_RECORDS = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryResponseStore {
  private readonly records = new Map<string, StoredEntry>();

  private readonly maxRecords: number;

  private readonly ttlMs: number;

  private readonly now: () => number;

  constructor(options: InMemoryResponseStoreOptions = {}) {
    this.maxRecords = validatePositiveInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      "maxRecords"
    );
    this.ttlMs = validatePositiveInteger(
      options.ttlMs ?? DEFAULT_TTL_MS,
      "ttlMs"
    );
    this.now = options.now ?? Date.now;
  }

  create(record: StoredResponse): void {
    this.pruneExpired();
    if (this.records.has(record.response.id)) {
      throw new Error(`Response '${record.response.id}' already exists.`);
    }
    if (
      this.records.size >= this.maxRecords &&
      record.request.store !== false
    ) {
      this.evictOldestTerminalRecord(record);
    }
    if (this.records.size >= this.maxRecords) {
      throw new ResponseStoreCapacityError(this.maxRecords);
    }
    this.records.set(record.response.id, {
      record,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  get(responseId: string): StoredResponse | undefined {
    this.pruneExpired();
    return this.records.get(responseId)?.record;
  }

  delete(responseId: string): boolean {
    return this.records.delete(responseId);
  }

  values(): StoredResponse[] {
    this.pruneExpired();
    return [...this.records.values()].map(({ record }) => record);
  }

  getResponseChain(responseId: string): StoredResponse[] | undefined {
    this.pruneExpired();
    const chain: StoredResponse[] = [];
    const seen = new Set<string>();
    let currentId: string | null = responseId;

    while (currentId !== null) {
      if (seen.has(currentId)) {
        throw new Error(`Response chain contains a cycle at '${currentId}'.`);
      }
      seen.add(currentId);

      const entry = this.records.get(currentId);
      if (entry === undefined) {
        return undefined;
      }
      const { record } = entry;
      chain.push(record);
      currentId = record.response.previous_response_id;
    }

    return chain.reverse();
  }

  getConversation(
    responseId: string,
    conversationId: string
  ): StoredResponse[] {
    return this.values()
      .filter(
        (record) =>
          record.response.id !== responseId &&
          record.response.conversation?.id === conversationId &&
          record.response.status === "completed"
      )
      .sort(
        (left, right) => left.response.created_at - right.response.created_at
      );
  }

  private pruneExpired(): void {
    const now = this.now();
    const retainedRecords = [...this.records.values()]
      .filter(
        (entry) =>
          entry.expiresAt > now ||
          entry.record.response.status === "in_progress"
      )
      .map(({ record }) => record);
    const protectedIds = this.collectAncestorIds(retainedRecords);
    for (const [responseId, entry] of this.records) {
      if (
        entry.expiresAt <= now &&
        entry.record.response.status !== "in_progress" &&
        !protectedIds.has(responseId)
      ) {
        this.records.delete(responseId);
      }
    }
  }

  private evictOldestTerminalRecord(incoming: StoredResponse): void {
    const protectedIds = this.collectAncestorIds([
      ...[...this.records.values()].map(({ record }) => record),
      incoming,
    ]);
    for (const [responseId, entry] of this.records) {
      if (
        entry.record.response.status !== "in_progress" &&
        !protectedIds.has(responseId)
      ) {
        this.records.delete(responseId);
        return;
      }
    }
  }

  private collectAncestorIds(records: StoredResponse[]): Set<string> {
    const ancestors = new Set<string>();
    for (const record of records) {
      let currentId = record.response.previous_response_id;
      while (currentId !== null && !ancestors.has(currentId)) {
        ancestors.add(currentId);
        currentId =
          this.records.get(currentId)?.record.response.previous_response_id ??
          null;
      }
    }
    return ancestors;
  }
}

export function isResponseStoreCapacityError(
  error: unknown
): error is ResponseStoreCapacityError {
  return (
    typeof error === "object" &&
    error !== null &&
    "isResponseStoreCapacityError" in error &&
    error.isResponseStoreCapacityError === true
  );
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`'${name}' must be a positive safe integer.`);
  }
  return value;
}
