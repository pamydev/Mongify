import fs from "fs-extra";
import path from "path";
import { v4 as uuid } from "uuid";

interface IReadEntireJsonFile {
  collection_name: string;
  create_new?: boolean;
}

export interface MongifyOptions {
  path?: string;
  database_name: string;
}
export interface MongifyDocument {
  [key: string]: any;
}
export interface MongifyQuery {
  [key: string]: any;
}
export interface CollectionOptions {
  limit?: string | number;
  skip?: string | number;
}
export interface UpdateOptions {
  upsert?: boolean;
}
export interface Collection {
  find(
    query?: MongifyQuery,
    options?: CollectionOptions,
  ): Promise<MongifyDocument[]>;
  findOne(query?: MongifyQuery): Promise<MongifyDocument | MongifyDocument[]>;
  update(
    query: MongifyQuery,
    update: MongifyDocument,
    options?: UpdateOptions,
  ): Promise<boolean>;
  insert(document: MongifyDocument): Promise<boolean>;
  insertMany(documentsArray: MongifyDocument[]): Promise<boolean>;
  delete(query: MongifyQuery): Promise<boolean>;
}
class Main {
  private database_path: string;
  public constructor(data: MongifyOptions) {
    const home_dir =
      process.env.APPDATA ||
      (process.platform == "darwin"
        ? process.env.HOME + "/Library"
        : process.env.HOME + "/.local/share");
    const database_path = data?.path || home_dir;
    this.database_path = path.join(
      database_path,
      "/Mongify/",
      data.database_name,
    );
    console.log(`Database path: ${this.database_path}`);
    this.create_database();
  }

  public async createCollection(collection_name: string): Promise<Collection> {
    const names = await this.listCollections();
    if (names.includes(collection_name)) {
      return this.getCollection(collection_name);
    }
    await this._purge_and_write_entire_file(collection_name, []);
    return this.getCollection(collection_name);
  }

  public async deleteCollection(collection_name: string): Promise<boolean> {
    await this._delete_file(this._get_collection_path(collection_name));
    return true;
  }

  public async listCollections(): Promise<string[]> {
    let names = await this._list_files();
    return names;
  }

  public getCollection(collection_name: string): Collection {
    const collection = collection_name;

    return {
      find: async (query?: MongifyQuery, options?: CollectionOptions) =>
        this.find(query, options, collection),

      findOne: async (query?: MongifyQuery) =>
        this.findOne(query, undefined, collection),

      update: async (query, update, options) =>
        this.update(query, update, options, collection),

      insert: async (document) => this.insert(document, collection),

      insertMany: async (documentsArray) =>
        this.insertMany(documentsArray, collection),

      delete: async (query) => this.delete(query, collection),
    };
  }

  public async delete(
    query: MongifyQuery,
    collection_name: string,
  ): Promise<boolean> {
    const { key, value } = this._turn_query_into_search_params(query);
    const file = await this._read_entire_json_file({ collection_name });
    let filtered = this._filter_inverse_array(file, key, value);
    this._purge_and_write_entire_file(collection_name, filtered);
    return true;
  }

  public async insert(
    document: MongifyDocument,
    collection_name: string,
  ): Promise<boolean> {
    let file = await this._read_entire_json_file({
      collection_name,
      create_new: true,
    });
    let new_document = { _id: uuid(), ...document };
    file.push(new_document);
    await this._purge_and_write_entire_file(collection_name, file);
    return true;
  }

  public async insertMany(
    documentsArray: MongifyDocument[],
    collection_name: string,
  ): Promise<boolean> {
    let file = await this._read_entire_json_file({
      collection_name,
      create_new: true,
    });
    for (let c = 0; c < documentsArray.length; c++) {
      let document = documentsArray[c];
      let new_document = { _id: uuid(), ...document };
      file.push(new_document);
    }
    await this._purge_and_write_entire_file(collection_name, file);
    return true;
  }

  public async find(
    query?: MongifyQuery,
    options?: CollectionOptions,
    collection_name?: string,
  ): Promise<MongifyDocument[]> {
    let response = [];
    const file = await this._read_entire_json_file({ collection_name });
    if (!query || Object.keys(query).length === 0) {
      response = file;
    }
    if (query && Object.keys(query).length > 0) {
      const { key, value } = this._turn_query_into_search_params(query);
      response = this._filter_array(file, key, value);
    }
    if (options?.limit) {
      response = response.slice(0, parseInt(String(options.limit)));
    }
    return response;
  }

  public async findOne(
    query?: MongifyQuery,
    options?: CollectionOptions,
    collection_name?: string,
  ): Promise<MongifyDocument | MongifyDocument[]> {
    let response = [];
    const file = await this._read_entire_json_file({ collection_name });
    if (!query || Object.keys(query).length === 0) {
      response = file;
    }
    if (query && Object.keys(query).length > 0) {
      const { key, value } = this._turn_query_into_search_params(query);
      response = this._filter_array(file, key, value);
    }
    return response[0] || response;
  }

  public async update(
    query: MongifyQuery,
    update: MongifyDocument,
    options?: UpdateOptions,
    collection_name?: string,
  ): Promise<boolean> {
    let new_file = [];
    const file = await this._read_entire_json_file({ collection_name });
    const res_query = this._turn_query_into_search_params(query);
    const query_key = res_query.key;
    const query_value = res_query.value;
    let matched = false;
    file.map((obj) => {
      if (obj[query_key] === query_value) {
        matched = true;
        Object.keys(update).map((update_key) => {
          obj[update_key] = update[update_key];
        });
      }
      new_file.push(obj);
    });
    if (matched) {
      this._purge_and_write_entire_file(collection_name!, new_file);
    } else if (options?.upsert) {
      await this.insert({ ...query, ...update }, collection_name!);
    }
    return true;
  }

  private _get_collection_path(collection_name: string): string {
    return path.join(this.database_path, collection_name + ".json");
  }

  private async _purge_and_write_entire_file(
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

  private async _read_entire_json_file(
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

  private _turn_query_into_search_params(query: MongifyQuery): {
    key: string;
    value: any;
  } {
    let key = Object.keys(query)[0];
    let value = query[key];
    return { key, value };
  }

  private _filter_array(
    arr: MongifyDocument[],
    key: string,
    value: any,
  ): MongifyDocument[] {
    return arr.filter((obj) => obj[key] === value);
  }

  private _filter_inverse_array(
    arr: MongifyDocument[],
    key: string,
    value: any,
  ): MongifyDocument[] {
    return arr.filter((obj) => obj[key] !== value);
  }

  private async _delete_file(json_name: string): Promise<boolean> {
    await fs.unlink(json_name);
    return true;
  }

  private async _list_files(): Promise<string[]> {
    let names = await fs.readdir(this.database_path);
    names = names.map((file) => file.replace(".json", ""));
    return names;
  }

  private async create_database(): Promise<string | boolean> {
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
}
export { Main as Mongify };
