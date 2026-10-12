/**
 * Минимальные декларации для библиотек без собственных типов.
 * Пакеты: sql.js (WASM-сборка SQLite), node-cron (планировщик),
 * ssh2-sftp-client (SFTP-коннектор). Ставятся как optionalDependencies,
 * поэтому декларации держим локально и не зависим от @types-пакетов.
 */

declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Statement {
    bind(params?: unknown[] | Record<string, unknown>): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    getColumnNames(): string[];
    reset(): boolean;
    free(): boolean;
    run(params?: unknown[]): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    prepare(sql: string, params?: unknown[]): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
    create_function(name: string, fn: (...args: unknown[]) => unknown): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | number[] | null) => Database;
  }

  export interface InitSqlJsConfig {
    locateFile?: (file: string, prefix?: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
  export function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}

declare module 'node-cron' {
  export interface TaskOptions {
    scheduled?: boolean;
    timezone?: string;
    name?: string;
    recoverMissedExecutions?: boolean;
  }

  export interface ScheduledTask {
    start(): void;
    stop(): void;
    destroy(): void;
    getStatus?(): string;
  }

  export function schedule(expression: string, func: () => void | Promise<void>, options?: TaskOptions): ScheduledTask;
  export function validate(expression: string): boolean;
  export function getTasks(): Map<string, ScheduledTask>;

  const cron: {
    schedule: typeof schedule;
    validate: typeof validate;
    getTasks: typeof getTasks;
  };
  export default cron;
}

declare module 'ssh2-sftp-client' {
  import type { Readable } from 'node:stream';

  export interface ConnectOptions {
    host: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout?: number;
    retries?: number;
    retry_minTimeout?: number;
  }

  export interface FileInfo {
    name: string;
    type: string;
    size: number;
    modifyTime?: number;
    accessTime?: number;
    rights?: { user: string; group: string; other: string };
    owner?: number;
    group?: number;
  }

  export default class SftpClient {
    constructor(name?: string);
    connect(options: ConnectOptions): Promise<void>;
    list(remotePath: string): Promise<FileInfo[]>;
    exists(remotePath: string): Promise<false | 'd' | '-' | 'l'>;
    get(remotePath: string, dst?: string | NodeJS.WritableStream | boolean): Promise<string | Buffer | NodeJS.WritableStream>;
    put(src: string | Buffer | Readable, remotePath: string, options?: { encoding?: string; flags?: string }): Promise<string>;
    append(src: string | Buffer, remotePath: string): Promise<string>;
    mkdir(remotePath: string, recursive?: boolean): Promise<string>;
    rmdir(remotePath: string, recursive?: boolean): Promise<string>;
    delete(remotePath?: string, noErrorOK?: boolean): Promise<string>;
    rename(fromPath: string, toPath: string): Promise<string>;
    stat(remotePath: string): Promise<FileInfo>;
    end(): Promise<void>;
  }
}
