export interface IReadEntireJsonFile {
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

type QueryOperators<T> = {
  $lt?: T;
  $lte?: T;
  $gt?: T;
  $gte?: T;
  $in?: T[];
  $nin?: T[];
  $not?: QueryCondition<T>;
  $exists?: boolean;
  $type?: string | string[];
  $regex?: T extends string ? string | RegExp : never;
  $options?: T extends string ? string : never;
};

type QueryCondition<T> =
  | T
  | QueryOperators<T>
  | (NonNullable<T> extends readonly any[]
      ? never
      : NonNullable<T> extends object
        ? MongifyQuery<NonNullable<T>>
        : never);

export type MongifyQuery<T extends object = MongifyDocument> = {
  [K in keyof T]?: QueryCondition<T[K]>;
} & {
  $and?: MongifyQuery<T>[];
  $or?: MongifyQuery<T>[];
  $not?: MongifyQuery<T>;
};

export interface CollectionOptions<T extends object = MongifyDocument> {
  limit?: string | number;
  skip?: string | number;
  projection?: Partial<Record<Extract<keyof T, string>, 0 | 1 | boolean>>;
  sort?: Partial<Record<Extract<keyof T, string>, 1 | -1>>;
}

export interface UpdateOptions {
  upsert?: boolean;
}

export interface IndexOptions {
  unique?: boolean;
}

export type IndexFields<T extends object = MongifyDocument> =
  | Extract<keyof T, string>
  | Array<Extract<keyof T, string>>;

export interface CollectionIndex {
  field: IndexFields;
  unique: boolean;
}

export interface CreateIndexResult {
  acknowledge: boolean;
  indexesBefore: number;
  indexesAfter: number;
  error?: "exists";
}

export type StoredDocument<T extends object> = Omit<T, "_id"> & {
  _id: string;
};

export type InsertDocument<T extends object> = Omit<T, "_id"> & {
  _id?: never;
};

export type UpdateDocument<T extends object> = Partial<Omit<T, "_id">> & {
  _id?: never;
};

export interface Collection<T extends object = MongifyDocument> {
  find(
    query?: MongifyQuery<StoredDocument<T>>,
    options?: CollectionOptions<StoredDocument<T>>,
  ): Promise<StoredDocument<T>[]>;
  findOne(
    query?: MongifyQuery<StoredDocument<T>>,
  ): Promise<StoredDocument<T> | null>;
  update(
    query: MongifyQuery<StoredDocument<T>>,
    update: UpdateDocument<T>,
    options?: UpdateOptions,
  ): Promise<boolean>;
  insert(document: InsertDocument<T>): Promise<boolean>;
  insertMany(documentsArray: InsertDocument<T>[]): Promise<boolean>;
  delete(query: MongifyQuery<StoredDocument<T>>): Promise<boolean>;
  createIndex(
    field: IndexFields<StoredDocument<T>>,
    options?: IndexOptions,
  ): Promise<CreateIndexResult>;
  dropIndex(field: IndexFields<StoredDocument<T>>): Promise<boolean>;
  listIndexes(): Promise<CollectionIndex[]>;
}
