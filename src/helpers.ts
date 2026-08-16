import fs from "fs-extra";
import path from "path";

const collection_queues = new Map<string, Promise<void>>();

export class Helpers {
  database_path: string;

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
  }

  public async _create_database(): Promise<string | boolean> {
    if (!fs.existsSync(this.database_path)) {
      try {
        fs.mkdirSync(this.database_path, { recursive: true });
      } catch (e) {
        throw new Error("Error code kl3: " + e);
      }
    }
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

  public async _purge_and_write_entire_file(
    collection_name: string,
    data?: MongifyDocument[],
  ): Promise<boolean> {
    const serialized_data = JSON.stringify(data || []);
    const collection_path = this._get_collection_path(collection_name);
    const temporary_path = path.join(
      this.database_path,
      `.${path.basename(collection_path)}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
    );

    try {
      await fs.writeFile(temporary_path, serialized_data, {
        encoding: "utf8",
        flag: "wx",
      });
      await fs.rename(temporary_path, collection_path);
    } catch (error) {
      await fs.unlink(temporary_path).catch(() => undefined);
      throw error;
    }

    return true;
  }

  public async _read_entire_json_file(
    args0: IReadEntireJsonFile,
  ): Promise<MongifyDocument[]> {
    const { collection_name, create_new } = args0;
    const collection_path = this._get_collection_path(collection_name);
    let json: string;
    try {
      json = await fs.readFile(collection_path, {
        encoding: "utf8",
      });
    } catch (e) {
      if (create_new) {
        await this._purge_and_write_entire_file(collection_name);
        json = await fs.readFile(collection_path, {
          encoding: "utf8",
        });
      } else {
        return [];
      }
    }
    let res: MongifyDocument[] = [];
    if (json && json != "") {
      res = JSON.parse(json);
    } else {
      res = [];
    }
    return res;
  }

  public _turn_query_into_search_params(query: MongifyQuery): {
    key: string;
    value: any;
  } {
    let key = Object.keys(query)[0];
    let value = query[key];
    return { key, value };
  }

  public _filter_array(
    arr: MongifyDocument[],
    key: string,
    value: any,
  ): MongifyDocument[] {
    return arr.filter((obj) => obj[key] === value);
  }

  public _filter_inverse_array(
    arr: MongifyDocument[],
    key: string,
    value: any,
  ): MongifyDocument[] {
    return arr.filter((obj) => obj[key] !== value);
  }

  public async _delete_file(json_name: string): Promise<boolean> {
    await fs.unlink(json_name);
    return true;
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
