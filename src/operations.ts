import { v4 as uuid } from "uuid";
import { Helpers } from "./helpers";

interface PendingInsert {
  document: MongifyDocument;
  resolve: (value: boolean) => void;
  reject: (reason?: unknown) => void;
}

interface InsertBatch {
  pending: PendingInsert[];
}

const insert_batches = new Map<string, InsertBatch>();

export class Operations {
  public helpers: Helpers;

  constructor(args0: MongifyOptions) {
    this.helpers = new Helpers(args0);
  }

  public async delete(
    query: MongifyQuery,
    collection_name: string,
  ): Promise<boolean> {
    return this.helpers._with_collection_lock(collection_name, async () => {
      const { key, value } = this.helpers._turn_query_into_search_params(query);
      const file = await this.helpers._read_entire_json_file({ collection_name });
      const filtered = this.helpers._filter_inverse_array(file, key, value);

      if (filtered.length !== file.length) {
        await this.helpers._purge_and_write_entire_file(
          collection_name,
          filtered,
        );
      }

      return true;
    });
  }

  public insert(
    document: MongifyDocument,
    collection_name: string,
  ): Promise<boolean> {
    const collection_path = this.helpers._get_collection_path(collection_name);
    const { _id: ignored_id, ...document_without_id } = document;

    return new Promise<boolean>((resolve, reject) => {
      const pending_insert = {
        document: document_without_id,
        resolve,
        reject,
      };
      const existing_batch = insert_batches.get(collection_path);

      if (existing_batch) {
        existing_batch.pending.push(pending_insert);
        return;
      }

      const batch = { pending: [pending_insert] };
      insert_batches.set(collection_path, batch);
      this._schedule_insert_batch(collection_name, collection_path, batch);
    });
  }

  private _schedule_insert_batch(
    collection_name: string,
    collection_path: string,
    batch: InsertBatch,
  ): void {
    void this.helpers
      ._with_collection_lock(collection_name, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));

        if (insert_batches.get(collection_path) === batch) {
          insert_batches.delete(collection_path);
        }

        const pending = batch.pending.splice(0);

        try {
          const file = await this.helpers._read_entire_json_file({
            collection_name,
            create_new: true,
          });

          for (const entry of pending) {
            file.push({ ...entry.document, _id: uuid() });
          }

          await this.helpers._purge_and_write_entire_file(collection_name, file);
          pending.forEach(({ resolve }) => resolve(true));
        } catch (error) {
          pending.forEach(({ reject }) => reject(error));
          throw error;
        }
      })
      .catch((error) => {
        if (insert_batches.get(collection_path) === batch) {
          insert_batches.delete(collection_path);
        }
        batch.pending.splice(0).forEach(({ reject }) => reject(error));
      });
  }

  public async insertMany(
    documentsArray: MongifyDocument[],
    collection_name: string,
  ): Promise<boolean> {
    return this.helpers._with_collection_lock(collection_name, async () => {
      const file = await this.helpers._read_entire_json_file({
        collection_name,
        create_new: true,
      });

      for (const document of documentsArray) {
        const { _id: ignored_id, ...document_without_id } = document;
        file.push({ ...document_without_id, _id: uuid() });
      }

      await this.helpers._purge_and_write_entire_file(collection_name, file);
      return true;
    });
  }

  public async find(
    query?: MongifyQuery,
    options?: CollectionOptions,
    collection_name?: string,
  ): Promise<MongifyDocument[]> {
    return this.helpers._with_collection_lock(collection_name!, async () => {
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
    });
  }

  public async findOne(
    query?: MongifyQuery,
    options?: CollectionOptions,
    collection_name?: string,
  ): Promise<MongifyDocument | MongifyDocument[]> {
    return this.helpers._with_collection_lock(collection_name!, async () => {
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
    });
  }

  public async update(
    query: MongifyQuery,
    update: MongifyDocument,
    options?: UpdateOptions,
    collection_name?: string,
  ): Promise<boolean> {
    if (Object.prototype.hasOwnProperty.call(update, "_id")) {
      throw new TypeError("The _id field cannot be updated");
    }

    return this.helpers._with_collection_lock(collection_name!, async () => {
      const file = await this.helpers._read_entire_json_file({ collection_name });
      const { key: query_key, value: query_value } =
        this.helpers._turn_query_into_search_params(query);
      let matched = false;

      for (const document of file) {
        if (document[query_key] === query_value) {
          matched = true;
          Object.assign(document, update);
        }
      }

      if (matched) {
        await this.helpers._purge_and_write_entire_file(collection_name!, file);
      } else if (options?.upsert) {
        const { _id: ignored_id, ...document_without_id } = {
          ...query,
          ...update,
        };
        file.push({ ...document_without_id, _id: uuid() });
        await this.helpers._purge_and_write_entire_file(collection_name!, file);
      }

      return true;
    });
  }
}
