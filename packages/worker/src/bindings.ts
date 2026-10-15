export interface Fetcher {
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface ObjectId {
  readonly toString: () => string;
}

export interface Namespace {
  readonly idFromName: (name: string) => ObjectId;
  readonly get: (id: ObjectId) => Fetcher;
}

export interface Settings {
  readonly API_TOKEN?: string;
  readonly REQUIRE_READ_AUTH?: string;
  readonly REPO?: string;
  readonly TRAIN_LABEL?: string;
  readonly IGNORED_CHECKS?: string;
  readonly AGGREGATE_CHECKS?: string;
  readonly MAX_CARS?: string;
}

export interface Env extends Settings {
  readonly TRAIN: Namespace;
  readonly SOLO: Namespace;
  readonly DEPOT: Namespace;
}

export interface SqlCursor<A> {
  readonly toArray: () => A[];
}

export interface SqlStorage {
  readonly exec: <A>(
    query: string,
    ...bindings: (string | number | null)[]
  ) => SqlCursor<A>;
}

export interface ObjectState {
  readonly storage: {
    readonly sql: SqlStorage;
    readonly transactionSync: <A>(work: () => A) => A;
    readonly setAlarm: (at: number) => Promise<void>;
    readonly deleteAlarm: () => Promise<void>;
  };
  readonly blockConcurrencyWhile: <A>(work: () => Promise<A>) => Promise<A>;
}
