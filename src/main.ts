import fs from "fs-extra";
import path from "path";
import { v4 as uuid } from "uuid";
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
  private collection: string;
  constructor(data: MongifyOptions) {
    const home_dir =
      process.env.APPDATA ||
      (process.platform == "darwin"
        ? process.env.HOME + "/Library/Preferences"
        : process.env.HOME + "/.local/share");
    const database_path = data?.path || home_dir;
    this.database_path = path.join(
      database_path,
      "/mongify/",
      data.database_name,
    );
    this.collection = "";
    this.create_database();
  }
  async createCollection(collection_name: string): Promise<Collection> {
    this.collection = path.join(this.database_path, collection_name + ".json");
    await this._purge_and_write_entire_file([]);
    return this.getCollection(collection_name);
  }
  async deleteCollection(collection_name: string): Promise<boolean> {
    this.collection = path.join(this.database_path, collection_name + ".json");
    await this._delete_file(this.collection);
    return true;
  }
  async listCollections(): Promise<string[]> {
    let names = await this._list_files();
    return names;
  }
  getCollection(collection_name: string): Collection {
    this.collection = path.join(this.database_path, collection_name + ".json");
    return {
      find: async (query?: MongifyQuery, options?: CollectionOptions) =>
        this.find(query, options),
      findOne: async (query?: MongifyQuery) => this.findOne(query),
      update: async (query, update, options) =>
        this.update(query, update, options),
      insert: async (document) => this.insert(document),
      insertMany: async (documentsArray) => this.insertMany(documentsArray),
      delete: async (query) => this.delete(query),
    };
  }
  async delete(query: MongifyQuery): Promise<boolean> {
    const { key, value } = this._turn_query_into_search_params(query);
    const file = await this._read_entire_json_file();
    let filtered = this._filter_inverse_array(file, key, value);
    this._purge_and_write_entire_file(filtered);
    return true;
  }
  async insert(document: MongifyDocument): Promise<boolean> {
    let file = await this._read_entire_json_file(true);
    let new_document = { _id: uuid(), ...document };
    file.push(new_document);
    await this._purge_and_write_entire_file(file);
    return true;
  }
  async insertMany(documentsArray: MongifyDocument[]): Promise<boolean> {
    let file = await this._read_entire_json_file(true);
    for (let c = 0; c < documentsArray.length; c++) {
      let document = documentsArray[c];
      let new_document = { _id: uuid(), ...document };
      file.push(new_document);
    }
    await this._purge_and_write_entire_file(file);
    return true;
  }
  async find(
    query?: MongifyQuery,
    options?: CollectionOptions,
  ): Promise<MongifyDocument[]> {
    let response = [];
    const file = await this._read_entire_json_file();
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
  async findOne(
    query?: MongifyQuery,
    options?: CollectionOptions,
  ): Promise<MongifyDocument | MongifyDocument[]> {
    let response = [];
    const file = await this._read_entire_json_file();
    if (!query || Object.keys(query).length === 0) {
      response = file;
    }
    if (query && Object.keys(query).length > 0) {
      const { key, value } = this._turn_query_into_search_params(query);
      response = this._filter_array(file, key, value);
    }
    return response[0] || response;
  }
  async update(
    query: MongifyQuery,
    update: MongifyDocument,
    options?: UpdateOptions,
  ): Promise<boolean> {
    let new_file = [];
    const file = await this._read_entire_json_file();
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
      this._purge_and_write_entire_file(new_file);
    } else if (options?.upsert) {
      await this.insert({ ...query, ...update });
    }
    return true;
  }
  async _purge_and_write_entire_file(
    data?: MongifyDocument[],
  ): Promise<boolean> {
    const serialized_data = JSON.stringify(data || []);
    await fs.writeFile(this.collection, serialized_data);
    return true;
  }
  async _read_entire_json_file(create_new = false): Promise<MongifyDocument[]> {
    var json;
    try {
      json = await fs.readFile(this.collection, {
        encoding: "utf8",
      });
    } catch (e) {
      if (create_new) {
        await this._purge_and_write_entire_file();
        json = await fs.readFile(this.collection, {
          encoding: "utf8",
        });
      } else {
        return [];
      }
    }
    let res;
    if (json && json != "") {
      res = JSON.parse(json);
    } else {
      res = [];
    }
    return res;
  }
  _turn_query_into_search_params(query: MongifyQuery): {
    key: string;
    value: any;
  } {
    let key = Object.keys(query)[0];
    let value = query[key];
    return { key, value };
  }
  _filter_array(
    arr: MongifyDocument[],
    key: string,
    value: any,
  ): MongifyDocument[] {
    return arr.filter((obj) => obj[key] === value);
  }
  _filter_inverse_array(
    arr: MongifyDocument[],
    key: string,
    value: any,
  ): MongifyDocument[] {
    return arr.filter((obj) => obj[key] !== value);
  }
  async _delete_file(json_name: string): Promise<boolean> {
    await fs.unlink(json_name);
    return true;
  }
  async _list_files(): Promise<string[]> {
    let names = await fs.readdir(this.database_path);
    names = names.map((file) => file.replace(".json", ""));
    return names;
  }
  async create_database(): Promise<string | boolean> {
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
