import { v7 as uuid } from "uuid";
import { Helpers } from "./helpers";
import type {
  CollectionIndex,
  CollectionOptions,
  IndexOptions,
  MongifyDocument,
  MongifyOptions,
  MongifyQuery,
  UpdateOptions,
} from "./types";

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
      await this.helpers._delete_documents(collection_name, query);
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
          const documents = pending.map((entry) => ({
            ...entry.document,
            _id: uuid(),
          }));
          await this.helpers._append_documents(collection_name, documents);
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
      const documents: MongifyDocument[] = [];

      for (const document of documentsArray) {
        const { _id: ignored_id, ...document_without_id } = document;
        documents.push({ ...document_without_id, _id: uuid() });
      }

      await this.helpers._append_documents(collection_name, documents);
      return true;
    });
  }

  public async find(
    query?: MongifyQuery,
    options?: CollectionOptions,
    collection_name?: string,
  ): Promise<MongifyDocument[]> {
    return this.helpers._with_collection_lock(collection_name!, async () => {
      const limit = options?.limit
        ? parseInt(String(options.limit))
        : undefined;
      return this.helpers._find_documents(
        collection_name!,
        query,
        limit,
      );
    });
  }

  public async findOne(
    query?: MongifyQuery,
    options?: CollectionOptions,
    collection_name?: string,
  ): Promise<MongifyDocument | null> {
    return this.helpers._with_collection_lock(collection_name!, async () => {
      const response = await this.helpers._find_documents(
        collection_name!,
        query,
        1,
        true,
      );
      return response[0] ?? null;
    });
  }

  public async createIndex(
    field: string,
    options: IndexOptions | undefined,
    collection_name: string,
  ): Promise<boolean> {
    return this.helpers._with_collection_lock(collection_name, async () => {
      await this.helpers._create_index(collection_name, field, options);
      return true;
    });
  }

  public async dropIndex(
    field: string,
    collection_name: string,
  ): Promise<boolean> {
    return this.helpers._with_collection_lock(collection_name, async () => {
      await this.helpers._drop_index(collection_name, field);
      return true;
    });
  }

  public async listIndexes(
    collection_name: string,
  ): Promise<CollectionIndex[]> {
    return this.helpers._with_collection_lock(collection_name, async () =>
      this.helpers._list_indexes(collection_name),
    );
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
      await this.helpers._update_documents(
        collection_name!,
        query,
        update,
        options?.upsert === true,
      );
      return true;
    });
  }
}
