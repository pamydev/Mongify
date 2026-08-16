import fs from "fs-extra";
import path from "path";
import { v4 as uuid } from "uuid";
import { Helpers } from "./helpers";

export class Operations {
  public helpers: Helpers;

  constructor(args0: MongifyOptions) {
    this.helpers = new Helpers(args0);
  }

  public async delete(
    query: MongifyQuery,
    collection_name: string,
  ): Promise<boolean> {
    const { key, value } = this.helpers._turn_query_into_search_params(query);
    const file = await this.helpers._read_entire_json_file({ collection_name });
    let filtered = this.helpers._filter_inverse_array(file, key, value);
    this.helpers._purge_and_write_entire_file(collection_name, filtered);
    return true;
  }

  public async insert(
    document: MongifyDocument,
    collection_name: string,
  ): Promise<boolean> {
    let file = await this.helpers._read_entire_json_file({
      collection_name,
      create_new: true,
    });
    let new_document = { _id: uuid(), ...document };
    file.push(new_document);
    await this.helpers._purge_and_write_entire_file(collection_name, file);
    return true;
  }

  public async insertMany(
    documentsArray: MongifyDocument[],
    collection_name: string,
  ): Promise<boolean> {
    let file = await this.helpers._read_entire_json_file({
      collection_name,
      create_new: true,
    });
    for (let c = 0; c < documentsArray.length; c++) {
      let document = documentsArray[c];
      let new_document = { _id: uuid(), ...document };
      file.push(new_document);
    }
    await this.helpers._purge_and_write_entire_file(collection_name, file);
    return true;
  }

  public async find(
    query?: MongifyQuery,
    options?: CollectionOptions,
    collection_name?: string,
  ): Promise<MongifyDocument[]> {
    let response = [];
    const file = await this.helpers._read_entire_json_file({ collection_name });
    if (!query || Object.keys(query).length === 0) {
      response = file;
    }
    if (query && Object.keys(query).length > 0) {
      const { key, value } = this.helpers._turn_query_into_search_params(query);
      response = this.helpers._filter_array(file, key, value);
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
    const file = await this.helpers._read_entire_json_file({ collection_name });
    if (!query || Object.keys(query).length === 0) {
      response = file;
    }
    if (query && Object.keys(query).length > 0) {
      const { key, value } = this.helpers._turn_query_into_search_params(query);
      response = this.helpers._filter_array(file, key, value);
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
    const file = await this.helpers._read_entire_json_file({ collection_name });
    const res_query = this.helpers._turn_query_into_search_params(query);
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
      await this.helpers._purge_and_write_entire_file(
        collection_name!,
        new_file,
      );
    } else if (options?.upsert) {
      await this.insert({ ...query, ...update }, collection_name!);
    }
    return true;
  }
}
