import fs from "fs-extra";
import path from "path";
import { Storage } from "./storage";
import type {
  CollectionIndex,
  IndexOptions,
  IReadEntireJsonFile,
  MongifyDocument,
  MongifyOptions,
  MongifyQuery,
} from "./types";

const collection_queues = new Map<string, Promise<void>>();

export class Helpers {
  database_path: string;
  private storage: Storage;

  constructor(args0: MongifyOptions) {
    this._validate_name(args0?.database_name, "Database name");

    const home_dir =
      process.env.APPDATA ||
      (process.platform == "darwin"
        ? process.env.HOME + "/Library"
        : process.env.HOME + "/.local/share");
    const database_path = args0?.path || home_dir;
    this.database_path = path.resolve(
      database_path,
      "Mongify",
      args0.database_name,
    );
    this.storage = new Storage(this.database_path);
  }

  public async _create_database(): Promise<string> {
    fs.ensureDirSync(this.database_path);
    return this.database_path;
  }

  public _get_collection_path(collection_name: string): string {
    this._validate_name(collection_name, "Collection name");
    return path.join(this.database_path, collection_name + ".json");
  }

  public async _with_collection_lock<T>(
    collection_name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const collection_path = this._get_collection_path(collection_name);
    const previous = collection_queues.get(collection_path) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);

    collection_queues.set(collection_path, current);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (collection_queues.get(collection_path) === current) {
        collection_queues.delete(collection_path);
      }
    }
  }

  public async _create_collection(collection_name: string): Promise<void> {
    this._get_collection_path(collection_name);
    await this.storage.createCollection(collection_name);
  }

  public async _delete_collection(collection_name: string): Promise<void> {
    this._get_collection_path(collection_name);
    await this.storage.deleteCollection(collection_name);
  }

  public async _purge_and_write_entire_file(
    collection_name: string,
    data?: MongifyDocument[],
  ): Promise<boolean> {
    await this.storage.replaceAll(collection_name, data || []);
    return true;
  }

  public async _append_documents(
    collection_name: string,
    documents: MongifyDocument[],
  ): Promise<boolean> {
    await this.storage.append(collection_name, documents);
    return true;
  }

  public async _read_entire_json_file(
    args0: IReadEntireJsonFile,
  ): Promise<MongifyDocument[]> {
    return this.storage.readAll(
      args0.collection_name,
      args0.create_new === true,
    );
  }

  public async _find_documents(
    collection_name: string,
    query?: MongifyQuery,
    limit?: number,
    first = false,
  ): Promise<MongifyDocument[]> {
    return this.storage.find(collection_name, query, limit, first);
  }

  public async _update_documents(
    collection_name: string,
    query: MongifyQuery,
    update: MongifyDocument,
    upsert = false,
  ): Promise<void> {
    await this.storage.update(collection_name, query, update, upsert);
  }

  public async _delete_documents(
    collection_name: string,
    query: MongifyQuery,
  ): Promise<void> {
    await this.storage.delete(collection_name, query);
  }

  public async _create_index(
    collection_name: string,
    field: string,
    options?: IndexOptions,
  ): Promise<void> {
    await this.storage.createIndex(collection_name, field, options);
  }

  public async _drop_index(
    collection_name: string,
    field: string,
  ): Promise<void> {
    await this.storage.dropIndex(collection_name, field);
  }

  public async _list_indexes(
    collection_name: string,
  ): Promise<CollectionIndex[]> {
    return this.storage.listIndexes(collection_name);
  }

  public async _total_chunk_size(collection_name: string): Promise<number> {
    return this.storage.totalChunkSize(collection_name);
  }

  public _turn_query_into_search_params(query: MongifyQuery): {
    key: string;
    value: any;
  } {
    const key = Object.keys(query)[0];
    return { key, value: query[key] };
  }

  public _filter_inverse_array(
    arr: MongifyDocument[],
    key: string,
    value: any,
  ): MongifyDocument[] {
    return arr.filter((obj) => obj[key] !== value);
  }

  public async _list_files(): Promise<string[]> {
    const entries = await fs.readdir(this.database_path, {
      withFileTypes: true,
    });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort();
  }

  private _validate_name(value: unknown, label: string): asserts value is string {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("\0")
    ) {
      throw new TypeError(
        `${label} must be a non-empty name without path separators`,
      );
    }
  }
}
