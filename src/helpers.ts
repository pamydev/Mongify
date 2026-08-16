import fs from "fs-extra";
import path from "path";
import { v4 as uuid } from "uuid";
export class Helpers {
  database_path: string;

  constructor(args0: MongifyOptions) {
    const home_dir =
      process.env.APPDATA ||
      (process.platform == "darwin"
        ? process.env.HOME + "/Library"
        : process.env.HOME + "/.local/share");
    const database_path = args0?.path || home_dir;
    this.database_path = path.join(
      database_path,
      "/Mongify/",
      args0.database_name,
    );
  }

  public async _create_database(): Promise<string | boolean> {
    if (!fs.existsSync(this.database_path)) {
      try {
        fs.mkdirSync(this.database_path, { recursive: true });
      } catch (e) {
        throw new Error("Error code kl3: " + e);
        return false;
      }
    }
    return this.database_path;
  }

  public _get_collection_path(collection_name: string): string {
    return path.join(this.database_path, collection_name + ".json");
  }

  public async _purge_and_write_entire_file(
    collection_name: string,
    data?: MongifyDocument[],
  ): Promise<boolean> {
    const serialized_data = JSON.stringify(data || []);
    await fs.writeFile(
      this._get_collection_path(collection_name),
      serialized_data,
    );
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
    let names = await fs.readdir(this.database_path);
    names = names.map((file) => file.replace(".json", ""));
    return names;
  }
}
